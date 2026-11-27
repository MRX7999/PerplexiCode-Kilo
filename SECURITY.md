# Security Policy & Threat Model

PerplexiCode Kilo stores authenticated sessions for paid Perplexity accounts and executes local file edits, shell commands, HTTP fetches, and MCP tool calls. Security controls therefore take precedence over unattended automation.

## Assets & Trust Boundaries

| Asset / Boundary | Storage / Surface | Trust Level |
| --- | --- | --- |
| **Perplexity session cookies & CSRF tokens** | VS Code `SecretStorage` in IDE; `~/.perplexicode/credentials.json` (`0600`) in CLI | Trusted secret — never sent to third parties, logs, journals, or diagnostics |
| **MCP server tokens** | VS Code `SecretStorage` bound to `(file, server, configHash)` or process environment | Trusted secret — never written as plaintext by catalog installers |
| **User & global settings** | `~/.perplexicode/settings.json`, `~/.claude/settings.json`, VS Code user settings | Trusted user configuration |
| **Workspace repository contents** | Source files, `AGENTS.md`, `.clinerules`, issues, diffs, test fixtures | **Untrusted input** with respect to prompt injection; project hooks & stdio MCP require explicit Workspace Trust |
| **External network content** | `web_fetch` targets, Perplexity web citations, remote MCP responses | **Untrusted input** |

## Threat Model & Mitigations

### 1. Prompt Injection → Agent Config / Hook Tampering (Self-Escalation)
- **Threat:** Untrusted text in a repository file, web page, or MCP tool response instructs the model to add an `allow` rule, register a `PreToolUse`/`Stop` shell hook, or add a malicious stdio server in `.perplexicode/settings.json`, `hooks`, `.mcp.json`, or `.claude/`.
- **Mitigation (F09):**
  - Writing (`write_to_file`, `apply_diff`, `insert_content`, `search_and_replace`) or running shell commands referencing `.perplexicode/settings*.json`, `.perplexicode/hooks/**`, `hooks/**`, `.mcp*.json`, `.perplexicode/mcp.json`, `.claude/**`, or `~/.claude.json` **always requires explicit human confirmation**, even when `autoApprove.write`, `acceptEdits`, or `bypassPermissions` (`--dangerously-skip-permissions`) is enabled.
  - Project-level hooks and project-scoped stdio MCP servers do not execute unless the workspace is explicitly trusted (VS Code Workspace Trust or `pcode --trust-project`).

### 2. Shell Allowlist Evasion & Command Injection
- **Threat:** Bypassing `allowedCommands` / `Bash(prefix:*)` rules via command separators (`;`, `&&`, `||`, `|`, `&`, newlines), nested shells (`bash -c`, `sh -c`, `zsh -c`), environment/wrapper prefixes (`env VAR=1`, `command`, `nohup`, `timeout`), command substitutions (`$(...)`, `` `...` ``, `<(...)`), or malformed quoting.
- **Mitigation (F06):**
  - Shell strings are tokenized into individual segments (`src/agent/shellParser.ts`).
  - Wrappers (`env VAR=…`, `nice`, `timeout`, etc.) are unwrapped before matching, and `sh -c` / `bash -c` inner scripts are recursively parsed into segments.
  - Every segment must independently pass `deny` and `allow` checks; a single denied segment denies the entire command, and any unparseable syntax, command substitution, `eval`, or shell redirection into non-`/dev/null` targets forces interactive confirmation.

### 3. Server-Side Request Forgery (SSRF) in `web_fetch`
- **Threat:** Prompt injection causes `web_fetch` to probe localhost services, internal RFC1918 networks, IPv6 link-local hosts, or cloud instance metadata endpoints (`169.254.169.254`), either directly or via HTTP `30x` open redirects / DNS resolution to internal IPs.
- **Mitigation (F05):**
  - `web_fetch` resolves hostnames via DNS before connecting and validates **every** returned IPv4/IPv6 address (including IPv4-mapped IPv6 `::ffff:x.x.x.x` and `6to4`) against blocked ranges: loopback (`127.0.0.0/8`, `::1`), private (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local & cloud metadata (`169.254.0.0/16`, `fe80::/10`, `metadata.google.internal`), CGNAT (`100.64.0.0/10`), ULA (`fc00::/7`), multicast, and unspecified (`0.0.0.0/8`, `::`).
  - Automatic HTTP redirect following is disabled; each `301/302/303/307/308` hop re-runs URL and DNS/IP SSRF validation and pins the resolved IP on the outbound socket to prevent DNS rebinding between check and connect.

### 4. Secret Files & Credential Leakage in Logs, Journals, and Diagnostics
- **Threat:** Session cookies (`__Secure-next-auth.session-token`), `x-csrf-token`, `Authorization` headers, `.env` secrets, SSH/PGP keys, prompts, or proprietary code leak into append-only session journals (`~/.perplexicode/sessions`), test fixtures, or shared bug reports.
- **Mitigation (F08 & Core Policy):**
  - Secret file patterns (`.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `.npmrc`, `.netrc`, `credentials.json`) are protected by default in `permissions.protectSecrets`.
  - `scrubSecrets()` strips cookies, CSRF tokens, bearer/API tokens, and sensitive HTTP headers before writing any event into `SessionJournal`.
  - `pcode doctor --bundle` and **Скопировать диагностику** export only versions, stage timings, tool categories, and rule verdicts — never cookies, headers, prompts, file paths/code, or terminal output — and always show a full preview before export/copy.

### 5. Supply-Chain Integrity of VSIX Installers & Interrupted Execution
- **Threat:** Corrupted or tampered release assets during CLI-driven VSIX installation; duplicate file edits or duplicate shell executions after SSE chunk replays or mid-stream network drops.
- **Mitigation (F01, F02, F07):**
  - `scripts/install.sh` and `scripts/install.ps1` download `SHA256SUMS.txt` from the matching GitHub Release, verify the SHA-256 digest of `perplexicode-kilo.vsix`, and abort with a non-zero exit status on mismatch before running any editor CLI.
  - SSE frame parsing deduplicates repeated terminal chunks and aborts cleanly on mid-tool-call stream truncation.
  - Commands interrupted before recording an exit code are marked `результат не подтверждён` in the journal; on resume, blind re-execution of the unconfirmed command is blocked until workspace state is inspected.

## Reporting a Vulnerability

Please report security vulnerabilities privately via [GitHub Security Advisories](https://github.com/MRX7999/PerplexiCode-Kilo/security/advisories/new) rather than opening a public issue with exploit details. Include reproduction steps, affected version (`pcode --version`), and redacted `pcode doctor --bundle` output if applicable.
