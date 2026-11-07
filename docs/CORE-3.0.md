# PerplexiCode 3.0 — headless core and `pcode` CLI

3.0 puts the agent into a core with no `vscode` imports (`src/core/`). Both the VS Code extension and
the `pcode` terminal CLI run on it. They use the same agent loop (`src/agent/task.ts`), the same tools,
the same Perplexity transport with account rotation, and the same session journal. A task started in
the IDE can be continued in a terminal with `pcode --continue`.

The config files follow the Claude Code formats: `settings.json` permissions and hooks,
`.claude/agents/*.md`, skills and `CLAUDE.md`. An existing `.claude/` folder works without changes.

## Layout

| File | Purpose |
| --- | --- |
| `src/core/types.ts` | `ToolGate` interface, `CoreEvent` union, permission modes, Claude tool-name map |
| `src/core/settings.ts` | Layered settings loader |
| `src/core/permissions.ts` | `Tool(specifier)` rules, path globs, Bash prefixes, secret protection |
| `src/core/hooks.ts` | Hook engine (Claude Code stdin/exit-code/JSON contract) |
| `src/core/gate.ts` | `CoreGate`: permissions + hooks + verify-before-done + session context |
| `src/core/agents.ts` | Subagents, skills, `CLAUDE.md` memory with `@imports` |
| `src/core/journal.ts` | Append-only JSONL journal + atomic snapshots, resume, interrupted-work detection |
| `src/core/verification.ts` | `verified / needs_review / failed / blocked / no_changes` |
| `src/core/compaction.ts` | `/compact` |
| `src/core/runner.ts` | `CoreSession`: tasks, subagents, journal, resume, compact |
| `src/core/openaiProvider.ts` | OpenAI-compatible transport (Ollama, LM Studio, vLLM, OpenRouter …) |
| `src/core/perplexity.ts` | Perplexity web-session transport for the CLI (accounts in `~/.perplexicode`) |
| `src/core/nodeHost.ts`, `nodeStores.ts` | Node implementations of the host, Memento and SecretStorage |
| `src/cli/` | `pcode` (REPL + headless) |
| `src/agent/coreBridge.ts` | Connects the VS Code controller to the core |

## Settings layers

Files are read in this order. Lists such as `allow`, `ask`, `deny` and hooks are concatenated.
Scalar values are overridden by later files.

1. `~/.claude/settings.json`
2. `~/.perplexicode/settings.json`
3. `<project>/.claude/settings.json`
4. `<project>/.perplexicode/settings.json`
5. `<project>/.claude/settings.local.json`, `<project>/.perplexicode/settings.local.json`

Hooks from project files run shell commands, so they only load once the folder is trusted:

- VS Code uses Workspace Trust.
- `pcode` asks once and stores the answer in `~/.perplexicode/trusted.json`.
- Headless runs need `--trust-project`.

User-level hooks always load.

```json
{
  "permissions": {
    "defaultMode": "default",
    "allow": ["Read", "Bash(npm test:*)"],
    "ask": ["Bash(npm install:*)"],
    "deny": ["Bash(git push:*)", "Read(./secrets/**)"],
    "protectSecrets": true,
    "additionalDirectories": ["../shared"]
  },
  "hooks": { "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "./guard.sh" }] }] },
  "verify": { "command": "npm test", "maxAttempts": 2, "timeoutSec": 600 },
  "readBatchSize": 5,
  "env": { "CI": "1" }
}
```

A complete example is in [`examples/claude-code-compat`](../examples/claude-code-compat).

## Permissions

Rules use the form `Tool` or `Tool(specifier)`. Tool names can be Claude names (`Read`, `Grep`, `Glob`,
`LS`, `Edit`, `Write`, `Bash`, `Task`, `WebFetch`) or native tool names (`read_file`, `apply_diff`, …).
MCP tools (3.3) use the Claude Code qualified name `mcp__<server>__<tool>`; server and tool names are
sanitised to `[A-Za-z0-9_-]` (a space becomes `_`).

Rule syntax:

- `Bash(npm test:*)` matches the prefix: `npm test`, `npm test -- -u`.
- `Bash(git * main)` matches with `*` as a wildcard.
- Any other Bash specifier must match the command exactly.
- Path specifiers use gitignore style:
  - `src/**` is relative to the project.
  - `//etc/**` is an absolute path.
  - `~/...` is relative to the home folder.
  - `*.pem` without a slash matches at any depth.

