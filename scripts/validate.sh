#!/usr/bin/env bash
# Validate opencode-skill-scoping in a fully isolated scratch environment.
#
# Isolation is done by redirecting HOME (config, data, cache, and every skill
# source — .claude/skills, .config/opencode/skills, .agents/skills — live under
# the redirected home; the real ones are never read or written). The only
# "real" path involved is this plugin's own directory, loaded read-only.
#
# Skill discovery is asynchronous (the registry populates a few seconds after
# server boot), so each phase polls GET /api/skill until it is non-empty.
#
# Phases:
#   1. plugin via explicit config entry + inline options (primary path)
#   2. plugin via auto-discovery + skill-scoping.json rules file (secondary path)
#
# Usage: ./validate.sh [port]      (phase 2 uses port+1; default 4599)
set -uo pipefail

PORT="${1:-4599}"
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BASE="$(mktemp -d "${TMPDIR:-/tmp}/oc-scope-XXXXXX")"
H="$BASE/home"          # redirected HOME
P="$BASE/project"       # server location (a fake project)

# --- fake skills, one per source (plus OpenCode's own built-ins) -----------
mk_skill() { # mk_skill <dir> <id>
  mkdir -p "$1/$2"
  cat > "$1/$2/SKILL.md" <<EOF
---
name: $2
description: $2 test skill
---
Instructions for $2.
EOF
}
mk_skill "$H/.claude/skills"                  "claudeuser-skill"
mk_skill "$H/.claude/skills/synced"           "synced-skill"
mk_skill "$H/.config/opencode/skills"         "userskill"
mk_skill "$H/.agents/skills"                  "agentsskill"
mk_skill "$P/.opencode/skills"                "projskill"
mk_skill "$P/.claude/skills"                  "claudeproj-skill"
# same-ID collision: `review` defined in two sources with distinct bodies; the
# plugin must keep every copy explicitly addressable (project wins the bare
# ID; the shadowed claude-user copy is registered under its source label)
mkdir -p "$H/.claude/skills/review" "$P/.opencode/skills/review"
printf -- '---\nname: review\ndescription: user-level review test skill\n---\nCU-REVIEW-BODY\n' > "$H/.claude/skills/review/SKILL.md"
printf -- '---\nname: review\ndescription: project-level review test skill\n---\nPROJ-REVIEW-BODY\n' > "$P/.opencode/skills/review/SKILL.md"

echo "scratch: $BASE"
echo "opencode: $(opencode --version 2>/dev/null | head -1)"

# --- run one phase: start server (HOME-redirected), poll skills, save -------
# $1 phase label, $2 port
run_phase() {
  (cd "$P" && HOME="$H" opencode serve --hostname 127.0.0.1 --port "$2" --print-logs \
    > "$BASE/server-$1.log" 2>&1 & echo $! > "$BASE/server-$1.pid")
  local srv="$2"
  sleep 6
  local pw
  pw="$(grep -o 'server password .*' "$BASE/server-$1.log" | awk '{print $3}')"
  if [ -z "$pw" ]; then echo "[$1] FAIL: no server password in log"; return 1; fi

  local count=0 i
  for i in $(seq 1 15); do
    (cd "$P" && HOME="$H" OPENCODE_PASSWORD="$pw" opencode api --server "http://127.0.0.1:$2" \
      get /api/skill > "$BASE/skills-$1.json" 2>&1) || true
    count="$(python3 -c "import json;print(len(json.load(open('$BASE/skills-$1.json')).get('data',[])))" 2>/dev/null || echo 0)"
    if [ "${count:-0}" -gt 0 ]; then break; fi
    sleep 3
  done
  kill "$(cat "$BASE/server-$1.pid")" 2>/dev/null
  echo "[$1] GET /api/skill → $count skills (after ~$((i * 3 + 6))s)"
  [ "${count:-0}" -gt 0 ]
}

# --- phase 1: explicit config entry + inline options -------------------------
mkdir -p "$H/.config/opencode"
cat > "$H/.config/opencode/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "autoupdate": false,
  "plugins": [
    {
      "package": "$PLUGIN_DIR",
      "options": {
        "namespaces": { "l3": ["projskill", "claudeproj-skill"] },
        "scopes": { "default": ["userskill", "projskill", "claudeuser-skill"] }
      }
    }
  ]
}
EOF
run_phase phase1 "$PORT" || true
python3 - "$BASE/skills-phase1.json" <<'PYEOF'
import json, sys
skills = json.load(open(sys.argv[1])).get("data", [])
by_id = {s["id"]: s for s in skills}
def has(i): return i in by_id
def auto(i):
    s = by_id.get(i)
    return None if s is None else s.get("autoinvoke")
