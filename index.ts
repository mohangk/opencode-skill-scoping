import { Plugin } from "@opencode/plugin"
import { appendFileSync, readFileSync, watch, type FSWatcher } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  DEFAULT_SEPARATOR,
  buildSourceRules,
  mergeRules,
  planSkillEdits,
  realPath,
  scanShadowed,
  type SkillInfoLike,
  type SkillScopingRules,
  type ShadowedSkill,
} from "./scoping.ts"

/**
 * opencode-skill-scoping — two independent modes over the native skill registry:
 *
 * 1. Scoping — per-project allow-lists of skill ID globs. Out-of-scope skills
 *    get `autoinvoke: false`: they disappear from the model's advertised
 *    skill list but stay loadable explicitly by ID (`@skill-id`). Nothing is
 *    lost, only de-advertised. (Hard deny remains available natively via
 *    `permissions` with `action: "skill"`.)
 *
 * 2. Namespacing — every skill gets hidden aliases prefixed by its source
 *    label (`user:pdf`, `project:git-release`, `claude-user:deep-research`,
 *    `claude-sync:morning`, …) and by any custom namespace configured to
 *    match it (`release:*`, `docs:*`). Aliases are always `autoinvoke: false`,
 *    so the advertised list is never duplicated; they exist so prompts can be
 *    explicit about *which* skill they mean — `@user:pdf` forces the
 *    user-level pdf even when a project-level pdf shadows its bare ID.
 *    Shadowed same-ID copies (losers of OpenCode's precedence resolution, and
 *    sources OpenCode does not discover natively — e.g. Claude marketplace
 *    plugin caches) are registered under their source label too.
 *
 * All decision logic lives in `scoping.ts` (pure, unit-tested in
 * `scoping.test.ts`); this file only wires it into the plugin lifecycle.
 *
 * The label vocabulary follows joshuadavidthomas/opencode-agent-skills
 * (V1-era, maintenance mode — its namespace labels live only inside its own
 * tools); this plugin brings the same idea to OpenCode v2's native skill
 * registry, so it works with the built-in `skill` tool and `@` mentions.
 *
 * OpenCode v2.0.26 quirks this plugin works around (see README):
 * - `ctx.skill.transform`'s editor only enumerates built-ins; discovered
 *   skills are captured via `ctx.skill.list()` and re-registered here.
 * - Skill discovery is asynchronous and does not replay plugin transforms;
 *   the plugin polls, captures, reloads, and watches the source dirs.
 * - OpenCode stores skill paths symlink-resolved; all path comparisons use
 *   resolved canonical paths.
 */

const pluginDir = (() => {
  try {
    return dirname(fileURLToPath(import.meta.url))
  } catch {
    return undefined
  }
})()

/** Rules may live in a `skill-scoping.json` beside this file (works with
 *  auto-discovered plugins, which receive no options) and/or in plugin
 *  options from the explicit `plugins` config entry. Options win per key. */
function loadRules(options: unknown): SkillScopingRules {
  const optionRules = (options ?? {}) as SkillScopingRules
  let fileRules: SkillScopingRules | undefined
  if (pluginDir) {
    try {
      fileRules = JSON.parse(readFileSync(join(pluginDir, "skill-scoping.json"), "utf8"))
    } catch {
      // no rules file — fine
    }
  }
  return mergeRules(fileRules, optionRules)
}