- MCP (3.3): `mcp__github__get_issue` (one tool), `mcp__github__*` or `mcp__github` (every tool and
  resource of a server), `mcp` (all servers), and the specifier forms `mcp(github)`,
  `mcp(github__get_issue)`, `mcp(github:get_issue)`. MCP tools have no implicit allow: without a rule
  the auto-approve **MCP** toggle or the approval prompt decides.
- `WebFetch(domain:docs.example.com)` (3.3) allows `web_fetch` for a host and its subdomains.

A command chain (`a && b; c | d`) is allowed only when every part is allowed.

Evaluation order:

1. Tool list of the subagent
2. `deny`
3. Built-in secret protection (`.env*` except `.env.example`, `*.pem`, `*.key`, `id_rsa*`, `.ssh/**`, `wg*.conf` …). Symlinks are resolved first, and Bash commands that read these files are covered too.
4. `plan` mode: edits, commands and MCP tool calls are denied (`access_mcp_resource` stays read-only and allowed)
5. `ask`
6. `allow`
7. `bypassPermissions` or `acceptEdits` (workspace files only)
8. Paths outside the workspace go to `ask`
9. If nothing matched, the old auto-approve settings decide, so 2.x behaviour is unchanged.

Permission modes:

| Mode | Effect |
| --- | --- |
| `default` | Rules first, then the existing auto-approve checkboxes |
| `acceptEdits` | Edits to workspace files without asking |
| `plan` | Read-only. The agent investigates and presents a plan |
| `bypassPermissions` | Everything except `deny` rules, secrets and the subagent tool list |

## Hooks

Supported events: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `SessionStart`
and `SessionEnd`.

- Each command runs with `/bin/sh -c` and receives JSON on stdin: `session_id`, `transcript_path`,
  `cwd`, `permission_mode`, `hook_event_name`, `tool_name`, `tool_input` and, for `PostToolUse`,
  `tool_response`. `tool_input` uses Claude field names such as `file_path` and `command`.
- The environment has `CLAUDE_PROJECT_DIR` and `PERPLEXICODE_PROJECT_DIR`.
- `matcher` is a regular expression over the Claude tool name and native name, for example
  `Bash`, `Edit|Write` or `*`.
- Exit code 2 blocks the action. Stderr goes back to the model as the reason.
- JSON on stdout is also read:
  - `hookSpecificOutput.permissionDecision` = `allow`, `ask` or `deny`
  - `decision: "block"` plus `reason`
  - `hookSpecificOutput.additionalContext`
  - `continue: false` plus `stopReason`
- Plain stdout from `UserPromptSubmit` and `SessionStart` is added to the context.
- A `Stop` hook that blocks makes the agent continue instead of finishing (at most 5 times).

## Verify before done

When `verify.command` is set and the task changed files, `attempt_completion` runs the command
first. If it fails, the completion is rejected (`[NOT ACCEPTED]`), the output tail goes back to the
model, and the model gets up to `maxAttempts` tries.

Separately, every task gets a verification status:

- `verified`: a test, lint or build command (or the verify command) passed after the last edit.
- `needs_review`: files changed, but no check ran after the last edit.
- `failed`: the last check failed.
- `blocked`: the task stopped without completing.
- `no_changes`: no files changed.

The CLI prints this status and returns it in `--output-format json`. Exit code 2 means `failed`.

## Subagents and skills

Subagents are Markdown files with frontmatter in `.perplexicode/agents/`, `.claude/agents/` or the
same folders under `~`:

```markdown
---
name: explorer
description: Read-only codebase explorer
tools: Read, Grep, Glob
model: gpt6_1_sol    # optional, otherwise the current model
mode: review         # optional, otherwise inferred from tools
---
System prompt of the subagent.
```

The main agent sees the list of subagents and can call `new_task` with `<mode>explorer</mode>`. The
subagent runs with its own system prompt, mode and model. Its tool list is enforced even in
`bypassPermissions` mode. Its `attempt_completion` result comes back to the parent as the tool result.
Built-in mode names (`code`, `ask`, …) cannot be redefined.

Skills live at `<dir>/<name>/SKILL.md` under `.perplexicode/skills`, `.claude/skills` and `~/...`. The agent sees
the list and reads a skill file when the task matches. Reading these files is always allowed.

