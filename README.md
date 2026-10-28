# PerplexiCode — Kilo Edition

Fork of [yuki-20/PerplexiCode](https://github.com/yuki-20/PerplexiCode) that turns the Perplexity chat sidebar into a Kilo Code-style autonomous coding agent and brings the model list up to date with the current Perplexity Pro / Max picker.

Форк [yuki-20/PerplexiCode](https://github.com/yuki-20/PerplexiCode): боковая панель стала агентом в стиле Kilo Code, список моделей обновлён под актуальный выбор Perplexity Pro / Max. Описание на русском — ниже.

## What changed in 2.0

- **Agent loop like Kilo Code**: the model works through XML tools (`read_file`, `list_files`, `search_files`, `list_code_definition_names`, `apply_diff`, `write_to_file`, `insert_content`, `execute_command`, `ask_followup_question`, `attempt_completion`, `switch_mode`, `new_task`, `update_todo_list`), one tool per step, with results fed back automatically.
- **Modes**: Code, Architect, Ask, Debug, Orchestrator (subtasks), Review. Per-mode tool groups (Ask cannot edit, Architect edits only Markdown).
- **Approvals and auto-approve**: Save / Reject for edits, Run / Reject for commands, auto-approve toggles (read, write, commands with allow/deny prefixes, mode switches, subtasks, todo, retry), request limit.
- **Diffs and checkpoints**: SEARCH/REPLACE edits with exact → whitespace-tolerant → fuzzy matching, inline diff preview with +/− stats, a checkpoint per edit with one-click restore.
- **Context**: `@/path` files and folders, `@problems`, `@git-changes`, `@selection`; editor actions Explain / Fix / Improve / Add to context (context menu, lightbulb quick fixes, `Cmd+K Cmd+A`); terminal selection to context; workspace rules from `AGENTS.md`, `.kilocode/rules`, `.roo/rules`, `.clinerules`, `~/.kilocode/rules`.
- **UI**: task header with todo list and progress, streaming markdown with code-block copy/insert, reasoning blocks, tool cards, terminal output, follow-up suggestions, prompt enhancer, task history with search/export, settings view (accounts, models, auto-approve, terminal, context, prompts), open in editor tab, SCM commit message generation.
- **Models**: bundled snapshot of Perplexity `rest/models/config` (89 models): Best, GPT-6.1 Sol, GPT-6 Astra (Max), Gemini 4 Argon (Max), Gemini 3.8 Flash, Claude Sonnet 5.5, Claude Opus 5.5 (Max), Claude Fable 5.1 (Max), Kimi K3, GLM 5.3, Grok 4.7, Nemotron 3.5 Super VL, plus 77 under **More models**. Thinking toggle where supported. When an account reports a live model config it takes priority over the snapshot.
- **Accounts**: same extension ID (`perplexicode.perplexicode`) and storage keys as 1.x, so installing 2.0 over 1.0.x keeps signed-in accounts. `perplexicode.subscriptionPlan` can force Pro/Max when detection is wrong.
- **Transport**: Perplexity thread follow-ups when possible, full self-contained prompt on failure, retries with web sources if an empty source list is rejected, account failover, thinking → normal and Max → Best fallbacks.

Removed from 1.x: Labs / Computer / Research task modes and image attachments in the chat.

## Install / update

```bash
npm ci
npm run build
npx @vscode/vsce package          # creates perplexicode-2.0.0.vsix
code --install-extension perplexicode-2.0.0.vsix --force
# Antigravity on macOS:
"/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide" --install-extension perplexicode-2.0.0.vsix --force
```

Reload the window afterwards. Sign in (if you have no 1.x accounts) with **PerplexiCode: Add Perplexity Account** → Manual Paste of the `perplexity.ai` Cookie header, as in the original project.

## Tests

```bash
npm run lint          # extension + webview type check
npm test              # parser, diff engine, tools, models, agent loop with a scripted model, transport fallbacks
npm run test:webview  # renders the webview in headless Chromium (needs a Playwright Chromium in ~/.cache/ms-playwright)
```

## Русский

Что это: агент для VS Code / Antigravity в духе Kilo Code, который работает через вашу подписку Perplexity (без API-ключей) и последние модели из Max.

- Режимы Code / Architect / Ask / Debug / Orchestrator / Review, инструменты чтения, поиска, правок (diff), команд терминала, вопросов и завершения задачи.
- Подтверждения Save / Reject и Run / Reject, автоодобрение с белым и чёрным списком команд, чекпоинты с откатом каждой правки.
- `@`-упоминания файлов, папок, `@problems`, `@git-changes`, `@selection`; действия в редакторе Explain / Fix / Improve / Add to context; генерация commit message.
- Модели: актуальный список Perplexity (12 в основном списке + 77 в More models), Max-модели помечены и разблокируются для Max-аккаунтов.
- Аккаунты из версии 1.x переносятся автоматически: ID расширения и ключи хранения не менялись.

## License

MIT, see [LICENSE](LICENSE). Original work © yuki-20.