export default Plugin.define({
  id: "skill-scoping",
  async setup(ctx) {
    let rules = loadRules(ctx.options)
    const separator = rules.separator ?? DEFAULT_SEPARATOR
    const debug = rules.debug === true || process.env.SKILL_SCOPING_DEBUG === "1"
    const log = (...args: unknown[]) => {
      if (!debug) return
      try {
        appendFileSync(
          join(homedir(), ".skill-scoping-debug.log"),
          `${new Date().toISOString()} ${args.map(String).join(" ")}\n`,
        )
      } catch {
        // diagnostics must never break the plugin
      }
    }
    log(
      `loaded — scopes: ${Object.keys(rules.scopes ?? {}).length}, namespaces: ${Object.keys(rules.namespaces ?? {}).length}, separator: ${JSON.stringify(separator)}`,
    )

    let sourceRules = buildSourceRules(rules.sources)

    const location = ctx.location as {
      directory: string
      project?: { canonical?: string; directory?: string }
    }
    const directory = location.project?.canonical ?? location.project?.directory ?? location.directory
    const projectRoot = location.project?.canonical ?? undefined
    log(`location: ${directory} → projectRoot: ${projectRoot}`)

    // Skills discovered from the filesystem (the transform editor only sees
    // built-ins on v2.0.26) and shadowed same-ID copies from the source scan.
    let captured: SkillInfoLike[] = []
    let shadowed: ShadowedSkill[] = []

    try {
      await ctx.skill.transform((editor) => {
        const plan = planSkillEdits({
          editorSkills: editor.list() as SkillInfoLike[],
          discovered: captured,
          shadowed,
          rules,
          directory,
          sourceRules,
        })
        log(
          `transform replay: editor=${plan.aliases.length > 0 ? "" : ""}${(editor.list() as SkillInfoLike[]).length} discovered=${captured.length} → ${plan.aliases.length} aliases, ${plan.hides.length} hides, ${plan.shadowed.length} shadowed`,
        )

        for (const alias of plan.aliases) {
          try {
            editor.add({
              id: alias.id,
              name: alias.skill.name,
              description: alias.skill.description
                ? `[${alias.id.split(separator)[0]}] ${alias.skill.description}`
                : alias.skill.description,
              // advertised aliases show up in the model list + autocomplete;
              // the rest are explicit-only, loadable by exact ID
              autoinvoke: alias.advertised ? true : false,
              path: alias.skill.path,
              content: alias.skill.content,
            })
          } catch (error) {
            log(`alias add failed for "${alias.id}": ${String(error)}`)
          }
        }
        for (const hide of plan.hides) {
          if (hide.inEditor) {
            editor.update(hide.id, (draft) => {
              ;(draft as SkillInfoLike).autoinvoke = false
            })
          } else {
            // Discovered entries are outside the editor base on v2.0.26:
            // update/remove by ID and same-ID adds are silent no-ops for
            // them, so scoping cannot hide discovered skills on this build.
            // Keep the update attempt anyway — if a future OpenCode feeds
            // discovered skills into the transform base, scoping starts
            // working unchanged (such skills then take the inEditor path).
            log(`cannot hide discovered skill "${hide.id}" on this OpenCode build (see README: scoping limitation)`)
            try {
              editor.update(hide.id, (draft) => {
                ;(draft as SkillInfoLike).autoinvoke = false
              })
            } catch {
              // no-op on builds where update cannot reach discovered entries
            }
          }
        }
        for (const entry of plan.shadowed) {
          try {
            editor.add({
              id: `${entry.label}${separator}${entry.id}`,
              name: entry.name,
              description: entry.description
                ? `[${entry.label}] ${entry.description}`
                : entry.description,
              autoinvoke: false,
              path: entry.path,
              content: entry.content,
            })
          } catch (error) {
            log(`shadowed add failed for "${entry.label}${separator}${entry.id}": ${String(error)}`)
          }
        }
      })
      log("transform registered")
    } catch (error) {
      log(`transform registration failed: ${String(error)}`)
    }

    // ---- keep the plugin applied over OpenCode's async skill discovery -----
    // Skill discovery populates a few seconds after location boot and does not
    // replay plugin transforms on its own. Poll until discovered skills
    // appear, capture them (plus the shadow scan), and reload (which replays
    // the transform over the captured set). The source-directory watchers
    // re-run this whenever skills change on disk.
    const isBuiltin = (skill: { path?: string }) => String(skill.path ?? "").startsWith("/builtin")
    const listSkills = async (): Promise<SkillInfoLike[]> => {
      const out = await ctx.skill.list()
      const arr = Array.isArray(out) ? out : ((out as { data?: unknown[] })?.data ?? [])
      return arr as SkillInfoLike[]
    }
    const resync = async (deadline: number) => {
      try {
        const skills = await listSkills()
        const discovered = skills.filter(
          (skill) => !isBuiltin(skill) && !skill.id.includes(separator),
        )
        if (discovered.length > 0) {
          captured = discovered
          shadowed =
            rules.registerShadowed === false
              ? []
              : scanShadowed(separator, projectRoot, skills, homedir())
          log(
            `resync: captured ${discovered.length} discovered skills` +
              (shadowed.length > 0
                ? `; shadowed/surfaced: ${shadowed.map((s) => `${s.label}:${s.id}`).join(", ")}`
                : ""),
          )
          await ctx.skill.reload()
          log("resync reload done")
          return
        }
        if (Date.now() < deadline) setTimeout(() => void resync(deadline), 2000)
      } catch (error) {
        log(`resync error: ${String(error)}`)
        if (Date.now() < deadline) setTimeout(() => void resync(deadline), 2000)
      }
    }
    void resync(Date.now() + 60_000)

    // ---- watchers: rules file + skill source directories ---------------------
    let rulesDebounce: ReturnType<typeof setTimeout> | undefined
    let skillDebounce: ReturnType<typeof setTimeout> | undefined
    const watchers: FSWatcher[] = []

    if (pluginDir) {
      try {
        watchers.push(
          watch(pluginDir, (_event, filename) => {
            if (filename && basename(String(filename)) !== "skill-scoping.json") return
            if (rulesDebounce) clearTimeout(rulesDebounce)
            rulesDebounce = setTimeout(() => {
              rules = loadRules(ctx.options)
              sourceRules = buildSourceRules(rules.sources)
              void ctx.skill.reload().catch(() => {})
            }, 400)
          }),
        )
      } catch {
        // watching unavailable — rules changes need a restart
      }
    }

    const home = homedir()
    const configHome = process.env.XDG_CONFIG_HOME || join(home, ".config")
    const sourceDirs = new Set<string>(
      [
        join(home, ".claude", "skills"),
        join(home, ".agents", "skills"),
        join(configHome, "opencode", "skills"),
        join(home, ".claude", "plugins"),
        ...(projectRoot
          ? [
              join(projectRoot, ".opencode", "skills"),
              join(projectRoot, ".claude", "skills"),
              join(projectRoot, ".agents", "skills"),
            ]
          : []),
      ].map(realPath),
    )
    for (const skillDir of sourceDirs) {
      try {
        watchers.push(
          watch(skillDir, { recursive: true }, (_event, filename) => {
            if (filename && String(filename).split("/").pop()?.startsWith(".")) return
            if (skillDebounce) clearTimeout(skillDebounce)
            skillDebounce = setTimeout(() => void resync(Date.now() + 30_000), 500)
          }),
        )
      } catch {
        // source dir does not exist yet — nothing to watch
      }
    }

    return () => {
      if (rulesDebounce) clearTimeout(rulesDebounce)
      if (skillDebounce) clearTimeout(skillDebounce)
      for (const w of watchers) w.close()
    }
  },
})
