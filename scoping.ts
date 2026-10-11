/**
 * Pure logic for opencode-skill-scoping — no OpenCode imports, no side effects
 * beyond filesystem reads, everything injectable for tests. `index.ts` wires
 * these into the plugin lifecycle; `scoping.test.ts` unit-tests them.
 */
import { readFileSync, readdirSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"

export interface SkillScopingRules {
  /** Project directory (or an ancestor) → allow-list of skill ID globs.
   *  Longest matching key wins; "default" applies when none matches.
   *  A matching skill keeps its own autoinvoke (frontmatter respected); a
   *  non-matching skill gets autoinvoke: false. An empty array advertises
   *  nothing. No matching key and no "default" → no scoping. */
  scopes?: Record<string, string[]>
  /** Custom namespace label → skill ID globs. Matching skills get a hidden
   *  "<label><sep><id>" alias. */
  namespaces?: Record<string, string[]>
  /** Override source-label detection: label → absolute path prefixes
   *  (checked before the built-in project-segment rules). */
  sources?: Record<string, string[]>
  /** Namespace separator. Default ":". */
  separator?: string
  /** Hide originals that matched a *custom* namespace (the namespaced alias
   *  becomes the canonical form). Source-label aliases never hide originals. */
  hideOriginals?: boolean
  /** Which aliases appear in the advertised list (and therefore the TUI's
   *  autocomplete): "none" (default — all aliases are explicit-only, loadable
   *  by exact ID), "custom" (custom-namespace aliases like `release:*` are
   *  advertised; source labels stay hidden), "all" (every alias, including
   *  source labels — beware flooding the list). */
  advertiseAliases?: "none" | "custom" | "all"
  /** Register shadowed same-ID skills (a lower-precedence source's copy of an
   *  ID that another source won) under their source-label aliases, so e.g.
   *  `claude-user:review` stays loadable when a project `review` shadows it.
   *  Default: true. Entries are hidden (explicit-only), like all aliases. */
  registerShadowed?: boolean
  /** Enable the debug trace at $HOME/.skill-scoping-debug.log. */
  debug?: boolean
}

export interface SkillInfoLike {
  id: string
  name: string
  description?: string
  autoinvoke?: boolean
  path: string
  content: string
}

export interface ShadowedSkill {
  label: string
  id: string
  name: string
  description?: string
  path: string
  content: string
}

export const DEFAULT_SEPARATOR = ":"

// ---------------------------------------------------------------------------
// glob matching
// ---------------------------------------------------------------------------

export const globToRegExp = (pattern: string): RegExp =>
  new RegExp(
    "^" +
      pattern
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      "$",
  )

export const matchesAny = (patterns: string[] | undefined, id: string): boolean =>
  patterns?.some((pattern) => globToRegExp(pattern).test(id)) ?? false

// ---------------------------------------------------------------------------
// path canonicalization
// ---------------------------------------------------------------------------

/** macOS resolves /var → /private/var (and similar); normalize so prefixes and
 *  skill paths can be given in either form. */
export const normalizePath = (path: string): string =>
  path.startsWith("/private/") ? path.slice(8) : path

/** Resolve symlinks to the real path (best effort). OpenCode stores skill
 *  paths resolved to their real targets — e.g. with ~/.claude/skills
 *  symlinked into a dotfiles repo, the registry holds the dotfiles path — so
 *  every prefix and path comparison must use resolved paths. Paths whose
 *  final segments do not exist (e.g. a `synced/` dir not yet created) are
 *  resolved through their deepest existing ancestor. */
export const realPath = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    const parent = dirname(path)
    if (parent === path) return path // filesystem root
    return join(realPath(parent), basename(path))
  }
}

// ---------------------------------------------------------------------------
// source labeling
// ---------------------------------------------------------------------------

/** Built-in source labels, in matching order (claude-sync and claude-plugins
 *  before claude-user, because their directories nest inside ~/.claude).
 *  Prefixes are symlink-resolved so they match OpenCode's registry paths. */
export function buildSourceRules(
  sources?: Record<string, string[]>,
  home: string = homedir(),
  configHome: string = process.env.XDG_CONFIG_HOME || join(home, ".config"),
): Array<readonly [string, string[]]> {
  const custom = Object.entries(sources ?? {}).map(
    ([label, prefixes]) => [label, prefixes.map(realPath)] as const,
  )
  if (custom.length > 0) return custom
  return [
    ["claude-sync", [realPath(join(home, ".claude", "skills", "synced"))]],
    ["claude-plugins", [realPath(join(home, ".claude", "plugins"))]],
    ["claude-user", [realPath(join(home, ".claude", "skills"))]],
    ["agents-user", [realPath(join(home, ".agents", "skills"))]],
    ["user", [realPath(join(configHome, "opencode", "skills"))]],
  ]
}

/** Source label for a skill, from its path: configured prefixes first, then
 *  project-relative segments, else undefined (built-ins and unknowns). */
