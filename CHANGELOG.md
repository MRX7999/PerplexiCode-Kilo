# Changelog

All notable changes to PerplexiCode Kilo. Versions follow [Semantic Versioning](https://semver.org/).

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