checks = [
    ("user:userskill alias", has("user:userskill")),
    ("claude-user:claudeuser-skill alias", has("claude-user:claudeuser-skill")),
    ("claude-sync:synced-skill alias", has("claude-sync:synced-skill")),
    ("agents-user:agentsskill alias", has("agents-user:agentsskill")),
    ("project:projskill alias", has("project:projskill")),
    ("claude-project:claudeproj-skill alias", has("claude-project:claudeproj-skill")),
    ("l3:projskill alias (custom namespace)", has("l3:projskill")),
    ("l3:claudeproj-skill alias (custom namespace)", has("l3:claudeproj-skill")),
    ("aliases autoinvoke:false (user:userskill)", auto("user:userskill") is False),
    ("in-scope advertised (userskill)", auto("userskill") is not False),
    ("in-scope advertised (projskill)", auto("projskill") is not False),
    ("in-scope advertised (claudeuser-skill)", auto("claudeuser-skill") is not False),
    ("out-of-scope BUILTIN hidden (report)", auto("report") is False),
    ("collision: bare review = project winner", by_id.get("review", {}).get("path", "").endswith("/.opencode/skills/review/SKILL.md")),
    ("collision: bare review body is the project one", "PROJ-REVIEW-BODY" in (by_id.get("review", {}).get("content") or "")),
    ("collision: project:review = winner alias", has("project:review")),
    ("collision: shadowed claude-user:review registered", has("claude-user:review")),
    ("collision: shadowed claude-user:review has its own body", "CU-REVIEW-BODY" in (by_id.get("claude-user:review", {}).get("content") or "")),
    ("collision: shadowed claude-user:review hidden", auto("claude-user:review") is False),
]
fails = 0
for label, ok in checks:
    print(("  PASS  " if ok else "  FAIL  ") + label)
    fails += 0 if ok else 1
print("  NOTE  out-of-scope discovered skills stay advertised on v2.0.26 (upstream limitation): "
      f"agentsskill={auto('agentsskill')} synced-skill={auto('synced-skill')} — use native permissions globs for those")
if fails:
    print("  ids seen:", sorted(by_id)[:30])
sys.exit(1 if fails else 0)
PYEOF
PHASE1_RC=$?

# --- phase 2: auto-discovery + rules file -------------------------------------
rm -f "$H/.config/opencode/opencode.json"
mkdir -p "$H/.config/opencode/plugins"
ln -s "$PLUGIN_DIR" "$H/.config/opencode/plugins/skill-scoping"
# stage test rules into the plugin dir (real rules restored afterwards)
cp "$PLUGIN_DIR/skill-scoping.json" "$BASE/skill-scoping.orig.json" 2>/dev/null || true
cat > "$PLUGIN_DIR/skill-scoping.json" <<'EOF'
{
  "namespaces": { "docs": ["userskill"] },
  "scopes": { "default": ["projskill", "claudeproj-skill"] }
}
EOF
run_phase phase2 "$((PORT + 1))" || true
python3 - "$BASE/skills-phase2.json" <<'PYEOF'
import json, sys
skills = json.load(open(sys.argv[1])).get("data", [])
by_id = {s["id"]: s for s in skills}
def has(i): return i in by_id
def auto(i):
    s = by_id.get(i)
    return None if s is None else s.get("autoinvoke")
checks = [
    ("auto-discovered plugin loaded (docs:userskill alias)", has("docs:userskill")),
    ("rules-file namespaces (docs:userskill autoinvoke:false)", auto("docs:userskill") is False),
    ("source labels still work (user:userskill alias)", has("user:userskill")),
    ("rules-file scopes: out-of-scope BUILTIN hidden (report)", auto("report") is False),
    ("in-scope discovered advertised (projskill)", auto("projskill") is not False),
]
fails = 0
for label, ok in checks:
    print(("  PASS  " if ok else "  FAIL  ") + label)
    fails += 0 if ok else 1
print("  NOTE  out-of-scope discovered userskill stays advertised on v2.0.26 (upstream limitation)")
if fails:
    print("  ids seen:", sorted(by_id)[:30])
sys.exit(1 if fails else 0)
PYEOF
PHASE2_RC=$?

# --- restore the real rules file -----------------------------------------------
cp "$BASE/skill-scoping.orig.json" "$PLUGIN_DIR/skill-scoping.json" 2>/dev/null || true
rm -f "$H/.config/opencode/plugins/skill-scoping"

echo
echo "RESULT: phase1(explicit+options)=$([ $PHASE1_RC -eq 0 ] && echo PASS || echo FAIL)  phase2(auto-discovery+rules-file)=$([ $PHASE2_RC -eq 0 ] && echo PASS || echo FAIL)"
echo "artifacts: $BASE (kept for inspection)"
