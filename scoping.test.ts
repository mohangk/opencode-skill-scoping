/**
 * Unit tests for scoping.ts (pure logic). Run: npm test (node --test).
 *
 * The integration harness in scripts/validate.sh covers the OpenCode-specific
 * wiring (transform registration, async discovery, reloads) against a real
 * server; these tests pin the decision logic deterministically, including the
 * failure modes discovered during the live rollout:
 * - symlinked source dirs (dotfiles) vs OpenCode's resolved registry paths
 * - false cross-label shadows when two labeled dirs resolve to the same place
 * - Claude marketplace plugin caches (~/.claude/plugins) as an undiscovered source
 */
import { after, describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  DEFAULT_SEPARATOR,
  buildSourceRules,
  detectSource,
  globToRegExp,
  isAllowed,
  matchesAny,
  mergeRules,
  normalizePath,
  planSkillEdits,
  readSkillFile,
  realPath,
  scanShadowed,
  scopeKeyFor,
  type SkillInfoLike,
  type SkillScopingRules,
} from "./scoping.ts"

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

interface Fixture {
  root: string
  home: string
  project: string
  /** symlinked ".claude/skills" target, mimicking a dotfiles repo */
  dotfilesSkills: string
  cleanup: () => void
}

/** A fake machine: root/home with ~/.claude/skills symlinked into a dotfiles
 *  repo (the real-world layout this plugin failed on first), plus a project.
 *  The root is realpath-resolved at creation so fixture paths compare equal
 *  with resolved paths (macOS tmpdirs live under /var → /private/var). */