export function detectSource(
  path: string,
  sourceRules: Array<readonly [string, string[]]>,
): string | undefined {
  const normalized = normalizePath(path)
  for (const [label, prefixes] of sourceRules) {
    if (
      prefixes.some(
        (prefix) =>
          normalized.startsWith(normalizePath(prefix) + "/") || normalized === normalizePath(prefix),
      )
    )
      return label
  }
  if (normalized.includes("/.opencode/skills/")) return "project"
  if (normalized.includes("/.claude/skills/")) return "claude-project"
  if (normalized.includes("/.agents/skills/")) return "agents-project"
  return undefined
}

// ---------------------------------------------------------------------------
// scoping
// ---------------------------------------------------------------------------

/** Longest-prefix scope key for a location directory ("default" as fallback). */
export function scopeKeyFor(directory: string, scopes: Record<string, string[]>): string | undefined {
  const keys = Object.keys(scopes)
    .filter((key) => key !== "default")
    .filter((key) => directory === key || directory.startsWith(key + "/"))
    .sort((a, b) => b.length - a.length)
  return keys[0] ?? ("default" in scopes ? "default" : undefined)
}

/** True when the skill is advertised under the active allow-list. An empty
 *  allow-list advertises nothing. */
export function isAllowed(id: string, allow: string[] | undefined): boolean {
  return allow !== undefined && allow.length > 0 && matchesAny(allow, id)
}

// ---------------------------------------------------------------------------
// rules loading
// ---------------------------------------------------------------------------

/** Merge rules from a `skill-scoping.json` file and plugin options; options
 *  win per key. Returns undefined when neither source provides rules. */
export function mergeRules(
  fileRules: Partial<SkillScopingRules> | undefined,
  optionRules: Partial<SkillScopingRules> | undefined,
): SkillScopingRules {
  return { ...(fileRules ?? {}), ...(optionRules ?? {}) } as SkillScopingRules
}

// ---------------------------------------------------------------------------
// shadowed-skill scanning (same-ID losers + undiscovered sources)
// ---------------------------------------------------------------------------

/** Labeled skill source directories, in source-rule order (first match wins a
 *  shadowed label). Dirs are symlink-resolved so scans and registry paths
 *  compare on canonical paths. */
export function labeledSourceDirs(
  projectRoot: string | undefined,
  home: string,
  configHome: string = process.env.XDG_CONFIG_HOME || join(home, ".config"),
): Array<readonly [string, string]> {
  return [
    ["claude-sync", realPath(join(home, ".claude", "skills", "synced"))],
    ["claude-plugins", realPath(join(home, ".claude", "plugins"))],
    ["claude-user", realPath(join(home, ".claude", "skills"))],
    ["agents-user", realPath(join(home, ".agents", "skills"))],
    ["user", realPath(join(configHome, "opencode", "skills"))],
    ...(projectRoot
      ? [
          ["project", realPath(join(projectRoot, ".opencode", "skills"))],
          ["claude-project", realPath(join(projectRoot, ".claude", "skills"))],
          ["agents-project", realPath(join(projectRoot, ".agents", "skills"))],
        ]
      : []),
  ]
}

/** Minimal SKILL.md read: frontmatter name/description + body. Registry
 *  entries carry the body without frontmatter, so match that shape. */
export function readSkillFile(
  path: string,
): { name: string; description?: string; content: string } | undefined {
  try {
    const raw = readFileSync(path, "utf8")
    let name: string | undefined
    let description: string | undefined
    let body = raw
    if (raw.startsWith("---\n")) {
      const end = raw.indexOf("\n---", 4)
      if (end !== -1) {
        const frontmatter = raw.slice(4, end)
        body = raw.slice(raw.indexOf("\n", end + 1) + 1)
        for (const line of frontmatter.split("\n")) {
          const match = /^([A-Za-z_-]+):\s*(.*)$/.exec(line)
          if (!match) continue
          if (match[1] === "name") name = match[2].trim()
          if (match[1] === "description") description = match[2].trim()
        }
      }
    }
    return { name: name ?? basename(dirname(path)), description, content: body }
  } catch {
    return undefined
  }
}

/** Scan the labeled source directories for same-ID skills that lost OpenCode's
 *  precedence resolution to a different path — OpenCode keeps only the winner,
 *  so losers are invisible to the registry and to the transform editor. Also
 *  surfaces skills from sources OpenCode does not discover natively (e.g.
 *  Claude marketplace plugin caches under ~/.claude/plugins). Each entry is
 *  registered later under `<label>:<id>` (a new ID, so `editor.add` surfaces
 *  it), making every copy of a same-named skill explicitly loadable.
 *
 *  All path comparisons use symlink-resolved canonical paths, and one resolved
 *  path is handled at most once across labels (kills false shadows when e.g.
 *  a home and a project source dir resolve to the same directory). */
