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
`LS`, `Edit`, `Write`, `Bash`, `Task`) or native tool names (`read_file`, `apply_diff`, …).

Rule syntax:

- `Bash(npm test:*)` matches the prefix: `npm test`, `npm test -- -u`.
- `Bash(git * main)` matches with `*` as a wildcard.
- Any other Bash specifier must match the command exactly.
- Path specifiers use gitignore style:
  - `src/**` is relative to the project.
  - `//etc/**` is an absolute path.
  - `~/...` is relative to the home folder.
  - `*.pem` without a slash matches at any depth.

A command chain (`a && b; c | d`) is allowed only when every part is allowed.

Evaluation order:

1. Tool list of the subagent
2. `deny`
3. Built-in secret protection (`.env*` except `.env.example`, `*.pem`, `*.key`, `id_rsa*`, `.ssh/**`, `wg*.conf` …). Symlinks are resolved first, and Bash commands that read these files are covered too.
4. `plan` mode: edits and commands are denied
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
`--provider perplexity|openai`, `--web/--no-web`, `--trust-project`, `--no-journal`, `-v/--verbose`.

REPL commands: `/help`, `/mode`, `/permissions`, `/model`, `/compact`, `/clear`, `/agents`, `/skills`,
`/status`, `/todos`, `/resume`, `/exit`. Ctrl+C stops the running task.

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

Other commands: `pcode accounts`, `logout`, `sessions`, `models`, `agents`, `skills`, `doctor`.

OpenAI-compatible provider settings: `PCODE_OPENAI_BASE_URL` (default `http://127.0.0.1:11434/v1`),
`PCODE_OPENAI_API_KEY`, `PCODE_OPENAI_MODEL`, `PCODE_OPENAI_TEMPERATURE`.

## Tests

`npm test` runs three suites:

- `agent`: the 2.x agent loop.
- `settingsStore`.
- `core`: 27 cases covering permissions, real `sh` hooks, settings layering, subagents, skills,
  memory, the journal, verification, read batching, CLI argument parsing, gated agent sessions
  (deny, plan, acceptEdits, verify loop, Stop and UserPromptSubmit hooks, subagent tool list, resume,
  compaction), the OpenAI SSE and JSON transport against a local mock server, and end-to-end runs of
  `out/cli.js -p` with `--output-format json` and `stream-json`, `-c`, headless denial, login and sessions.