function makeFixture(): Fixture {
  const root = realPath(mkdtempSync(join(tmpdir(), "skill-scoping-test-")))
  const home = join(root, "home")
  const project = join(root, "project")
  const dotfilesSkills = join(root, "dotfiles", "claude", "skills")
  mkdirSync(join(home, ".claude"), { recursive: true })
  mkdirSync(join(home, ".agents", "skills"), { recursive: true })
  mkdirSync(join(project, ".opencode", "skills"), { recursive: true })
  mkdirSync(join(project, ".claude", "skills"), { recursive: true })
  mkdirSync(dotfilesSkills, { recursive: true })
  symlinkSync(dotfilesSkills, join(home, ".claude", "skills"))
  return {
    root,
    home,
    project,
    dotfilesSkills,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

function writeSkill(dir: string, id: string, body = `${id} body`, name = id): string {
  const skillDir = join(dir, id)
  mkdirSync(skillDir, { recursive: true })
  const path = join(skillDir, "SKILL.md")
  writeFileSync(
    path,
    `---\nname: ${name}\ndescription: ${id} test skill\n---\n${body}\n`,
  )
  return path
}

const skill = (id: string, path: string, content = `${id} body`): SkillInfoLike => ({
  id,
  name: id,
  description: `${id} test skill`,
  path,
  content,
})

// ---------------------------------------------------------------------------
// glob matching
// ---------------------------------------------------------------------------

describe("glob matching", () => {
  it("matches exact ids", () => {
    assert.ok(matchesAny(["pdf", "docx"], "pdf"))
    assert.ok(!matchesAny(["pdf", "docx"], "pdfs"))
  })

  it("matches * wildcards", () => {
    assert.ok(matchesAny(["l3-*"], "l3-breakdown"))
    assert.ok(matchesAny(["sprint-*-*"], "sprint-daily-report"))
    assert.ok(!matchesAny(["l3-*"], "sprint-new"))
  })

  it("escapes regex special characters in patterns", () => {
    assert.ok(matchesAny(["a.b+c"], "a.b+c"))
    assert.ok(!matchesAny(["a.b+c"], "axbxc"))
    assert.ok(globToRegExp("a.b").test("a.b"))
    assert.ok(!globToRegExp("a.b").test("aXb"))
  })

  it("treats undefined patterns as no match", () => {
    assert.ok(!matchesAny(undefined, "pdf"))
  })
})

// ---------------------------------------------------------------------------
// path canonicalization
// ---------------------------------------------------------------------------

describe("normalizePath", () => {
  it("strips the macOS /private prefix", () => {
    assert.equal(normalizePath("/private/var/tmp/x"), "/var/tmp/x")
    assert.equal(normalizePath("/Users/me/x"), "/Users/me/x")
  })

  it("makes /private and non-private paths comparable", () => {
    assert.equal(normalizePath("/private/var/a/SKILL.md"), normalizePath("/var/a/SKILL.md"))
  })
})

describe("realPath", () => {
  it("resolves symlinks to their targets", () => {
    const f = makeFixture()
    try {
      assert.equal(realPath(join(f.home, ".claude", "skills")), f.dotfilesSkills)
    } finally {
      f.cleanup()
    }
  })

  it("returns missing paths unchanged", () => {
    assert.equal(realPath("/definitely/not/here"), "/definitely/not/here")
  })
})

// ---------------------------------------------------------------------------
// source labeling
// ---------------------------------------------------------------------------

describe("buildSourceRules", () => {
  it("produces the default labels in precedence order", () => {
    const f = makeFixture()
    try {
      const rules = buildSourceRules(undefined, f.home)
      assert.deepEqual(
        rules.map(([label]) => label),
        ["claude-sync", "claude-plugins", "claude-user", "agents-user", "user"],
      )
      // prefixes are symlink-resolved (registry paths are resolved)
      assert.deepEqual(rules[2][1], [f.dotfilesSkills])
    } finally {
      f.cleanup()
    }
  })

  it("replaces defaults entirely when sources are configured", () => {
    const rules = buildSourceRules({ team: ["/opt/team-skills"] })
    assert.deepEqual(rules, [["team", [realPath("/opt/team-skills")]]])
  })
})

describe("detectSource", () => {
  const f = makeFixture()
  const rules = buildSourceRules(undefined, f.home)
  after(f.cleanup)

  it("labels claude-user on the symlink-resolved dotfiles path (the live bug)", () => {
    // OpenCode's registry would store the resolved dotfiles path, not ~/.claude/...
    const path = join(f.dotfilesSkills, "personal-ka-writer", "SKILL.md")
    assert.equal(detectSource(path, rules), "claude-user")
  })

  it("labels claude-sync for the synced bucket before claude-user", () => {
    const path = join(f.dotfilesSkills, "synced", "uuid-1", "pdf", "SKILL.md")
    assert.equal(detectSource(path, rules), "claude-sync")
  })

  it("labels claude-plugins for marketplace caches", () => {
    const path = join(f.home, ".claude", "plugins", "cache", "mp", "plugin", "1.0", "skills", "foo", "SKILL.md")
    assert.equal(detectSource(path, rules), "claude-plugins")
  })

  it("labels agents-user and user sources", () => {
    assert.equal(detectSource(join(f.home, ".agents", "skills", "find-skills", "SKILL.md"), rules), "agents-user")
    assert.equal(detectSource(join(f.home, ".config", "opencode", "skills", "pdf", "SKILL.md"), rules), "user")
  })

  it("labels project-relative segments when no home prefix matches", () => {
    assert.equal(detectSource(join(f.project, ".opencode", "skills", "git-release", "SKILL.md"), rules), "project")
    assert.equal(detectSource(join(f.project, ".claude", "skills", "l3-breakdown", "SKILL.md"), rules), "claude-project")
    assert.equal(detectSource(join(f.project, ".agents", "skills", "x", "SKILL.md"), rules), "agents-project")
  })

  it("returns undefined for built-ins and unknown paths", () => {
    assert.equal(detectSource("/builtin/opencode.md", rules), undefined)
    assert.equal(detectSource("/somewhere/else/SKILL.md", rules), undefined)
  })

  it("matches through macOS /private resolution", () => {
    // the unresolved twin of the (already resolved) fixture path
    const path = `${f.dotfilesSkills.replace(/^\/private/, "")}/pdf/SKILL.md`
    assert.equal(detectSource(path, rules), "claude-user")
  })
})

// ---------------------------------------------------------------------------
// scoping
// ---------------------------------------------------------------------------

describe("scopeKeyFor", () => {
  const scopes: Record<string, string[]> = {
    "/work/release-manager": ["l3-*"],
    "/work": ["docs"],
    default: ["pdf"],
  }

  it("prefers the longest matching prefix", () => {
    assert.equal(scopeKeyFor("/work/release-manager", scopes), "/work/release-manager")
    assert.equal(scopeKeyFor("/work/other-project", scopes), "/work")
    assert.equal(scopeKeyFor("/work/release-manager/.worktrees/x", scopes), "/work/release-manager")
  })

  it("falls back to default, then undefined", () => {
    assert.equal(scopeKeyFor("/elsewhere/project", scopes), "default")
    assert.equal(scopeKeyFor("/elsewhere/project", { "/x": [] }), undefined)
  })
})

describe("isAllowed", () => {
  it("advertises only matching ids, and an empty list advertises nothing", () => {
    const allow = ["l3-*", "pdf"]
    assert.ok(isAllowed("l3-breakdown", allow))
    assert.ok(isAllowed("pdf", allow))
    assert.ok(!isAllowed("morning", allow))
    assert.ok(!isAllowed("pdf", [])) // documented: empty = nothing advertised
    assert.ok(!isAllowed("pdf", undefined))
  })
})

// ---------------------------------------------------------------------------
// rules merging
// ---------------------------------------------------------------------------

describe("mergeRules", () => {
  it("merges file rules with option rules, options winning per key", () => {
    const merged = mergeRules(
      { separator: "-", scopes: { default: ["pdf"] }, namespaces: { docs: ["pdf"] } },
      { separator: ":", scopes: { default: ["docx"] } },
    )
    assert.equal(merged.separator, ":") // option wins
    assert.deepEqual(merged.scopes?.default, ["docx"]) // whole key replaced
    assert.deepEqual(merged.namespaces?.docs, ["pdf"]) // file-only key kept
  })
})

// ---------------------------------------------------------------------------
// SKILL.md parsing
// ---------------------------------------------------------------------------

describe("readSkillFile", () => {
  it("extracts frontmatter and the body without frontmatter", () => {
    const f = makeFixture()
    try {
      const path = writeSkill(f.dotfilesSkills, "review", "REVIEW-BODY", "code-review")
      const info = readSkillFile(path)
      assert.equal(info?.name, "code-review")
      assert.equal(info?.description, "review test skill")
      assert.equal(info?.content, "REVIEW-BODY\n") // registry shape: body only
    } finally {
      f.cleanup()
    }
  })

  it("falls back to the parent directory name and raw body without frontmatter", () => {
    const f = makeFixture()
    try {
      const dir = join(f.project, ".opencode", "skills", "plain")
      mkdirSync(dir, { recursive: true })
      const path = join(dir, "SKILL.md")
      writeFileSync(path, "just a body\n")
      const info = readSkillFile(path)
      assert.equal(info?.name, "plain")
      assert.equal(info?.content, "just a body\n")
    } finally {
      f.cleanup()
    }
  })

  it("returns undefined for missing files", () => {
    assert.equal(readSkillFile("/no/such/SKILL.md"), undefined)
  })
})

// ---------------------------------------------------------------------------
// shadowed-skill scanning
// ---------------------------------------------------------------------------

describe("scanShadowed", () => {
  it("skips registry winners and registers losers under their source label", () => {
    const f = makeFixture()
    try {
      const winner = writeSkill(join(f.project, ".opencode", "skills"), "review", "PROJ-BODY")
      const loser = writeSkill(f.dotfilesSkills, "review", "CU-BODY")
      const registry = [{ id: "review", path: winner }]
      const shadowed = scanShadowed(DEFAULT_SEPARATOR, f.project, registry, f.home)
      const ids = shadowed.map((s) => `${s.label}:${s.id}`)
      assert.ok(ids.includes("claude-user:review"), `expected claude-user:review in ${ids}`)
      const entry = shadowed.find((s) => s.id === "review")
      assert.equal(entry?.content, "CU-BODY\n")
      assert.equal(entry?.path, loser) // resolved canonical path
    } finally {
      f.cleanup()
    }
  })

  it("does not create false shadows when two labeled dirs resolve to the same place (the live bug)", () => {
    const f = makeFixture()
    try {
      // home as its own "project root": <home>/.claude/skills resolves to the
      // dotfiles dir — the same directory as the claude-user source
      const winner = writeSkill(f.dotfilesSkills, "pdf", "PDF-BODY")
      const registry = [{ id: "pdf", path: winner }]
      const shadowed = scanShadowed(DEFAULT_SEPARATOR, f.home, registry, f.home)
      assert.equal(shadowed.length, 0) // winner via either label: no shadow at all
    } finally {
      f.cleanup()
    }
  })

  it("surfaces undiscovered marketplace plugin skills under claude-plugins", () => {
    const f = makeFixture()
    try {
      const marketSkill = writeSkill(
        join(f.home, ".claude", "plugins", "cache", "acme-mp", "data-agent", "1.0.4", "skills"),
        "sql-query-generating",
      )
      const shadowed = scanShadowed(DEFAULT_SEPARATOR, f.project, [], f.home) // nothing in registry
      const entry = shadowed.find((s) => s.id === "sql-query-generating")
      assert.equal(entry?.label, "claude-plugins")
      assert.equal(entry?.path, marketSkill)
    } finally {
      f.cleanup()
    }
  })

  it("registers only the first version when several cache versions define the same id", () => {
    const f = makeFixture()
    try {
      const cache = join(f.home, ".claude", "plugins", "cache", "mp", "plugin")
      writeSkill(join(cache, "1.0.0", "skills"), "tool", "v1")
      writeSkill(join(cache, "2.0.0", "skills"), "tool", "v2")
      const shadowed = scanShadowed(DEFAULT_SEPARATOR, undefined, [], f.home)
      const entries = shadowed.filter((s) => s.id === "tool")
      assert.equal(entries.length, 1)
      assert.equal(entries[0]?.content, "v1\n") // sorted order: 1.0.0 first
    } finally {
      f.cleanup()
    }
  })

  it("handles both skill-file forms: nested SKILL.md and root-level markdown", () => {
    const f = makeFixture()
    try {
      writeSkill(f.dotfilesSkills, "nested", "NESTED")
      const userDir = join(f.home, ".config", "opencode", "skills")
      mkdirSync(userDir, { recursive: true })
      writeFileSync(join(userDir, "flat.md"), "---\nname: flat\n---\nFLAT\n")
      const shadowed = scanShadowed(DEFAULT_SEPARATOR, undefined, [], f.home)
      assert.ok(shadowed.some((s) => s.id === "nested" && s.label === "claude-user"))
      assert.ok(shadowed.some((s) => s.id === "flat" && s.label === "user"))
    } finally {
      f.cleanup()
    }
  })

  it("skips colon-named ids, dot files, and synced under the claude-user pass", () => {
    const f = makeFixture()
    try {
      const dir = f.dotfilesSkills
      writeSkill(dir, "batch-dim:discover", "COLON") // colon names are ambiguous
      mkdirSync(join(dir, ".hidden", "x"), { recursive: true }) // dot dir
      writeFileSync(join(dir, ".hidden", "x", "SKILL.md"), "---\n---\nH\n")
      // synced entry that is NOT a registry winner must surface as claude-sync, not claude-user
      writeSkill(join(dir, "synced", "uuid-1"), "later-skill", "SYNCED")
      const shadowed = scanShadowed(DEFAULT_SEPARATOR, undefined, [], f.home)
      assert.ok(!shadowed.some((s) => s.id.includes(":")), "colon ids must be skipped")
      assert.ok(!shadowed.some((s) => s.id === "x"), "dot dirs must be skipped")
      const synced = shadowed.find((s) => s.id === "later-skill")
      assert.equal(synced?.label, "claude-sync")
    } finally {
      f.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// transform planning
// ---------------------------------------------------------------------------

describe("planSkillEdits", () => {
  const f = makeFixture()
  const sourceRules = buildSourceRules(undefined, f.home)
  after(f.cleanup)

  const editorSkills: SkillInfoLike[] = [
    skill("opencode", "/builtin/opencode.md"),
    skill("report", "/builtin/report.md"),
  ]

  it("plans source-label and custom-namespace aliases for editor and discovered skills", () => {
    const discovered = [
      skill("l3-breakdown", join(f.project, ".claude", "skills", "l3-breakdown", "SKILL.md")),
      skill("pdf", join(f.dotfilesSkills, "synced", "uuid-1", "pdf", "SKILL.md")),
    ]
    const rules: SkillScopingRules = { namespaces: { release: ["l3-*"] } }
    const plan = planSkillEdits({
      editorSkills,
      discovered,
      shadowed: [],
      rules,
      directory: f.project,
      sourceRules,
    })
    const aliasIds = plan.aliases.map((a) => a.id)
    assert.ok(aliasIds.includes("claude-project:l3-breakdown")) // source label
    assert.ok(aliasIds.includes("release:l3-breakdown")) // custom namespace
    assert.ok(aliasIds.includes("claude-sync:pdf"))
    assert.ok(!aliasIds.includes("opencode:opencode")) // built-ins: no source label
    assert.ok(!aliasIds.some((id) => id.startsWith("project:l3"))) // dotfiles-style path is not a project path
  })

  it("plans hides only for out-of-scope skills and flags editor vs discovered", () => {
    const discovered = [
      skill("l3-breakdown", join(f.project, ".claude", "skills", "l3-breakdown", "SKILL.md")),
    ]
    const rules: SkillScopingRules = { scopes: { default: ["l3-*"] } }
    const plan = planSkillEdits({
      editorSkills,
      discovered,
      shadowed: [],
      rules,
      directory: f.project,
      sourceRules,
    })
    // built-ins are out of scope and editable in-editor; l3-* is in scope
    const hiddenIds = plan.hides.map((h) => h.id)
    assert.deepEqual(hiddenIds.sort(), ["opencode", "report"])
    assert.ok(plan.hides.every((h) => h.inEditor))
    // now scope to only pdf: the discovered l3 skill becomes a hide candidate
    const plan2 = planSkillEdits({
      editorSkills: [],
      discovered,
      shadowed: [],
      rules: { scopes: { default: ["pdf"] } },
      directory: f.project,
      sourceRules,
    })
    assert.deepEqual(plan2.hides.map((h) => h.id), ["l3-breakdown"])
    assert.equal(plan2.hides[0]?.inEditor, false) // discovered → override path
  })

  it("hides originals only for custom namespaces when hideOriginals is set", () => {
    const discovered = [
      skill("l3-breakdown", join(f.project, ".claude", "skills", "l3-breakdown", "SKILL.md")),
    ]
    const base = {
      editorSkills: [] as SkillInfoLike[],
      discovered,
      shadowed: [],
      directory: f.project,
      sourceRules,
    }
    const off = planSkillEdits({ ...base, rules: { namespaces: { release: ["l3-*"] } } })
    assert.equal(off.hides.length, 0) // hideOriginals defaults to false
    const on = planSkillEdits({
      ...base,
      rules: { namespaces: { release: ["l3-*"] }, hideOriginals: true },
    })
    assert.deepEqual(on.hides.map((h) => h.id), ["l3-breakdown"])
  })

  it("never re-namespaces aliases and drops discovered entries already in the editor", () => {
    const plan = planSkillEdits({
      editorSkills,
      discovered: [
        skill("release:l3-breakdown", "/anywhere/SKILL.md"), // an alias id
        skill("opencode", "/builtin/opencode.md"), // duplicate of an editor entry
        skill("real", join(f.project, ".opencode", "skills", "real", "SKILL.md")),
      ],
      shadowed: [],
      rules: { namespaces: { release: ["*"] } },
      directory: undefined,
      sourceRules,
    })
    const aliasIds = plan.aliases.map((a) => a.id)
    assert.ok(!aliasIds.includes("release:release:l3-breakdown"), "aliases must not be re-namespaced")
    assert.ok(aliasIds.includes("project:real"))
    // the duplicate discovered "opencode" adds nothing: exactly one opencode
    // alias (the custom namespace on the editor entry), no source labels
    assert.equal(aliasIds.filter((id) => id.split(":").pop() === "opencode").length, 1)
  })

  it("produces no hides without scopes, and hides everything for an empty allow-list", () => {
    const discovered = [
      skill("real", join(f.project, ".opencode", "skills", "real", "SKILL.md")),
    ]
    const noScopes = planSkillEdits({
      editorSkills,
      discovered,
      shadowed: [],
      rules: {},
      directory: f.project,
      sourceRules,
    })
    assert.equal(noScopes.hides.length, 0)
    const denyAll = planSkillEdits({
      editorSkills,
      discovered,
      shadowed: [],
      rules: { scopes: { default: [] } },
      directory: f.project,
      sourceRules,
    })
    assert.equal(denyAll.hides.length, 3) // both built-ins + the discovered skill
  })

  it("passes shadowed entries through for registration", () => {
    const plan = planSkillEdits({
      editorSkills,
      discovered: [],
      shadowed: [
        {
          label: "claude-user",
          id: "review",
          name: "review",
          path: "/x/review/SKILL.md",
          content: "body",
        },
      ],
      rules: {},
      directory: undefined,
      sourceRules,
    })
    assert.equal(plan.shadowed.length, 1)
    assert.equal(plan.shadowed[0]?.label, "claude-user")
  })

  it("advertises only custom-namespace aliases with advertiseAliases: custom", () => {
    const discovered = [
      skill("l3-breakdown", join(f.project, ".claude", "skills", "l3-breakdown", "SKILL.md")),
      skill("pdf", join(f.dotfilesSkills, "synced", "uuid-1", "pdf", "SKILL.md")),
    ]
    const base = {
      editorSkills: [] as SkillInfoLike[],
      discovered,
      shadowed: [],
      directory: f.project,
      sourceRules,
    }
    const rules: SkillScopingRules = { namespaces: { release: ["l3-*"] } }

    const none = planSkillEdits({ ...base, rules })
    assert.ok(none.aliases.every((a) => a.advertised === false), "default: all explicit-only")

    const custom = planSkillEdits({ ...base, rules: { ...rules, advertiseAliases: "custom" } })
    const byId = Object.fromEntries(custom.aliases.map((a) => [a.id, a.advertised]))
    assert.equal(byId["release:l3-breakdown"], true) // custom namespace → advertised
    assert.equal(byId["claude-project:l3-breakdown"], false) // source label → hidden
    assert.equal(byId["claude-sync:pdf"], false)

    const all = planSkillEdits({ ...base, rules: { ...rules, advertiseAliases: "all" } })
    assert.ok(all.aliases.every((a) => a.advertised === true))
  })
})