### Catalog and task presets (3.1)

`src/core/library.ts` holds the built-in catalog: 8 subagents, 8 skills and 10 task presets. `pcode agents add <id...> [-g]` and
`pcode skills add <id...> [-g]` write the catalog files. Existing files are never overwritten, and names are checked so nothing is
written outside the target folder. The VS Code view does the same.

A task preset is JSON:

```json
{ "id": "fix-bug", "title": "Fix a bug", "mode": "debug", "agent": "debugger",
  "prompt": "Reproduce, find the root cause and fix: {{input}}", "inputRequired": true,
  "requires": { "agents": ["debugger"], "skills": ["debug-playbook"] } }
```

Sources are merged by `id`. Later sources override earlier ones in this order: built-in → `~/.perplexicode/presets.json` →
`perplexicodeKilo.taskPresets` → `.perplexicode/presets.json`. `pcode --preset <id> -p "<input>"` runs a preset, and
`pcode --agent <name>` runs the whole root task as a subagent, with its prompt and tool list.

Memory files are `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, `PERPLEXICODE.md`,
`~/.claude/CLAUDE.md` and `~/.perplexicode/PERPLEXICODE.md`. `@path` imports are followed up to 4 levels deep.

## Session journal and resume

Each task writes to `~/.perplexicode/sessions/` (override with `PERPLEXICODE_HOME`):

- `<id>.jsonl` is an append-only event log (mode 0600). Tool parameters that look like secrets are
  redacted and large values are truncated.
- `<id>.json` is an atomic snapshot (temp file, fsync, rename).

`pcode -c` resumes the latest session for the folder. `pcode -r <id|prefix>` resumes a specific one,
from either the IDE or the CLI. If the previous run was interrupted, the agent is told which commands
have an unknown outcome and that it must check the real state before re-running them.

## Read batching

Up to `readBatchSize` (default 5, max 9) consecutive read-only calls (`read_file`, `list_files`,
`search_files`, `list_code_definition_names`) in one model answer run together. Their results go back
in a single message, which saves model round-trips during exploration. Edits and commands still run
one at a time.

## MCP servers (3.3)

`src/core/mcp.ts` implements the client side of the Model Context Protocol without `vscode` imports;
the extension and the CLI share it through `McpRegistry`.

Config sources, merged by server name (later wins):

1. `~/.claude.json`: the root `mcpServers` block and `projects["<cwd>"].mcpServers` (scope `local`)
2. `~/.claude/.mcp.json`, `~/.claude/mcp.json`, `~/.perplexicode/mcp.json` (scope `user`)
3. `mcpServers` inside every settings layer (`~/.claude/settings.json`, `~/.perplexicode/settings.json`, …)
4. `<cwd>/.mcp.json`, `.claude/.mcp.json`, `.claude/mcp.json`, `.perplexicode/mcp.json` (scope `project`;
   a bare `{ "name": { ... } }` map without `mcpServers` is accepted in `mcp.json` files)
5. `.mcp.local.json`, `.claude/settings.local.json`, `.perplexicode/settings.local.json` (scope `local`)
6. `--mcp-config <file|json>` / `perplexicodeKilo.mcp.extraConfigs` (scope `cli`; `--strict-mcp-config`
   keeps only these)

Server entries follow the Claude Code schema: `{ "command", "args", "env", "cwd" }` for stdio,
`{ "type": "http" | "sse", "url", "headers" }` for remote servers, `"disabled": true` to skip one.
`${VAR}` and `${VAR:-default}` are expanded from the process environment plus the `env` block of the
settings layers. Entries without `command` or `url` are reported as invalid instead of aborting the load.

Trust: stdio servers from `project` and `local` scope start only when the folder is trusted (VS Code
Workspace Trust; in the CLI `--trust-project`, or the one-time `Trust this folder?` prompt of the REPL,
which is remembered in `~/.perplexicode/trusted.json`). Until then their status is
`untrusted` and `pcode mcp list` prints `untrusted` in the status column. `user`, `cli` and all
`http` / `sse` servers start regardless.

Protocol: `initialize`, `notifications/initialized`, `tools/list`, `resources/list`, `prompts/list`,
`tools/call`, `resources/read`. Server → client requests `ping` and `roots/list` are answered (roots =
the workspace folder); other requests get `-32601`. `notifications/tools/list_changed` and the
resource variant refresh the server's catalogue. Stdio accepts newline-delimited JSON and
`Content-Length` framing. Failures are isolated per server: a missing binary, a crash (the stderr tail is
kept in the error), an `initialize` timeout or an HTTP 4xx/5xx mark that server `error` and leave the
others running. Concurrent `connectServer` calls for the same server share one connection attempt.
On Windows, `npx` / `npm` / `pnpm` / `yarn` style `.cmd` shims are resolved through `PATH` and
`PATHEXT` and started through `cmd.exe`.

Agent tools: `use_mcp_tool` (`server_name`, `tool_name`, `arguments` as a JSON object),
`access_mcp_resource` (`server_name`, `uri`), `list_mcp_resources` (`server_name` optional), and the
direct form `<mcp__server__tool>{ "arg": 1 }</mcp__server__tool>`. The system prompt gets an MCP
section only while at least one server is connected. Tool results with `isError: true` are returned to
the model as `[ERROR] The MCP tool reported an error:` and shown as failed tool cards. Hooks receive
`mcp__server__tool` as the tool name and the arguments object as `tool_input`.

CLI: `pcode mcp list` (tab-separated `name type scope status target file` on stdout),
`pcode mcp add <name> [-s user|project|local] [-t stdio|http|sse] [-e K=V]... [-H "Header: v"]... -- <command|url> [args]`,
`pcode mcp remove <name> [-s scope]`, `pcode mcp get <name>` (connects, lists tools and resources),
`pcode mcp test [name]`, `--mcp-config`, `--strict-mcp-config`, `--no-mcp`, REPL `/mcp [reconnect [name]]`.
Saving writes `project` servers to `<cwd>/.mcp.json`, `user` servers to `~/.perplexicode/mcp.json` and
`local` servers to `.perplexicode/settings.local.json`.

## Compute modes (3.3)

`COMPUTE_MODES` in `src/api/modelCatalog.ts` describes how a request is routed on Perplexity:
`search` (default), the Computer harness presets `light` / `standard` / `high` / `ultra`, `computer`
(ASI variant of the selected model), `research`, `agentic_research` and `labs`. `normalizeComputeMode`
accepts the aliases `compute`, `asi`, `max`, `deep_research`, `agentic`, `studio`, `default`, `auto`.
`resolveComputeRoute` picks the first route of a mode that the account pool's plan allows and whose
quota bucket is not exhausted; `PerplexityTransport` walks the remaining routes when the API rejects
one (ASI → Comet browser agent → Search) and reports the mode that was actually used. A thread is
reused for follow-ups only while the route is unchanged. Settings: `computeMode` in the settings layers,
`perplexicodeKilo.computeMode`, `--compute <mode>`, REPL `/compute [mode]`.

## Curated MCP catalog (3.4)

`src/core/mcpCatalog.ts` provides shared templates and setup guides to the CLI and IDE.
`pcode mcp catalog [category|query]` lists requirements, notes and upstream documentation.
`pcode mcp install <id> [-s user|project|local] [--set KEY=value]` writes a configuration without
connecting, downloading software or changing permissions. `--set` accepts non-secret template
parameters only; token values must be supplied through the process environment. Existing server
names are rejected rather than overwritten. Setup-only entries direct users to native app/plugin
instructions and do not generate a fabricated executable config.
Templates are enabled by default: the next task can connect them and download/run declared
npm/uv packages. The native confirmation discloses this, and existing project stdio trust checks
remain in force. Configuration-only describes installation, not a promise never to execute later.

The IDE uses native prompts for parameters and SecretStorage for credentials; the webview receives
only catalog metadata and sends an entry ID plus scope, not secret values. Stored credentials are
bound to the exact source file, server name and config through `src/core/mcpCredentials.ts`.
`loadMcpServers` / `McpRegistry` accept a `serverEnv` callback so one server's stored credentials
cannot expand placeholders in another server's config. Editing a config invalidates that binding.
IDE secrets are not exported to CLI sessions or written to `.mcp.json`.

See the [Security MCP and Parrot OS guide](MCP-SECURITY-PARROT.md) for security integrations,
prerequisites, native setup examples and the limits of the compatibility checks.

## CLI reference

```bash
pcode                                   # REPL
pcode "explain src/agent/task.ts"       # REPL with a first prompt
pcode -p "fix the failing test" --permission-mode acceptEdits --allowedTools "Bash(npm test:*)"
git diff | pcode -p "review this diff" --output-format json
pcode -c -p "now update the changelog"  # continue the last session of this folder
pcode -r 9f3k2 --provider openai        # resume with a local model
```

Flags: `-p/--print`, `--output-format text|json|stream-json`, `--permission-mode`,
`--dangerously-skip-permissions`, `--allowedTools`, `--disallowedTools`, `--max-turns N` (`0` = no
limit), `-m/--model`, `--thinking`, `--mode`, `-c/--continue`, `-r/--resume [id]`, `--cwd`,
`--provider perplexity|openai`, `--web/--no-web`, `--trust-project`, `--no-journal`, `-v/--verbose`,
`--compute <mode>`, `--mcp-config <file|json>` (repeatable), `--strict-mcp-config`, `--no-mcp` (3.3).

REPL commands: `/help`, `/mode`, `/permissions`, `/model`, `/compute`, `/mcp`, `/compact`, `/clear`,
`/agents`, `/skills`, `/status`, `/todos`, `/resume`, `/exit`. Ctrl+C stops the running task.

Prompts in the REPL:

- `y`: allow once
- `n`: deny
- `a`: always allow. For edits this switches to `acceptEdits`. For commands it adds a session rule
  `Bash(<first two words>:*)`.
- Any other text is sent to the model as feedback.

Headless runs never wait for a person:

- Tool or command requests that the rules do not allow are denied, and the model is told how to allow them.
- Questions are answered with "proceed with best judgment".
- When the request limit is reached, the run continues only with `--max-turns 0`.

Accounts:

- `pcode login` reads the Cookie header from a hidden prompt, from stdin or from the `PPLX_COOKIE`
  variable. Tokens are never read from argv.
- `pcode login --browser` opens Chrome, Edge or Brave with a dedicated profile and reads the cookie
  after you sign in.
- In VS Code, **PerplexiCode: Share Accounts with CLI** copies the extension's accounts to
  `~/.perplexicode/credentials.json` (mode 0600).

Other commands: `pcode accounts`, `logout`, `sessions`, `models`, `agents`, `skills`, `presets`,
`mcp list|add|remove|get|test`, `doctor`.

OpenAI-compatible provider settings: `PCODE_OPENAI_BASE_URL` (default `http://127.0.0.1:11434/v1`),
`PCODE_OPENAI_API_KEY`, `PCODE_OPENAI_MODEL`, `PCODE_OPENAI_TEMPERATURE`.

