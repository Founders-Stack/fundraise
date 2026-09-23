#!/usr/bin/env bash
# H9 smoke test: the SAME SKILL.md + SAME fstack MCP server in Claude Code AND Codex.
#
#   scripts/agent-smoke/run.sh            # both agents
#   scripts/agent-smoke/run.sh claude     # Claude Code only
#   scripts/agent-smoke/run.sh codex      # Codex only
#
# Env:
#   PORT=3123          dev server port (the script starts `next dev` if nothing listens there)
#   FS_API_TOKEN       defaults to the dev placeholder `dev-local-token` (apps/web/.env.local)
#   SEED=1             insert a temporary demo issuance (SMOKE) and delete it at the end
#
# Touches no global config: Claude uses --plugin-dir, Codex uses per-invocation `-c` overrides.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${PORT:-3123}"
export FS_API_URL="${FS_API_URL:-http://localhost:$PORT/api}"
export FS_API_TOKEN="${FS_API_TOKEN:-dev-local-token}"
SEED="${SEED:-1}"
WHICH="${1:-all}"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/fstack-smoke.XXXXXX")"
MCP_JS="$ROOT/packages/fstack-mcp/dist/index.js"
SERVER_PID=""
FAIL=0

cleanup() {
  if [[ "$SEED" == "1" ]]; then node "$ROOT/scripts/agent-smoke/demo-row.mjs" remove || true; fi
  if [[ -n "$SERVER_PID" ]]; then
    pkill -P "$SERVER_PID" 2>/dev/null || true
    kill "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

command -v jq >/dev/null || { echo "jq is required"; exit 2; }
[[ -f "$MCP_JS" ]] || (cd "$ROOT" && pnpm --filter @fstack/mcp build)

# 1. API up?
if ! curl -s -o /dev/null "http://localhost:$PORT/api/issuances"; then
  echo "== starting web dev server on :$PORT (log: $OUT/web.log)"
  (cd "$ROOT/apps/web" && exec pnpm exec next dev -p "$PORT") >"$OUT/web.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 60); do curl -s -o /dev/null "http://localhost:$PORT/api/issuances" && break; sleep 1; done
fi
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $FS_API_TOKEN" "$FS_API_URL/issuances")
[[ "$code" == "200" ]] || { echo "API not healthy at $FS_API_URL (HTTP $code)"; exit 1; }
[[ "$SEED" == "1" ]] && node "$ROOT/scripts/agent-smoke/demo-row.mjs" add
EXPECT="$([[ "$SEED" == "1" ]] && echo SMOKE || echo "")"

check() { # name, condition-result
  if [[ "$2" == "true" ]]; then echo "  ok   $1"; else echo "  FAIL $1"; FAIL=1; fi
}

# 2. Claude Code: plugin loaded from the repo, skill invoked as /fstack:fundraise.
#    Plugin MCP tools are named mcp__plugin_<plugin>_<server>__<tool>.
if [[ "$WHICH" == "all" || "$WHICH" == "claude" ]]; then
  echo "== Claude Code ($(claude --version))"
  (cd "$ROOT" && claude -p --plugin-dir ./plugins/fstack \
    --allowedTools "mcp__plugin_fstack_fstack__*" \
    --output-format stream-json --verbose "/fstack:fundraise" </dev/null) >"$OUT/claude.jsonl" 2>"$OUT/claude.err" || true
  J="$OUT/claude.jsonl"
  check "skill discovered as fstack:fundraise" \
    "$(jq -s '[.[]|select(.subtype=="init")|.skills[]?]|index("fstack:fundraise")!=null' "$J")"
  check "MCP server plugin:fstack:fstack connected" \
    "$(jq -s '[.[]|select(.subtype=="init")|.mcp_servers[]?|select(.name=="plugin:fstack:fstack" and .status=="connected")]|length>0' "$J")"
  check "tool mcp__plugin_fstack_fstack__fundraise_list_issuances called" \
    "$(jq -s '[.[]|select(.type=="assistant")|.message.content[]?|select(.type=="tool_use" and .name=="mcp__plugin_fstack_fstack__fundraise_list_issuances")]|length>0' "$J")"
  check "no permission denials" "$(jq -s '[.[]|select(.type=="result")|.permission_denials|length==0]|all' "$J")"
  RESULT="$(jq -rs '.[]|select(.type=="result")|.result' "$J")"
  check "output lists issuances${EXPECT:+ (contains $EXPECT)}" "$([[ -n "$RESULT" && "$RESULT" == *"$EXPECT"* ]] && echo true || echo false)"
  echo "---- Claude output"; echo "$RESULT"; echo "----"
fi

# 3. Codex: skill discovered from .agents/skills (symlink), MCP server via -c overrides.
#    read-only sandbox is enough: the tool is annotated readOnlyHint, so exec mode runs it without approval.
if [[ "$WHICH" == "all" || "$WHICH" == "codex" ]]; then
  echo "== Codex ($(codex --version))"
  (cd "$ROOT" && codex exec --skip-git-repo-check --ephemeral --json -s read-only \
    -c 'mcp_servers.fstack.command="node"' \
    -c "mcp_servers.fstack.args=[\"$MCP_JS\"]" \
    -c "mcp_servers.fstack.env={FS_API_URL=\"$FS_API_URL\",FS_API_TOKEN=\"$FS_API_TOKEN\"}" \
    'Use the $fstack-fundraise skill.' </dev/null) >"$OUT/codex.jsonl" 2>"$OUT/codex.err" || true
  J="$OUT/codex.jsonl"
  check "skill SKILL.md loaded from .agents/skills/fstack-fundraise" \
    "$(jq -s '[.[]|select(.item.type=="command_execution")|.item.command|select(test("fstack-fundraise/SKILL.md"))]|length>0' "$J")"
  check "MCP tool fstack.fundraise_list_issuances completed" \
    "$(jq -s '[.[]|select(.type=="item.completed" and .item.type=="mcp_tool_call" and .item.server=="fstack" and .item.tool=="fundraise_list_issuances" and .item.status=="completed")]|length>0' "$J")"
  RESULT="$(jq -rs '[.[]|select(.item.type=="agent_message")|.item.text]|last // ""' "$J")"
  check "output lists issuances${EXPECT:+ (contains $EXPECT)}" "$([[ -n "$RESULT" && "$RESULT" == *"$EXPECT"* ]] && echo true || echo false)"
  echo "---- Codex output"; echo "$RESULT"; echo "----"
fi

echo "raw logs: $OUT"
if [[ "$FAIL" == "0" ]]; then echo "H9 SMOKE: PASS"; else echo "H9 SMOKE: FAIL"; exit 1; fi