export function scanShadowed(
  separator: string,
  projectRoot: string | undefined,
  registry: Array<{ id: string; path?: string }>,
  home: string,
  configHome?: string,
): ShadowedSkill[] {
  const found: ShadowedSkill[] = []
  const seen = new Set<string>()
  const seenResolved = new Set<string>()
  const registryById = new Map(registry.map((skill) => [skill.id, skill.path]))
  for (const [label, dir] of labeledSourceDirs(projectRoot, home, configHome)) {
    let entries: string[] = []
    try {
      entries = (readdirSync(dir, { recursive: true }) as unknown as string[]).map(String)
    } catch {
      continue // source dir does not exist
    }
    for (const rel of entries.sort()) {
      const segments = rel.split("/")
      const base = segments[segments.length - 1]
      if (base.startsWith(".")) continue
      if (segments.some((segment) => segment.startsWith("."))) continue
      if (label === "claude-user" && segments[0] === "synced") continue
      // OpenCode's two skill-file forms: <name>/SKILL.md (any depth) or root <name>.md
      let id: string | undefined
      if (base === "SKILL.md") {
        if (segments.length < 2) continue
        id = segments[segments.length - 2]
      } else if (base.endsWith(".md") && segments.length === 1) {
        id = base.slice(0, -3)
      }
      if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) continue
      const full = join(dir, rel) // dir is already symlink-resolved
      if (seenResolved.has(full)) continue // same file under another label
      const winnerPath = registryById.get(id)
      if (winnerPath && normalizePath(winnerPath) === normalizePath(full)) {
        seenResolved.add(full)
        continue // registry winner — labeled by the transform, not here
      }
      const aliasId = `${label}${separator}${id}`
      if (seen.has(aliasId)) continue
      const info = readSkillFile(full)
      if (!info) continue
      seen.add(aliasId)
      seenResolved.add(full)
      found.push({
        label,
        id,
        name: info.name,
        description: info.description,
        path: full,
        content: info.content,
      })
    }
  }
  return found
}

// ---------------------------------------------------------------------------
// transform planning (pure decision layer used by the plugin's transform)
// ---------------------------------------------------------------------------

export interface SkillEditPlan {
  /** Aliases to register. `advertised` aliases keep autoinvoke true (they
   *  appear in the model's list and the TUI autocomplete); the rest are
   *  explicit-only (autoinvoke false). */
  aliases: Array<{ id: string; skill: SkillInfoLike; advertised: boolean }>
  /** Skills to hide (autoinvoke: false). `inEditor` marks entries the editor
   *  can mutate directly; others need an override registration. */
  hides: Array<{ id: string; inEditor: boolean; skill: SkillInfoLike }>
  /** Shadowed same-ID copies to register (pass-through of the scan result). */
  shadowed: ShadowedSkill[]
}

/** Decide every edit the transform should apply, from the editor's base list
 *  (built-ins on v2.0.26), the captured discovered skills, the shadow scan,
 *  the rules, and the active location. Pure: same inputs → same plan. */
export function planSkillEdits(input: {
  editorSkills: SkillInfoLike[]
  /** discovered skills captured from ctx.skill.list() */
  discovered: SkillInfoLike[]
  shadowed: ShadowedSkill[]
  rules: SkillScopingRules
  directory: string | undefined
  sourceRules: Array<readonly [string, string[]]>
}): SkillEditPlan {
  const separator = input.rules.separator ?? DEFAULT_SEPARATOR
  const editorIds = new Set(input.editorSkills.map((skill) => skill.id))
  const discovered = input.discovered.filter(
    (skill) => !skill.id.includes(separator) && !editorIds.has(skill.id),
  )
  const scopeKey = input.directory
    ? scopeKeyFor(input.directory, input.rules.scopes ?? {})
    : undefined
  const allow = scopeKey ? input.rules.scopes?.[scopeKey] : undefined

  const aliases: SkillEditPlan["aliases"] = []
  const hides: SkillEditPlan["hides"] = []
  const advertise = input.rules.advertiseAliases ?? "none"

  for (const skill of [...input.editorSkills, ...discovered]) {
    if (skill.id.includes(separator)) continue // never re-namespace aliases

    // ---- namespacing: source label + custom namespaces ----
    const sourceLabels: string[] = []
    const customLabels: string[] = []
    const source = detectSource(skill.path, input.sourceRules)
    if (source) sourceLabels.push(source)
    let customMatched = false
    for (const [label, patterns] of Object.entries(input.rules.namespaces ?? {})) {
      if (label.includes(separator)) continue
      if (matchesAny(patterns, skill.id)) {
        customLabels.push(label)
        customMatched = true
      }
    }
    for (const label of [...new Set([...sourceLabels, ...customLabels])]) {
      const advertised =
        advertise === "all" || (advertise === "custom" && customLabels.includes(label))
      aliases.push({ id: `${label}${separator}${skill.id}`, skill, advertised })
    }

    // ---- scoping (+ hideOriginals, which applies even without scopes) ----
    const scoped = scopeKey !== undefined && allow !== undefined
    const allowed = scoped ? isAllowed(skill.id, allow as string[]) : true
    if (allowed && !(customMatched && input.rules.hideOriginals === true)) continue
    hides.push({ id: skill.id, inEditor: editorIds.has(skill.id), skill })
  }

  return { aliases, hides, shadowed: input.shadowed }
}
