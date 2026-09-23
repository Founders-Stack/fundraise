# Installing the `fstack` skills + MCP server in Claude Code and Codex

One `SKILL.md` set (`plugins/fstack/skills/*`) and one MCP server (`packages/fstack-mcp`) serve both
agents unchanged (SPEC H9). Verified on 2026-09-23 with Claude Code 2.1.278 and codex-cli 0.155.1;
reproduce with `scripts/agent-smoke/run.sh`.

## Prerequisites

```bash
pnpm install
pnpm build                                  # builds packages/fstack-mcp/dist/index.js
cd apps/web && pnpm dev                     # API on http://localhost:3000/api
```

| Env | Default | Notes |
|---|---|---|
| `FS_API_URL` | `http://localhost:3000/api` | Base URL of the Founder Stack API (include `/api`) |
| `FS_API_TOKEN` | none | Bearer token. Must equal the API's `FS_API_TOKEN` (local dev: `dev-local-token`) |

## Claude Code

### Now: load the plugin from the repo

```bash
export FS_API_URL=http://localhost:3000/api FS_API_TOKEN=dev-local-token
claude --plugin-dir ./plugins/fstack          # run from the repo root
> /fstack:fundraise
```

Non-interactive (what the smoke test runs):

```bash
claude -p --plugin-dir ./plugins/fstack \
  --allowedTools "mcp__plugin_fstack_fstack__*" \
  "/fstack:fundraise"
```

- Skills are namespaced by plugin: `skills/fundraise/` is `/fstack:fundraise`, `skills/fundraise-launch/`
  becomes `/fstack:fundraise-launch`, and so on.
- The plugin's `.mcp.json` registers the server as `plugin:fstack:fstack`, so **tool names are
  `mcp__plugin_fstack_fstack__<tool>`**. An allowlist of `mcp__fstack__*` does **not** match. We tested
  it: the call was denied in `-p` mode.
- `FS_API_URL` / `FS_API_TOKEN` are read from the shell env via `${FS_API_URL:-...}` / `${FS_API_TOKEN}`
  in `.mcp.json`.

### Later: marketplace install

`claude plugin marketplace add <repo>` then `claude plugin install fstack@<marketplace>`. Before that ships,
`.mcp.json` must stop pointing at `${CLAUDE_PLUGIN_ROOT}/../../packages/fstack-mcp/dist/index.js`, because
installed plugins are copied into the plugin cache and the path would escape it. Instead, publish
`@fstack/mcp` and use `"command": "npx", "args": ["-y", "@fstack/mcp"]`, or bundle `dist/` inside the plugin.

## Codex

Codex discovers skills from `.agents/skills/` in the working directory. `.agents/skills/fstack-fundraise`
is a **symlink** to `plugins/fstack/skills/fundraise`, and Codex follows it. `$fstack-fundraise` resolves to
`.agents/skills/fstack-fundraise/SKILL.md`, and the model reads that file when the skill applies. Both explicit (`$fstack-fundraise`) and implicit ("what's the status of my Cash Flow Rights
fundraise?") prompts triggered it.

### Permanent setup (the user adds this to `~/.codex/config.toml`)

```toml
[mcp_servers.fstack]
command = "node"
args = ["/absolute/path/to/FS-Stocklana/packages/fstack-mcp/dist/index.js"]
env = { FS_API_URL = "http://localhost:3000/api", FS_API_TOKEN = "dev-local-token" }
```

Then run `codex` from the repo root and type `$fstack-fundraise` (or just ask about the fundraise).

### One-liner without touching any config

```bash
codex exec --skip-git-repo-check -s read-only \
  -c 'mcp_servers.fstack.command="node"' \
  -c "mcp_servers.fstack.args=[\"$PWD/packages/fstack-mcp/dist/index.js\"]" \
  -c 'mcp_servers.fstack.env={FS_API_URL="http://localhost:3000/api",FS_API_TOKEN="dev-local-token"}' \
  'Use the $fstack-fundraise skill.' </dev/null
```

- `--skip-git-repo-check` is needed only while the repo is not a git repo.
- Use `</dev/null` in scripts. Otherwise `codex exec` waits for stdin ("Reading additional input from stdin...").
- **Approvals:** `fundraise_list_issuances` is annotated `readOnlyHint: true`, so it ran in `exec` mode under
  the `read-only` sandbox with no approval flag. You do not need any `--dangerously-*` flag.
  For later tools, Codex accepts these keys (checked with `--strict-config`):
  `mcp_servers.fstack.default_tools_approval_mode = "approve"` and
  `mcp_servers.fstack.tools.<tool>.approval_mode = "approve"`. Only pre-approve read-only tools this way.
  Mutating tools (`create_issuance`, `execute_distribution`) should keep asking. The server-side
  `previewId` / `confirmTotal` guard is the real safety net.

## Rules for every skill in the family

1. **Frontmatter:** `name` + `description` only, with `---` delimiters. Both agents read this. Codex
   does not load a SKILL.md that has no frontmatter. The `name` is the bare skill name (`fundraise-launch`),
   not `fstack:...`. Claude Code adds the `fstack:` namespace.
2. **Directory naming:** `plugins/fstack/skills/<name>/SKILL.md`, plus a symlink
   `.agents/skills/fstack-<name> -> ../../plugins/fstack/skills/<name>`. The `fstack-` prefix gives Codex
   a unique name (it has no plugin namespace).
3. **Refer to tools by bare name** (`fundraise_list_issuances`), never by an agent-specific prefix. Claude
   exposes `mcp__plugin_fstack_fstack__fundraise_list_issuances`; Codex exposes `fstack.fundraise_list_issuances`.
   Both matched the bare name.
4. **Descriptions carry the trigger.** Codex implicit invocation uses the description. With many user-level
   skills installed, Codex may run out of its skill-context budget and drop descriptions (we saw
   "Exceeded skills context budget", and the skill still resolved by name/path). Put the key trigger words
   in the skill `name` and in the first sentence of `description`, and document `$fstack-<name>` as the
   explicit invocation.
5. **Tool annotations:** set `readOnlyHint: true` on every read-only tool. With it, Codex `exec` ran the
   tool without an approval prompt. We have not tested a tool without the hint, but it probably needs approval.
6. **Permission allowlists (Claude):** `mcp__plugin_fstack_fstack__*`, or per tool
   `mcp__plugin_fstack_fstack__fundraise_get_market`.

## Known limitations

- The Claude plugin `.mcp.json` path is relative to the repo (`../../packages/...`). It works with
  `--plugin-dir`, not with a marketplace install (see above).
- The Codex config needs an absolute path to `dist/index.js`, plus a `pnpm build` first.
- A project-scoped `.codex/config.toml` was not tested. Codex gates project config on project trust, and this
  repo is not in the user's trusted list. The user-level snippet or the `-c` flags are the supported path.
- Codex's own skill-budget warning depends on how many other skills the user has installed. It does not
  come from this repo.
