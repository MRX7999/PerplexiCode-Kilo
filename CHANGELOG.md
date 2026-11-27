# Changelog

All notable changes to PerplexiCode Kilo. Versions follow [Semantic Versioning](https://semver.org/).

## [4.0.0] - 2026-11-27

### Added
- **Remote core daemon `pcode serve` & IDE client without copying Perplexity sessions (F26):** `pcode serve [--socket <path> | --ws --host <host> --port <port>]` runs the headless core over a `0600` Unix domain socket or RFC 6455 WebSocket protected by constant-time (`timingSafeEqual`) SHA-256 bearer token authentication (read from `PCODE_SERVE_TOKEN`, interactive prompt, or generated `0600` `~/.perplexicode/serve.token`; passing `--token` on argv is rejected with exit code `64`). In VS Code / Antigravity, `PerplexiCode: Remote Core: Connect to pcode serve…` (`perplexicodeKilo.remote.url`) executes file tools, commands, and LSP on the remote daemon while reverse-proxying `llm/complete` to the local IDE `PerplexityTransport` and enforcing `assertNoSessionSecretsOnWire` so Perplexity cookies and CSRF tokens never leave the IDE machine.
- **`lsp` tool in CLI (`.lsp.json`) and IDE (VS Code providers) (F27):** New `lsp` tool (`definition`, `references`, `hover`, `diagnostics`) backed by built-in `vscode.executeDefinitionProvider` / `vscode.executeReferenceProvider` / `vscode.executeHoverProvider` / `vscode.languages.getDiagnostics` in the IDE and by stdio JSON-RPC Language Servers configured via `<workspace>/.lsp.json` or `~/.perplexicode/lsp.json` in `pcode` CLI (gated on workspace trust for project servers).
- **Interactive REPL UX: `!<cmd>`, full `/rewind`, and live command timer (F28):** Prefixing any REPL line with `!<command>` runs the local shell command immediately and injects its command, exit code, and output into the active session context; `/rewind [seq|list]` rolls back both workspace files (restoring pre-checkpoint snapshots and deleting newly created files) and the session transcript/journal to the selected checkpoint; `LongCommandTimer` renders a live elapsed timer (`⏱ Выполняется … (Ns)`) on long-running commands.
- **Nightly Perplexity SSE canary workflow (F29):** `.github/workflows/canary.yml` and `scripts/canary-check.mjs` run nightly (`03:17 UTC`) and via `workflow_dispatch`. When `PPLX_CANARY_COOKIE` is absent, the job skips cleanly (`exit 0`) instead of failing; when configured, it sends one minimal probe and opens or updates a `canary-alert` GitHub Issue with secret-redacted diagnostics if the SSE schema drifts.
- **Out-of-band SHA-256 verified model catalog updates (F30):** `pcode models update` and `PerplexiCode: Update Model Catalog from Repository` fetch `bundledModelsConfig.json` and `bundledModelsConfig.json.sha256` (`perplexicodeKilo.models.remoteCatalogUrl` / `remoteCatalogSha256Url`), verify the SHA-256 digest before activating or caching the catalog, and fall back cleanly to the built-in snapshot on hash mismatch, malformed JSON, or network error.
- **Inline selection quick-edit (`Cmd/Ctrl+I`) with streaming diff & Migration to 4.0 guide (F31):** `PerplexiCode: Quick Edit Selection (Cmd/Ctrl+I)` (`perplexicodeKilo.quickEditSelection`) streams live replacements into a side-by-side `vscode.diff` preview (`QuickEditStreamAssembler`) with **Применить правку** / **Отменить** confirmation, alongside the comprehensive `Миграция на 4.0` section in `README.md`.

## [3.8.0] - 2026-11-27

### Added
- **MCP OAuth 2.0 + PKCE login, logout, and automatic 401 refresh (F21):** `pcode mcp login <server>` and `pcode mcp logout <server>` (plus **PerplexiCode: MCP: Login to Server (OAuth)…** / **Logout from Server (OAuth)…** and **OAuth Login** / **OAuth Logout** buttons on HTTP/SSE server cards in Library → MCP) perform RFC 8414 / RFC 9728 metadata discovery, optional RFC 7591 dynamic client registration, and Authorization Code + PKCE S256 with a loopback `127.0.0.1` callback. Tokens are stored in VS Code `SecretStorage` in the IDE and in the OS keychain in the CLI (macOS Keychain via `security -i` stdin, Linux `secret-tool`, Windows DPAPI Credential Manager, or `0600` `~/.perplexicode/mcp-oauth.json` fallback on headless systems) — never passed via argv or written to logs/journals — and HTTP `401` responses transparently refresh the access token and retry once.
- **MCP server prompts in `/server:skill` slash menu in IDE & REPL (F22):** Connected MCP servers expose `prompts/list` entries directly in the composer `/` popup and REPL (`/skills`, `/help`, and `/<server>:<prompt> [key="val" …]`), resolving `prompts/get` with positional or named arguments and injecting the rendered prompt into the active conversation.
- **Argument-level MCP permission rules overriding `autoApprove.mcp` (F23):** `permissions.allow`, `ask`, and `deny` accept argument predicates on MCP calls — e.g. `mcp__db__query(sql:SELECT *)`, `mcp__db__query(sql:*DROP*)`, `mcp__k8s__apply({"metadata":{"namespace":"prod*"}})`, and `mcp__vault__read_resource(uri:secret://*)` — failing closed on malformed JSON when a `deny` rule constrains arguments and enforcing `deny` even when `autoApprove.mcp` or `bypassPermissions` is enabled.
- **Configurable cross-model pre-completion review (F24):** Optional setting `perplexicodeKilo.agent.crossModelReview` / `.perplexicode/settings.json` `crossModelReview` / CLI `--cross-review` (default `false`) runs an independent review of the current git diff and `verify` output using a model from a different model family than the author (`anthropic` ↔ `openai` ↔ `google` ↔ `xai`, overridable via `crossModelReviewModel` / `--cross-review-model`) before accepting `attempt_completion`.
- **Compute mode `council` audit note (F25):** Intentionally omitted — `src/api/bundledModelsConfig.json` defines `default_models` (`search`, `research`, `agentic_research`, `study`, `browser_agent`, `asi`) and `computer_harness` (`light`, `standard`, `high`, `ultra`) with no `council` compute mode identifier or wire payload schema.

## [3.7.0] - 2026-11-27

### Added
- **Isolated git worktree tasks in CLI & IDE (F16):** `pcode -w` / `--worktree [name]`, REPL `/worktree`, and the IDE composer `worktree` toggle (`perplexicodeKilo.agent.worktreeEnabled`) create a detached git worktree from `HEAD` under `<gitCommonDir>/perplexicode-worktrees/<name>`. All file tools and `execute_command` calls are strictly confined to the worktree root — blocking `..`, symlink escapes (including directory and broken symlinks), `git -C <outside>`, `git --git-dir` / `--work-tree`, `GIT_DIR` / `GIT_WORK_TREE`, `git push`, `cd` outside, and external `ln -s`. If the main checkout has uncommitted changes, an explicit pre-start warning is emitted.
- **Worktree Result Card with non-merging Apply & Discard (F17):** Completed isolated tasks render a result card showing changed files, unified diff, and `verify` status with **Применить** (`pcode worktree apply <name>`) and **Отбросить** (`pcode worktree discard <name>`). Applying runs an atomic dry-run patch check and applies changes to the main working copy without automatic `git merge`, `git commit`, or `git push`; on conflict, execution halts without mutating the main tree and lists every conflicting file.
- **Parallel Orchestrator subagents with reader/writer split (F18):** Consecutive `<new_task>` calls emitted in Orchestrator mode run concurrently up to `maxParallelSubtasks` (`perplexicodeKilo.agent.maxParallelSubtasks`, CLI `--max-parallel-subtasks`, `.perplexicode/settings.json` `maxParallelSubtasks`, default `3`). Strictly read-only targets (`ask`, read-only `.claude/agents`) run in the main tree; write-capable targets each run in their own isolated git worktree.
- **`WorktreeCreate` and `WorktreeRemove` hooks (F19):** Claude Code compatible lifecycle hooks receive session/worktree metadata on stdin, set `PERPLEXICODE_WORKTREE_PATH` and `PERPLEXICODE_WORKTREE_NAME`, can block creation with exit code `2` (or `{"decision":"block"}`), or return a custom `worktreePath`.
- **Documented `pcode -p` CI exit codes (F20):** Deterministic exit-code contract (`0` OK, `1` runtime error, `2` `verify.command` failed, `3` policy/permission/hook/`stopOnFallback` blocked, `4` `--max-turns` exceeded, `5` authentication required, `6` worktree apply conflict, `64` CLI usage error, `130` interrupted by `SIGINT`) exposed on `PCODE_EXIT_CODES` and JSON `exit_code`.

## [3.6.0] - 2026-11-27

### Added
- **Post-edit IDE diagnostics with Warning + Error diffing (F10):** After `apply_diff`, `write_to_file`, `search_and_replace`, and `insert_content`, `VsCodeAgentHost` snapshots `vscode.languages.getDiagnostics` before saving and appends only newly introduced `Error` and `Warning` entries (`diffPostEditDiagnostics`) to the tool result.
- **Structural repository map `@repo` without a vector DB (F11):** `buildRepoMap` indexes workspace symbols and signatures (TypeScript, JavaScript/CommonJS, Python, Go, Rust), resolved imports, reverse importers, and related test files (`*.test.*`, `*.spec.*`, `test/`), prioritizing the active editor file and current git diff within a strict character budget (`perplexicodeKilo.agent.repoMapMaxChars`, default `6000`; CLI `--repo-map` / `--no-repo-map` / `--repo-map-chars`).
- **Context Inspector in IDE & CLI (F12):** Task header eye button (`Инспектор контекста`), `/context` slash command, `PerplexiCode: Inspect Task Context…`, and REPL `/context [exclude|include <id>]` show exact prompt budget usage, why each block is included, what was compacted, and let you exclude or re-include individual items for subsequent requests.
- **Threshold-based structured auto-compaction (F13):** When the assembled prompt exceeds `maxPromptChars * autoCompactThreshold` (default `0.8`), `structuredAutoCompact` condenses older turns into four structured sections (`Изменённые файлы`, `Проверенные гипотезы`, `Ограничения`, `Статус todo`) while keeping the system prompt and the latest `N` dialogue steps (`autoCompactKeepSteps`, default `4`) untouched.
- **24-task reproducible `@repo` benchmark vs 3.4 baseline (F14):** `runRepoMapBenchmark` (`src/core/repoMapBench.ts`) evaluates 24 bug-fix tasks across `read_file` count before the first valid edit (`4.29 → 1.00`, `-76.7%`), prompt characters sent (`150,858 → 55,347`, `-63.3%`), and `verify.command` pass rate (`100% → 100%`), enabling `repoMapEnabled` by default only when metrics do not degrade.
- **Jittered exponential backoff & per-account RPM cap (F15):** `computeBackoffWithJitterMs` applies equal-jitter exponential backoff (`1.5s` base, `30s` ceiling) across transport retries and rate-limit cooldowns, and `RotationEngine` enforces a sliding 60-second per-account ceiling (`perplexicodeKilo.rotation.maxRequestsPerMinute`, CLI `--max-rpm`, conservative default `12` RPM) before rotating or throttling.

## [3.5.0] - 2026-11-27

### Added
- **SSE replay & stream interruption test suite (F01):** Deterministic SSE replay harness (`consumeSseStream` + `PerplexityTransport`) covering duplicate final chunks, stream cut-off mid-`apply_diff`, and reconnect after an already-applied edit, asserting exact single file modification and single command execution.
- **Safe resume without blind command re-execution (F02):** Commands started before a stream/process drop without a recorded exit status are logged as `command_unconfirmed` (`результат не подтверждён`) in `SessionJournal`. On resume (`pcode -c` / `-r` and IDE task reopen), `AgentTask` blocks blind re-execution of the unconfirmed command until the agent inspects workspace state (`read_file` / `list_files` / `search_files`).
- **Transparent task state banner in IDE & CLI (F03):** Live status card in the webview and `[статус] … (правило: …)` line in `pcode` showing `жду подтверждения`, `повторяю запрос`, `проверяю результат`, and `нужно вмешательство` with the exact reason and policy/setting rule that triggered it.
- **Explicit route visibility & `stopOnFallback` (F04):** Every request records `запрошенный режим → фактический, причина` (reporting `не сообщена` when the upstream response omits the actual model). New setting `perplexicodeKilo.agent.stopOnFallback` / `.perplexicode/settings.json` `stopOnFallback` / CLI `--stop-on-fallback` stops the task with `нужно вмешательство` instead of silently falling back to another compute mode, model, or account.
- **SSRF protection in `web_fetch` (F05):** Blocks loopback (`127.0.0.0/8`, `::1`), RFC1918 private networks, link-local and cloud metadata (`169.254.0.0/16` including `169.254.169.254`, `fe80::/10`), CGNAT, ULA, multicast, IPv4-mapped IPv6 addresses, and `.localhost`/`.internal` hosts, re-validating DNS and IP addresses on every HTTP redirect hop and pinning the validated IP on connection.
- **Segment-level shell parser for allow/deny (F06):** Splits shell commands across `;`, `&&`, `||`, `|`, `&`, and newlines, unwraps `env VAR=…` and common command wrappers, recursively inspects `sh -c` / `bash -c` / `zsh -c` scripts, evaluates every segment independently against allow/deny rules, and forces confirmation on command substitutions, `eval`, redirections, or unparseable syntax.
- **Installer SHA-256 verification (F07):** `scripts/install.sh` and `scripts/install.ps1` verify downloaded VSIX archives against release `SHA256SUMS.txt` and abort immediately on checksum mismatch.
- **Redacted diagnostics bundle with preview (F08):** `pcode doctor --bundle [-o file] [-y]` and **Скопировать диагностику** (`PerplexiCode: Copy Diagnostics Bundle…`) export versions, stage timings, tool categories, and rule decisions — strictly without cookies, headers, prompts, code, or terminal output — after showing a full preview.
- **Threat model & protected agent configs (F09):** Added `SECURITY.md` and enforced mandatory confirmation when editing or touching `.perplexicode/settings*.json`, `hooks`, `.mcp.json`, and `.claude/` even when `autoApprove.write`, `acceptEdits`, or `bypassPermissions` is enabled.

## [3.4.0] - 2026-11-07

### Added
- **Curated MCP catalog** in the Library → MCP tab and `pcode mcp catalog [category|query]`, with Development, Web, Productivity, Security and Pentest categories. Entries include upstream documentation, prerequisites, use cases, setup notes, risk labels and source-check dates. This is not a usage ranking or an upstream security audit.
- **Catalog configuration installation:** Project / Global actions in the IDE and `pcode mcp install <id> [-s user|project|local] [--set KEY=value]`. Installation adds configuration only, never downloads software, starts servers, scans targets or grants permission rules. Native integrations have explicit Setup guide states instead of misleading install buttons. Existing configurations are preserved and duplicate names are rejected.
- **IDE credential storage:** Native password prompts keep catalog tokens in VS Code SecretStorage while config files retain environment-variable references. Credentials are bound to the source file, server name and exact saved config; edits invalidate the binding and unrelated servers cannot reuse it. CLI catalog installations require environment variables and reject token arguments.
- **Security and Parrot OS guide** included in the VSIX and accessible from the catalog, covering authorised security workflows, native tools and plugins, prerequisites and the distinction between source verification and runtime testing.
- **Visual-first documentation:** A new product banner, interface gallery and architecture, workflow and catalog diagrams. README, CLI reference and Parrot instructions use closed, labelled disclosure sections; existing badges and counters are preserved.

### Fixed
- **Narrow library navigation:** Tabs wrap within the sidebar instead of overflowing.

## [3.3.0] - 2026-11-07

### Added
- **MCP (Model Context Protocol) support, Claude Code compatible.** New headless module `src/core/mcp.ts` (no `vscode` imports) with stdio and Streamable HTTP / SSE transports, `initialize` → `tools/list` / `resources/list` / `prompts/list`, `tools/call`, `resources/read`, server → client `ping` and `roots/list`, `notifications/tools/list_changed` refresh, per-server failure isolation (missing binary, crash with captured stderr, init timeout, slow tools) and deduplicated concurrent connects.
  - **Config sources**, read in this order and merged by server name: `~/.claude.json` (root and `projects[<cwd>]`), `~/.claude/.mcp.json`, `~/.claude/mcp.json`, `~/.perplexicode/mcp.json`, the `mcpServers` block of every settings file, `<project>/.mcp.json` (bare `{ "name": {...} }` maps are accepted), `.claude/.mcp.json`, `.claude/mcp.json`, `.perplexicode/mcp.json`, `.mcp.local.json`, `*.local.json`, then `--mcp-config <file|json>` / `perplexicodeKilo.mcp.extraConfigs`. `${VAR}` and `${VAR:-default}` are expanded in `command`, `args`, `env`, `url` and `headers`, like Claude Code.
  - **Trust**: stdio servers from project or local scope start only in a trusted workspace (VS Code Workspace Trust, `--trust-project` in the CLI); user, cli and http servers always start. Untrusted servers are shown with the reason instead of silently disappearing.
  - **New agent tools**: `use_mcp_tool`, `access_mcp_resource`, `list_mcp_resources`. The model may also call a tool directly as `<mcp__server__tool>{...}</mcp__server__tool>`, the same qualified name Claude Code uses. MCP tools, resources and prompts are listed in the system prompt only when at least one server is connected.
  - **Permission rules** in `allow` / `ask` / `deny`: `mcp__server__tool`, `mcp__server__*`, `mcp__server`, `mcp`, and `mcp(server)` / `mcp(server__tool)` / `mcp(server:tool)`. Plan mode blocks `use_mcp_tool` unless a rule allows it. Hooks receive `mcp__server__tool` as the tool name, so existing Claude Code `PreToolUse` matchers work.
  - **CLI**: `pcode mcp list|add|remove|get|test`, `pcode mcp add <name> [-s user|project|local] [-t stdio|http|sse] [-e K=V] [-H "Header: v"] -- <command|url> [args]`, `--mcp-config`, `--strict-mcp-config`, `--no-mcp`, REPL `/mcp [reconnect [name]]`, and `pcode doctor` reports MCP servers.
  - **VS Code**: settings `perplexicodeKilo.mcp.enabled`, `perplexicodeKilo.mcp.extraConfigs`, `perplexicodeKilo.agent.autoApprove.mcp`; command **PerplexiCode: MCP: Reconnect Servers**; a new **MCP** tab in the Library view (status, tools, resources, add / remove / reconnect, open the config file) and `/mcp` in the composer. Tool cards show the server name and MCP `isError` results as errors.
- **Compute mode selection** (requested in issues): choose how Perplexity runs the request instead of only which model answers.
  - Modes: `search` (default), `light` (GPT-6.1 Sol harness), `standard` (Claude Opus 5.5 harness), `high` (GPT-6 Astra harness), `ultra` (Claude Fable 5.1 harness, high effort), `computer` (ASI variant of the selected model), `research` (Deep Research), `agentic_research` (Max) and `labs` (Labs / Studio). Aliases: `compute`, `asi`, `max`, `deep_research`, `agentic`, `studio`, `default`, `auto`.
  - **Fallback chain** when the plan or quota does not allow a mode: ASI harness → Comet browser agent → Search with the closest chat model; Deep Research → Best with a note. The UI and CLI say which mode is actually used (`is not available on your current accounts. Using Search mode`).
  - **VS Code**: a compute pill next to the model picker, command **PerplexiCode: Select Compute Mode**, setting `perplexicodeKilo.computeMode`, status bar shows the active mode.
  - **CLI**: `--compute <mode>`, REPL `/compute [mode]`, `pcode models` lists the compute modes and their orchestrator models, and `computeMode` in `.perplexicode/settings.json`.
- **New built-in tools**: `glob_files` (gitignore-style patterns, workspace-bound), `search_and_replace` (literal or regex, optional line range, case-insensitive flag), `web_fetch` (HTTP(S) GET with redirects, size limit, HTML → readable text, `WebFetch(domain:host)` permission rules and `perplexicodeKilo.agent.autoApprove.web`).
- **Tests**: new `test/mcp.test.ts` (19 tests, including a real stdio MCP test server in `test/mcp-test-server.js` with ndjson and Content-Length framing, an in-process HTTP MCP server with sessions and SSE, config layering, trust, permissions, parser, end-to-end agent sessions and `pcode mcp` e2e) and 7 compute-mode transport tests. `npm test` now runs 96 tests.

### Fixed
- `search_and_replace` in literal mode no longer interprets `$&` / `$1` in the replacement; invalid regular expressions produce a clear error instead of an exception.
- `web_fetch` honours an already aborted signal before starting the request.
- Permission rules whose tool name contains `*` or `.` (for example `mcp__github__*`) were silently dropped by the rule parser.
- Windows: stdio MCP servers started through `npx`, `npm`, `pnpm`, `yarn` or other `.cmd` shims are resolved through `PATH` / `PATHEXT` and launched through `cmd.exe` with quoted arguments, so configs copied from Claude Code docs work without `cmd /c`.
- Bare server maps (entries with `command` / `url` but no `mcpServers` wrapper) are accepted only in dedicated `mcp.json` files and `--mcp-config`; a `verify: { "command": "npm test" }` block in `settings.json` is no longer mistaken for an MCP server.
- MCP connections answer server-initiated `ping` and `roots/list` requests instead of leaving them pending, so servers that require roots (filesystem, git) initialise correctly.

## [3.2.0] - 2026-11-06

### Fixed
- **Perplexity & OpenAI SSE transport reliability:**
  - Fixed duplicate/stuttered output and corrupted XML tags when Perplexity streams delta chunks (`delta`, `text_delta`, `patch`) alongside cumulative snapshots (`answer`, `text`), and added extraction from structured `blocks` / `step_type: FINAL` payloads.
  - Detected premature stream cut-offs inside unclosed XML tool calls (`<apply_diff>`, `<write_to_file>`, `<execute_command>`, etc.) and empty final answers, automatically retrying with non-follow-up / web fallback in `PerplexityTransport` and `PerplexityClient`.
  - Fixed `\r\n` SSE frame splitting, trailing buffer flush on stream end, and content-part array extraction in `OpenAICompatibleProvider`.
- **Tool parser resilience:**
  - Unfenced XML tool calls now take precedence over earlier tool tags inside markdown code fences (` ```xml ... ``` `), preventing echoed tool examples or Perplexity search/reasoning echoes from shadowing the real tool call.
  - Stripped residual ` ```xml <tool>...</tool> ``` ` blocks from assistant prose and recovered tool calls with minor closing-tag corruption or markdown-autolinked URLs (`<https://...>`).
- **Duplicate function definitions on insert / diff (`insert_content`, `apply_diff`, `insertCode`):**
  - `insert_content` and `PerplexiCode: Insert Code into Editor` now detect when the inserted snippet defines a single named function (`function`, `def`, `func`, `fn`, ` arrow function `) that already exists in the target file and replace the existing function body in-place instead of creating a duplicate definition. Also suppresses exact duplicate block insertions at adjacent lines.
  - `apply_diff` now detects when a `SEARCH` block matches only a function signature / header while `REPLACE` provides the full function body, expanding the replacement span across the existing function block instead of leaving the old body dangling below the new function. Also skips already-applied anchor extensions.
- **Full end-to-end automation with Auto-approve enabled:**
  - Fixed command chain auto-approval (`isCommandAutoApproved` and `permissions.ts`): safe directory navigation (`cd <dir> && ...`), leading environment assignments (`FOO=bar ...`), shell wrappers (`nohup`, `time`, `nice`, `stdbuf`, `timeout`), heredoc bodies (`cat << 'EOF'`), and standard dev/build/test prefixes (`pytest`, `cargo`, `go`, `tsc`, `eslint`, `ruff`, `vitest`, `jest`, `make`, `cmake`, `gradle`, `mvn`, `dotnet`, `composer`, `bundle`, `rake`, `uv`, `poetry`, `pip`) now auto-approve cleanly while still blocking dangerous subcommands (`$(...)`, backticks, `rm -rf`, `sudo`, `git push --force`, `git reset --hard`, `find -exec/-delete`).
  - Added an **Allow all commands (`*`)** toggle directly in the Auto-approve popover and Settings view, and ensured changing Auto-approve or Permission Mode settings immediately unblocks a waiting task via `recheckPendingApproval()`.
  - Fixed false-positive secret prompts (`*.key`, `.env`) when a command writes code accessing `.key` properties inside heredocs / inline scripts or mentions `.env` in a `git commit -m` message.
  - Fixed Cyrillic mid-task text replies (`Сейчас я проверю...`) failing to trigger the automatic continuation reminder due to ASCII-only `\b` word boundaries, and forced continuation when `todos` still have pending items.
  - Respected `.perplexicode/settings.json` `permissions.defaultMode` in the VS Code extension when the IDE permission mode is `default`.
  - Fixed settings inputs in the webview losing focus or resetting while typing when background state updates arrive.

## [3.1.0] - 2026-11-03

### Added
- **Agents, Skills & Presets view** (view title button and command **PerplexiCode: Agents, Skills & Presets**). It has three tabs with a filter:
  - Installed items, which you can open, delete or use to start a task.
  - A built-in catalog with **Project** / **Global** install and **Install all**.
  - Forms for creating your own subagents, skills and presets.
- **Catalog**: 8 subagents (`code-reviewer`, `test-writer`, `debugger`, `security-auditor`, `docs-writer`, `refactorer`, `explorer`, `planner`) and 8 skills (`commit-message`, `code-review-checklist`, `write-tests`, `security-audit`, `debug-playbook`, `api-design`, `release-checklist`, `readme-writer`). They are written as standard `.perplexicode/agents/*.md` and `.perplexicode/skills/*/SKILL.md` files.
- **Task presets**: 10 built-in presets that each set the mode, the subagent and a `{{input}}` prompt template. If a required subagent or skill is missing, it is offered for install on the first run. Your own presets are read from `~/.perplexicode/presets.json`, the `perplexicodeKilo.taskPresets` setting and `.perplexicode/presets.json`, in that order.
- **Welcome screen**: a Quick start preset grid and a "N subagents · M skills" strip with **Install starter pack**.
- **Mode menu**: a Subagents section. A task can now run as a subagent, using its prompt and tool list. The task header shows an `@agent` chip.
- **Composer**: the slash commands `/presets`, `/agents`, `/skills` and `/<preset-id>`, plus Preset / Agent chips.
- Command **PerplexiCode: Run Task Preset…**.
- CLI: `pcode agents add|catalog`, `pcode skills add|catalog`, `pcode presets`, and the `--preset <id>`, `--agent <name>` and `-g/--global` flags.
- Tests: 6 new core tests (33 total) and webview renders 12–20 with message assertions.

### Fixed
- **Duplicated todo list with Thinking models.** A model could draft `<update_todo_list>` inside `<thinking>` without closing it. The parser then joined the draft's opening tag to the real call's closing tag, so every item appeared twice and the text in between was lost. Tool calls inside `<thinking>` are now ignored. `parseTodos` also merges repeated items, keeping the first position and the most advanced status, and accepts numbered lists (`1. [ ] …`).

## [3.0.0] - 2026-11-03

### Added
- **Headless core** (`src/core/`, no `vscode` imports). The extension and the new CLI run on the same agent loop, tools, transport and journal. See [docs/CORE-3.0.md](docs/CORE-3.0.md).
- **`pcode` CLI** (`out/cli.js`, `bin: pcode`):
  - Interactive REPL with diff and command approvals (`y` / `n` / `a` / feedback) and slash commands `/mode`, `/permissions`, `/model`, `/compact`, `/clear`, `/agents`, `/skills`, `/status`, `/todos`, `/resume`.
  - Headless `-p` with `--output-format text|json|stream-json`.
  - Flags: `--permission-mode`, `--allowedTools`, `--disallowedTools`, `--max-turns` (`0` = no limit), `-c/--continue`, `-r/--resume`, `--provider perplexity|openai`, `--trust-project`.
  - Commands: `login` (hidden prompt, stdin, `PPLX_COOKIE` or `--browser`; tokens are never read from argv), `logout`, `accounts`, `sessions`, `models`, `agents`, `skills`, `doctor`.
- **Claude Code compatible configuration.** Layered `~/.claude`, `~/.perplexicode`, `.claude`, `.perplexicode` and `*.local.json` settings.
- **Permission rules and modes.**
  - Rules: `allow` / `ask` / `deny` with `Tool(specifier)`, Bash prefix and wildcard specifiers, and gitignore-style path globs.
  - Modes: `default`, `acceptEdits`, `plan`, `bypassPermissions`.
  - Built-in secret protection for `.env*`, keys, `id_rsa*`, `.ssh`, WireGuard configs, symlinks resolving to them, and Bash commands that read them.
  - VS Code: setting `perplexicodeKilo.agent.permissionMode` and command **PerplexiCode: Set Permission Mode**.
- **Hooks** for `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `SessionStart` and `SessionEnd`, using the Claude Code stdin / exit-code-2 / JSON contract. Project hooks need Workspace Trust in VS Code and trust or `--trust-project` in the CLI.
- **Verify before done.** `verify.command` runs before `attempt_completion` is accepted, and a failing check sends the agent back to fix it. Every task gets a status: verified, needs review, failed, blocked or no changes. The CLI exit code is 2 when the status is failed.
- **Subagents** from `.perplexicode/agents/*.md` and `.claude/agents/*.md`, each with its own prompt, model and an enforced tool list, called through `new_task`. **Skills** from `<dir>/<name>/SKILL.md`. **Memory** from `CLAUDE.md` and `PERPLEXICODE.md` with `@imports`.
- **Session journal** in `~/.perplexicode/sessions`:
  - Append-only JSONL (mode 0600) with redacted secrets, plus atomic snapshots.
  - IDE tasks can be resumed with `pcode -c` / `pcode -r`.
  - Commands with an unknown outcome after a crash are flagged, and the agent checks the real state before re-running them.
- **Read batching.** Up to 5 consecutive read-only tool calls from one answer run in one step (`readBatchSize`).
- **`/compact`**, also available as the VS Code command **PerplexiCode: Compact Current Task**.
- **OpenAI-compatible transport** (`--provider openai`) for Ollama, LM Studio, vLLM and similar servers, with SSE streaming.
- **PerplexiCode: Share Accounts with CLI** copies the extension's accounts to `~/.perplexicode/credentials.json` (mode 0600) after a confirmation.
- `examples/claude-code-compat` with settings, a guard hook, two subagents, a skill and `CLAUDE.md`.
- `test/core.test.ts`: 27 tests, including real `sh` hooks, a mock OpenAI server and end-to-end `pcode -p` runs. CI runs a CLI smoke test.

### Changed
- `new_task` accepts subagent names in addition to mode slugs.
- The system prompt allows up to 5 read-only tools per answer.
- Settings and auto-approve behave as in 2.x unless a rule or mode decides.

## [2.1.0] - 2026-10-28

### Changed
- New extension ID `MRX7999.perplexicode-kilo` and name **PerplexiCode Kilo**, published to [Open VSX](https://open-vsx.org/extension/MRX7999/perplexicode-kilo) under the `MRX7999` namespace. Commands, views and settings moved from `perplexicode.*` to `perplexicodeKilo.*`.
- New logo (extension icon, activity bar icon, welcome and About screens).

### Added
- Account import from the old `perplexicode.perplexicode` extension. A bundled helper ([bridge](bridge/extension.js)) takes over the old ID and copies sessions, CSRF tokens, cookies and the rotation strategy after a confirmation dialog. User settings `perplexicode.*` are copied to `perplexicodeKilo.*`. Command: **PerplexiCode: Import Accounts from PerplexiCode 1.x**.

### Fixed
- Auto-approve checkboxes and other settings failed with `Unable to write to User Settings because … is not a registered configuration` when the extension was updated without reloading the window. The value is now kept by the extension, applied immediately and moved into User Settings after the reload. The UI always resyncs to the saved value.

## [2.0.1] - 2026-10-28

### Added
- One-line installers for Antigravity IDE, VS Code, Cursor and Windsurf: `scripts/install.sh` (macOS / Linux) and `scripts/install.ps1` (Windows).
- GitHub Actions: CI (type check, tests, VSIX artifact) and tag-driven releases with `perplexicode-kilo.vsix`, versioned VSIX and `SHA256SUMS.txt`; optional publishing to Open VSX and the VS Code Marketplace.
- Marketplace metadata: homepage, issues, gallery banner, changelog.

### Fixed
- Models that Perplexity lists under a duplicate label (for example two "Claude Sonnet 4.0 Thinking" ids) now show their id in **More models**, so every entry is distinguishable.

## [2.0.0] - 2026-10-28

### Added
- Kilo Code-style agent loop with XML tools: `read_file`, `list_files`, `search_files`, `list_code_definition_names`, `apply_diff`, `write_to_file`, `insert_content`, `execute_command`, `ask_followup_question`, `attempt_completion`, `switch_mode`, `new_task`, `update_todo_list`.
- Modes: Code, Architect, Ask, Debug, Orchestrator, Review, with per-mode tool groups.
- Save / Reject approvals with inline diffs, Run / Reject for commands, granular auto-approve with allow / deny command prefixes and a request limit.
- SEARCH/REPLACE diff engine (exact, whitespace-tolerant and fuzzy matching) and per-edit checkpoints with restore.
- `@` mentions for files, folders, `@problems`, `@git-changes`, `@selection`; Explain / Fix / Improve / Add to Context editor actions and quick fixes; terminal selection to context; commit message generation.
- Workspace rules from `AGENTS.md`, `.kilocode/rules`, `.roo/rules`, `.clinerules`, `~/.kilocode/rules`.
- New webview: task header with todo progress, streaming Markdown, reasoning blocks, tool cards, follow-up suggestions, prompt enhancer, history, settings, open in editor tab.
- Current Perplexity model list (Best, GPT-6.1 Sol, GPT-6 Astra, Gemini 4 Argon, Gemini 3.8 Flash, Claude Sonnet 5.5, Claude Opus 5.5, Claude Fable 5.1, Kimi K3, GLM 5.3, Grok 4.7, Nemotron 3.5 Super VL and 77 more), Thinking toggle, Max plan locking with fallback to Best.
- Transport: thread follow-ups, self-contained resend on failure, retry with web sources, account failover.

### Changed
- Same extension ID and storage keys as 1.x: installing over 1.0.x keeps signed-in accounts.

### Removed
- Labs / Computer / Research task modes and chat image attachments from 1.x.

## [1.0.5] - upstream

Original release by [yuki-20/PerplexiCode](https://github.com/yuki-20/PerplexiCode/releases/tag/v1.0.5).

[2.0.1]: https://github.com/MRX7999/PerplexiCode-Kilo/releases/tag/v2.0.1
[2.0.0]: https://github.com/MRX7999/PerplexiCode-Kilo/compare/a092d50...v2.0.0
[1.0.5]: https://github.com/yuki-20/PerplexiCode/releases/tag/v1.0.5
