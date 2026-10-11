# opencode-skill-scoping

An [OpenCode v2](https://opencode.ai/v2/docs/) plugin that adds **skill namespacing** and **skill scoping** to OpenCode's native skill registry — the two capabilities OpenCode lacks (skills are otherwise one flat global list of path-derived IDs, last source wins, advertised everywhere).

## Capability matrix (opencode v2.0.26 — verified by `scripts/validate.sh`)

| Mode | Built-in skills | Discovered skills (`.claude/skills`, `.opencode/skills`, explicit `skills` sources) |
|---|---|---|
| **Namespacing** — source-label + custom-namespace aliases, hidden, explicitly loadable | ✅ full | ✅ **full** |
| **Scoping** — hide out-of-scope skills from the model's advertised list (`autoinvoke: false`) | ✅ full | ⚠️ **not on v2.0.26** (upstream limitation, below) |

**Namespacing works completely**: every skill — built-in or discovered — gets
hidden aliases like `user:pdf`, `project:git-release`, `claude-user:deep-research`,
`claude-sync:morning`, `l3:…`, so prompts and instructions can be explicit about
*which* skill they mean (`@user:pdf` forces the user-level pdf even when a
project-level pdf shadows its bare ID). Aliases never appear in the advertised
list; they exist for explicit invocation only.

**Scoping works for built-ins via the plugin; for discovered skills pair it
with the native `permissions` globs** (hard deny, per-project or per-agent) —
see "Scoping for discovered skills" below.

## Source labels (Mode 2 — namespacing)

Aliases are computed from each skill's path (labels are configurable via `sources`):

| Alias | Source |
|---|---|
| `project:git-release` | `<project>/.opencode/skills/…` |
| `claude-project:deploy` | `<project>/.claude/skills/…` |
| `agents-project:…` | `<project>/.agents/skills/…` |
| `user:pdf` | `$XDG_CONFIG_HOME/opencode/skills/…` |
| `claude-user:deep-research` | `~/.claude/skills/…` |
| `claude-sync:morning` | `~/.claude/skills/synced/…` |
| `claude-plugins:agent-browser` | `~/.claude/plugins/…` |
| `agents-user:find-skills` | `~/.agents/skills/…` |

plus any **custom namespaces** (`"l3": ["l3-*", "sprint-*"]` →
`l3:l3-daily-custodians-update`, `l3:sprint-daily-report`, …). Built-ins get
only custom-namespace aliases (no source label — they have no path on disk).

The label vocabulary follows
[joshuadavidthomas/opencode-agent-skills](https://github.com/joshuadavidthomas/opencode-agent-skills)
(V1-era, maintenance mode): its namespace system lives only inside that
plugin's own `use_skill`/`get_available_skills` tools and predates OpenCode's
native skills support — this plugin brings the same idea to OpenCode v2's
native registry, so it works with the built-in `skill` tool and `@` mentions.

Note: OpenCode resolves same-ID skills before the plugin sees them (later
source wins), so a source label always describes the *winning* copy.

## Same-ID skills (collisions) — e.g. two skills named `review`

Without the plugin, OpenCode keeps **only the highest-precedence copy**: with
`review` in both `~/.claude/skills/review/` and `<project>/.opencode/skills/review/`,
the project copy wins the bare ID and the user-level copy is **invisible — there
is no syntax to reach it** (verified on v2.0.26).

The plugin makes every copy addressable:

| ID | What it is |
|---|---|
| `review` | The precedence winner (default behavior, unchanged) |
| `project:review` | The winner, explicitly by source |
| `claude-user:review` | **The shadowed user-level copy, resurrected** — its own body, its own path (supporting files resolve to its directory), hidden from the advertised list, loadable by explicit mention |

This is the "shadowed-skill resurrection" pass: the plugin scans the labeled
source directories for same-ID skills that lost precedence resolution to a
different path and registers each under its source label (a new ID, which is
why it works on v2.0.26 — see findings below). Disable with
`"registerShadowed": false`. If multiple losers share one label, the first in
source-rule order wins that label.

This mirrors Claude Code's collision semantics ("plugin skills are namespaced
as `/plugin-name:skill-name` — on a clash, both load") on OpenCode's native
registry.

## Scoping for discovered skills — native `permissions` (hard deny)

```jsonc
// project opencode.json — hide non-release skills inside this repo
"permissions": [
  { "action": "skill", "resource": "*", "effect": "allow" },
  { "action": "skill", "resource": "morning", "effect": "deny" },
  { "action": "skill", "resource": "xlsx", "effect": "deny" }
]
```

Pair the two: the plugin gives namespaced explicit access everywhere; the
native permissions give per-project hard visibility control for discovered
skills; the plugin's `autoinvoke` scoping covers built-ins and any future
OpenCode build that fixes the limitation below.

## OpenCode v2.0.26 findings (why scoping is limited)

Determined empirically (see `scripts/validate.sh` and the debug trace):

1. **`ctx.skill.transform`'s editor only enumerates built-in skills.**
   `editor.list()` shows only built-ins; every file-discovered skill (compat
   sources, project sources, even explicit `skills` config entries) never
   appears — though `ctx.skill.list()` and `GET /api/skill` show them all.
2. **Same-ID `editor.add`, `editor.update`, and `editor.remove` are silent
   no-ops for discovered skills** — the discovered entry always wins the
   registry read.
3. **`editor.add` with a *new* ID works** and surfaces in reads — that is why
   namespacing (aliases) works fully.
4. **Skill discovery is asynchronous** (~5–15s after boot) and its registry
   refresh does not replay plugin transforms. The plugin polls
   `ctx.skill.list()` until discovery settles, captures the discovered set,
   and re-registers it through the transform; source-directory watchers
   re-run the cycle when skills change on disk. (Also: OpenCode hot-reloads
   a plugin when its own file changes.)
5. **OpenCode stores skill paths symlink-resolved.** With `~/.claude/skills`
   symlinked into a dotfiles repo, registry paths point into the repo, not at
   `~/.claude/...` — so source labeling and every path comparison must use
   resolved canonical paths. (Learned the hard way: the first live run
   mislabeled every dotfiles skill and registered duplicate cross-label
   shadows; now pinned by unit tests in `scoping.test.ts`.)

Together, 1+2 mean an `autoinvoke`-based scoping transform cannot hide
discovered skills on 2.0.26. If OpenCode later feeds discovered skills into
the transform base, the plugin's scoping starts covering them with no code
change (the code already routes such skills through `editor.update`).

## Install

### Option A — explicit config entry (options inline)

```jsonc
// opencode.json(c)
{
  "plugins": [
    {
      "package": "~/Workspace/opencode-skill-scoping",
      "options": {
        "scopes": { "default": ["pdf", "docs", "deep-research"] },
        "namespaces": { "l3": ["l3-*", "sprint-*"] }
      }
    }
  ]
}
```

### Option B — auto-discovered (rules file beside the plugin)

```bash
git clone https://github.com/mohangk/opencode-skill-scoping ~/Workspace/opencode-skill-scoping
cp ~/Workspace/opencode-skill-scoping/skill-scoping.example.json ~/Workspace/opencode-skill-scoping/skill-scoping.json
ln -s ~/Workspace/opencode-skill-scoping ~/.config/opencode/plugins/skill-scoping
# rules live in ~/Workspace/opencode-skill-scoping/skill-scoping.json (gitignored)
```

Auto-discovered plugins receive no `ctx.options`, so with Option B all rules
come from `skill-scoping.json` (start from
[`skill-scoping.example.json`](skill-scoping.example.json)). With Option A,
options override the file **per key**. The plugin watches
`skill-scoping.json` and reloads its transforms on change; option changes
follow normal config reload semantics.

## Rules reference

```jsonc
{
  "separator": ":",            // namespace separator
  "hideOriginals": false,     // true: skills matched by a CUSTOM namespace lose
                              // their advertised entry (alias becomes canonical)
  "advertiseAliases": "custom", // "none" (default): all aliases explicit-only;
                              // "custom": custom-namespace aliases appear in the
                              // advertised list + TUI autocomplete; "all": every
                              // alias (beware flooding — includes claude-plugins:*)
  "namespaces": {             // custom label → skill ID globs
    "l3": ["l3-*", "sprint-*"]
  },
  "scopes": {                 // project dir (or ancestor; longest match wins) → allow globs
    "/Users/me/Work/release-manager": ["l3-*", "pdf"],
    "default": ["pdf", "docs", "deep-research"]   // fallback when no project matches
  },
  "sources": {                // optional: override source-label detection
    "team": ["/opt/team-skills"]   // label → absolute path prefixes
  }
}
```

- **Globs** support `*` (e.g. `l3-*`, `sprint-daily-*`) and exact IDs.
- **Scoping semantics**: a skill matching the active list **keeps its own
  `autoinvoke`** (frontmatter `opencode/autoinvoke: false` is respected); a
  non-matching skill gets `autoinvoke: false`. An empty array (`[]`)
  advertises nothing. No matching scope key and no `default` → no scoping.
- Skills with no `description` are never advertised by OpenCode itself;
  scoping does not change that.

### Autocomplete

By default aliases are `autoinvoke: false` — they never appear in the model's
advertised list **or the TUI's `@` autocomplete**; they are loadable by their
exact ID (`@user:pdf`, `@claude-plugins:sql-query-generating`). Typing a
partial alias will not complete. To make curated namespaces discoverable,
set `"advertiseAliases": "custom"` — custom-namespace aliases (e.g.
`release:*`, `docs:*`) then appear in autocomplete, while the bulkier source
labels stay explicit-only. Advertised-alias changes apply to **new sessions**;
a running session keeps its snapshot of the list.

## Verification

Two layers:

```bash
npm test                   # unit tests — node --test, no server needed (36 tests)
npm run test:integration   # scripts/validate.sh — isolated sandbox against a real
                           # opencode server, both install paths, 24 checks
```

The unit tests (`scoping.test.ts`) pin the pure decision logic in `scoping.ts`
(glob matching, path canonicalization, source labeling, scoping, rules
merging, SKILL.md parsing, shadow scanning, transform planning) — including
the failure modes discovered during the live rollout: symlink-resolved source
dirs vs registry paths, false cross-label shadows when two labeled dirs
resolve to the same place, and Claude marketplace caches as an undiscovered
source. `index.ts` is thin wiring (lifecycle, watchers, resync) covered by the
integration harness.

## Limitations

- Affects **OpenCode only** — Claude Code reads `~/.claude/skills`
  independently (its own location hierarchy and `plugin:skill` namespacing
  apply there).
- Takes effect for **new sessions**; a running session keeps its advertised list.
- Colon IDs (`user:pdf`) are not officially documented for OpenCode skills —
  they register and list correctly on v2.0.26 (verified by `validate.sh`); if a
  future release rejects them, set `"separator": "-"`.