## Tests

`npm test` runs six suites:

- `agent`: the 2.x agent loop.
- `settingsStore`.
- `core`: 34 cases covering permissions, real `sh` hooks, settings layering, subagents, skills,
  memory, the journal, verification, read batching, CLI argument parsing, gated agent sessions
  (deny, plan, acceptEdits, verify loop, Stop and UserPromptSubmit hooks, subagent tool list, resume,
  compaction), the OpenAI SSE and JSON transport against a local mock server, and end-to-end runs of
  `out/cli.js -p` with `--output-format json` and `stream-json`, `-c`, headless denial, login and sessions.
- `mcp` (3.3): 19 cases. A real stdio MCP server (`test/mcp-test-server.js`, ndjson and
  `Content-Length` framing, server → client `roots/list` and `ping`, `list_changed`, crash and hang
  knobs) and an in-process Streamable HTTP server (JSON and SSE replies, `Mcp-Session-Id`, 401/500)
  cover the transports; the rest covers config layering and saving, trust, permission rules, the tool
  parser, `glob_files` / `search_and_replace` / `web_fetch`, gated agent sessions that call MCP tools,
  CLI argument parsing and `pcode mcp add|list|get|remove` end to end.
- `mcp-catalog`: catalog metadata, config building, credential placeholder validation, safe
  installation, existing-file preservation and CLI catalog/install end-to-end checks.
- `mcp-credentials`: SecretStorage round trips, file and server isolation, edit invalidation,
  removal and malformed-file handling. These tests use an in-memory SecretStorage adapter.

`node test/webview-render.mjs` separately exercises the real webview bundle in headless Chromium,
including catalog search, category filters and bridge messages. It does not replace testing in a
live editor or a Parrot OS VM, and no external security scans are part of these test suites.
