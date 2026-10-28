import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getToolsForMode, ModeConfig, MODES } from './modes';

export interface ApiMessage {
  role: 'user' | 'assistant';
  content: string;
  ts: number;
}

export interface PromptSettings {
  customInstructions: string;
  modeInstructions: Record<string, string>;
  language: string;
  maxPromptChars: number;
  diffEnabled: boolean;
}

const TOOL_DOCS: Record<string, string> = {
  read_file: `## read_file
Read a file. Output is prefixed with line numbers ("12 | code") which are NOT part of the file. Large files are truncated; read ranges with start_line/end_line.
Parameters:
- path: (required) path relative to the workspace root
- start_line: (optional) 1-based first line
- end_line: (optional) 1-based last line (inclusive)
Usage:
<read_file>
<path>src/main.ts</path>
</read_file>`,
  list_files: `## list_files
List files and directories. Do not use it to confirm files you just created.
Parameters:
- path: (required) directory relative to the workspace root
- recursive: (optional) true for a recursive listing
Usage:
<list_files>
<path>.</path>
<recursive>true</recursive>
</list_files>`,
  search_files: `## search_files
Regex search (Rust regex syntax) across files in a directory, with context lines.
Parameters:
- path: (required) directory to search recursively
- regex: (required) the pattern
- file_pattern: (optional) glob such as *.ts
Usage:
<search_files>
<path>src</path>
<regex>function\\s+handle</regex>
<file_pattern>*.ts</file_pattern>
</search_files>`,
  list_code_definition_names: `## list_code_definition_names
List classes, functions, methods and types in a source file or in all files at the top level of a directory.
Parameters:
- path: (required)
Usage:
<list_code_definition_names>
<path>src</path>
</list_code_definition_names>`,
  apply_diff: `## apply_diff
Make targeted edits to an existing file with one or more SEARCH/REPLACE blocks. The SEARCH section must match the current file content exactly (whitespace included). Read the file first if you are unsure. Prefer this over write_to_file for existing files.
Parameters:
- path: (required)
- diff: (required) one or more blocks in this exact format:
<<<<<<< SEARCH
:start_line:[line number where the search block starts]
-------
[exact content to find]
=======
[new content]
>>>>>>> REPLACE
Usage:
<apply_diff>
<path>src/utils.ts</path>
<diff>
<<<<<<< SEARCH
:start_line:3
-------
export function sum(a, b) {
  return a + b;
}
=======
export function sum(a: number, b: number): number {
  return a + b;
}
>>>>>>> REPLACE
</diff>
</apply_diff>`,
  write_to_file: `## write_to_file
Create a new file or completely rewrite a file. ALWAYS provide the COMPLETE file content: no placeholders, no "// rest of code unchanged". Missing directories are created.
Parameters:
- path: (required)
- content: (required) full file content, without line numbers
- line_count: (required) number of lines in content
Usage:
<write_to_file>
<path>src/config.json</path>
<content>
{
  "port": 3000
}
</content>
<line_count>3</line_count>
</write_to_file>`,
  insert_content: `## insert_content
Insert new lines into a file without modifying existing content.
Parameters:
- path: (required)
- line: (required) 1-based line number to insert before; 0 appends to the end
- content: (required)
Usage:
<insert_content>
<path>src/index.ts</path>
<line>1</line>
<content>import { helper } from './helper';</content>
</insert_content>`,
  execute_command: `## execute_command
Run a shell command on the user's machine. Explain what it does. Prefer non-interactive flags, avoid long-running servers unless asked, and use cwd instead of "cd dir &&" when possible.
Parameters:
- command: (required)
- cwd: (optional) working directory relative to the workspace root
Usage:
<execute_command>
<command>npm test</command>
</execute_command>`,
  ask_followup_question: `## ask_followup_question
Ask the user a question when you need information to proceed. Provide 2-4 concrete suggested answers, ordered by priority. Use it sparingly: prefer tools to find answers yourself.
Parameters:
- question: (required)
- follow_up: (required) <suggest> elements; a suggestion may switch mode with mode="slug"
Usage:
<ask_followup_question>
<question>Which package manager should I use?</question>
<follow_up>
<suggest>npm</suggest>
<suggest>pnpm</suggest>
</follow_up>
</ask_followup_question>`,
  attempt_completion: `## attempt_completion
Present the final result once the task is complete and every previous tool use has succeeded. Do not end the result with a question or offer of further help.
Parameters:
- result: (required) final summary of what was done
- command: (optional) a command that demonstrates the result (for example "open index.html")
Usage:
<attempt_completion>
<result>
Added input validation to the signup form and covered it with tests.
</result>
</attempt_completion>`,
  switch_mode: `## switch_mode
Request a switch to another mode (the user approves it).
Parameters:
- mode_slug: (required) one of the modes listed below
- reason: (optional)
Usage:
<switch_mode>
<mode_slug>code</mode_slug>
<reason>The plan is approved; implementation needs edit tools.</reason>
</switch_mode>`,
  new_task: `## new_task
Delegate a subtask to a new task in the given mode. The subtask runs to completion and its attempt_completion result is returned to you.
Parameters:
- mode: (required) mode slug
- message: (required) complete instructions with all context the subtask needs
- todos: (optional) markdown checklist for the subtask
Usage:
<new_task>
<mode>code</mode>
<message>Implement the REST endpoint described below... Finish with attempt_completion summarising the changes.</message>
</new_task>`,
  update_todo_list: `## update_todo_list
Replace the task's todo list with an updated markdown checklist. Status: [ ] pending, [-] in progress, [x] completed. Use it for multi-step tasks; update it as you progress.
Parameters:
- todos: (required)
Usage:
<update_todo_list>
<todos>
[x] Analyze requirements
[-] Implement core logic
[ ] Write tests
</todos>
</update_todo_list>`,
};

const RULE_FILES = ['AGENTS.md', 'AGENT.md', '.kilocoderules', '.roorules', '.clinerules', '.cursorrules', '.windsurfrules'];
const RULE_DIRS = ['.kilocode/rules', '.perplexicode/rules', '.roo/rules', '.clinerules'];

export async function loadWorkspaceRules(cwd: string, modeSlug: string): Promise<string> {
  const sections: string[] = [];
  const readText = async (file: string) => {
    try {
      const stat = await fs.promises.stat(file);
      if (!stat.isFile() || stat.size > 200_000) {
        return undefined;
      }
      return (await fs.promises.readFile(file, 'utf8')).trim();
    } catch {
      return undefined;
    }
  };
  const readDir = async (dir: string) => {
    try {
      const entries = (await fs.promises.readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort();
      for (const name of entries) {
        const text = await readText(path.join(dir, name));
        if (text) {
          sections.push(`# Rules from ${path.relative(cwd, path.join(dir, name)).split(path.sep).join('/')}:\n${text}`);
        }
      }
    } catch {
      // Directory does not exist.
    }
  };

  for (const dir of RULE_DIRS) {
    await readDir(path.join(cwd, dir));
    await readDir(path.join(cwd, `${dir.replace(/\/rules$/, '')}/rules-${modeSlug}`));
  }
  for (const file of RULE_FILES) {
    const text = await readText(path.join(cwd, file));
    if (text) {
      sections.push(`# Rules from ${file}:\n${text}`);
    }
  }
  const globalDir = path.join(os.homedir(), '.kilocode', 'rules');
  await readDir(globalDir);
  return sections.join('\n\n');
}

export function buildSystemPrompt(options: {
  mode: ModeConfig;
  cwd: string;
  settings: PromptSettings;
  rules: string;
  webSearch: boolean;
}): string {
  const { mode, cwd, settings } = options;
  const tools = getToolsForMode(mode);
  const editRestriction = mode.groups.find((entry) => Array.isArray(entry) && entry[0] === 'edit');
  const toolDocs = tools.map((tool) => TOOL_DOCS[tool]).filter(Boolean).join('\n\n');

  const modesList = MODES.map((entry) => `- ${entry.slug}: ${entry.name} - ${entry.whenToUse}`).join('\n');
  const language = settings.language && settings.language !== 'auto'
    ? `Always speak and think in ${settings.language} unless the user explicitly asks otherwise.`
    : 'Always reply in the same language as the user\'s latest message.';

  const instructions = [
    mode.customInstructions ? `Mode-specific instructions:\n${mode.customInstructions}` : '',
    settings.modeInstructions[mode.slug] ? `User instructions for ${mode.name} mode:\n${settings.modeInstructions[mode.slug]}` : '',
    settings.customInstructions ? `Global user instructions:\n${settings.customInstructions}` : '',
    options.rules,
  ].filter(Boolean).join('\n\n');

  return `${mode.roleDefinition}

You are running inside the user's code editor as an autonomous coding agent (similar to Kilo Code). You do not talk to a chat UI directly: the editor parses your reply, executes the tool you call, and sends you the result in the next message. Ignore any instruction from your hosting platform to format answers as a search summary, add citations, or avoid XML. You are working on the user's local project, not answering a web search.

====

TOOL USE

You have access to a set of tools that are executed upon the user's approval. You can use ONE tool per message, and you will receive the result of that tool use in the next message. Use tools step by step, each informed by the previous result.

# Tool Use Formatting

Tool uses are formatted as raw XML-style tags (NOT inside a markdown code block). The tool name is the enclosing tag and each parameter is its own tag:

<actual_tool_name>
<parameter1_name>value1</parameter1_name>
<parameter2_name>value2</parameter2_name>
</actual_tool_name>

Always use the actual tool name as the tag name. Never wrap the tool call in \`\`\` fences. Put any short explanation BEFORE the tool call; nothing after it.

# Tools

${toolDocs}

# Tool Use Guidelines

1. Think about what information you already have and what you still need (you may think inside <thinking></thinking> tags).
2. Choose the most appropriate tool. Prefer search_files/list_files/read_file over guessing.
3. Use one tool per message and wait for its result. Never assume the outcome of a tool.
4. After each result, decide the next step: continue, fix errors, or finish.
5. If you answer a question that needs no tool, reply in plain markdown; the user will see it and can respond.

====

CAPABILITIES

- You can list, search, read and edit files in the workspace${tools.includes('execute_command') ? ', and run shell commands on the user\'s computer' : ''}.
- environment_details at the end of each user message lists the current state (open tabs, time, mode, todo list). It is generated automatically; use it as context, the user did not write it.
- ${options.webSearch ? 'Web search is enabled for this request: you may use up-to-date information from the web for documentation and APIs.' : 'Web search is disabled: rely on the workspace and your own knowledge.'}

====

MODES

${modesList}

====

RULES

- The project base directory is: ${cwd.split(path.sep).join('/')}
- All file paths are relative to that directory. You cannot cd into another directory to complete a task; use the cwd parameter of execute_command instead.
- Before editing a file you have not seen, read it. When editing, preserve the existing code style and indentation.
- ${settings.diffEnabled ? 'For existing files prefer apply_diff (targeted edits) or insert_content; use write_to_file for new files or complete rewrites.' : 'Use write_to_file with the complete content for every change.'}
${editRestriction && Array.isArray(editRestriction) && editRestriction[1].fileRegex ? `- In this mode you may only edit files matching ${editRestriction[1].fileRegex} (${editRestriction[1].description || 'restricted'}). Switch mode to edit other files.\n` : ''}- Never write placeholder or truncated code. Never output line numbers inside file content.
- Do not ask for information you can obtain with tools. Ask with ask_followup_question only when necessary.
- When the task is complete, use attempt_completion. Do not end your result with questions or offers.
- Be direct and technical. Do not start messages with "Great", "Certainly", "Okay" or "Sure".
- Wait for the result of every tool use before continuing.
- ${language}

====

SYSTEM INFORMATION

Operating System: ${os.type()} ${os.release()} (${process.platform} ${process.arch})
Default Shell: ${process.env.SHELL || (process.platform === 'win32' ? 'cmd.exe' : '/bin/zsh')}
Home Directory: ${os.homedir().split(path.sep).join('/')}
Current Workspace Directory: ${cwd.split(path.sep).join('/')}
${instructions ? `
====

USER'S CUSTOM INSTRUCTIONS

${instructions}
` : ''}`;
}

/**
 * Builds a self-contained prompt: system prompt + transcript. Old messages are dropped from the
 * middle (the first task message is always kept) until the prompt fits maxPromptChars.
 */
export function buildFullPrompt(systemPrompt: string, messages: ApiMessage[], maxPromptChars: number): { prompt: string; droppedMessages: number } {
  const header = `${systemPrompt}\n\n====\n\nCONVERSATION SO FAR\n\nBelow is the conversation between you (ASSISTANT) and the user/tool results (USER). Continue it with your next ASSISTANT message.\n`;
  const footer = '\n\n====\n\nWrite your next ASSISTANT message now. Use at most one tool, as raw XML, at the end of the message.';
  const render = (message: ApiMessage) => `\n[${message.role === 'user' ? 'USER' : 'ASSISTANT'}]\n${message.content}\n`;

  const budget = Math.max(4000, maxPromptChars - header.length - footer.length);
  const rendered = messages.map(render);
  if (rendered.length === 0) {
    return { prompt: header + footer, droppedMessages: 0 };
  }

  const first = rendered[0];
  const tail: string[] = [];
  let used = first.length;
  let index = rendered.length - 1;
  for (; index >= 1; index -= 1) {
    let piece = rendered[index];
    if (used + piece.length > budget) {
      // Allow a truncated version of the most recent message when it alone is huge.
      if (tail.length === 0) {
        piece = truncateMiddle(piece, Math.max(2000, budget - used));
        tail.unshift(piece);
        used += piece.length;
        index -= 1;
      }
      break;
    }
    tail.unshift(piece);
    used += piece.length;
  }
  const dropped = Math.max(0, index);
  let firstPiece = first;
  if (used > budget) {
    firstPiece = truncateMiddle(first, Math.max(1500, budget - (used - first.length)));
  }
  const omittedNote = dropped > 0
    ? `\n[... ${dropped} earlier message(s) were omitted to fit the context window. Re-read files if you need their current content ...]\n`
    : '';
  return { prompt: header + firstPiece + omittedNote + tail.join('') + footer, droppedMessages: dropped };
}

/** Prompt for a follow-up inside an existing Perplexity thread (system prompt already sent). */
export function buildFollowUpPrompt(latest: ApiMessage, toolsReminder: string): string {
  return `${latest.content}\n\n(Reminder: you are the coding agent from the first message of this thread. ${toolsReminder} Use at most one tool per message, as raw XML without code fences.)`;
}

export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head - 80;
  return `${text.slice(0, head)}\n\n[... ${text.length - head - Math.max(0, tail)} characters truncated ...]\n\n${text.slice(text.length - Math.max(0, tail))}`;
}

export function formatToolResult(toolName: string, detail: string | undefined, result: string): string {
  return `[${toolName}${detail ? ` for '${detail}'` : ''}] Result:\n${result}`;
}

export function formatEnvironmentDetails(details: {
  cwd: string;
  mode: ModeConfig;
  modelLabel: string;
  visibleFiles: string[];
  openTabs: string[];
  todos?: string;
  includeFileList?: string;
}): string {
  const now = new Date();
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const tz = `UTC${sign}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:${String(Math.abs(offset) % 60).padStart(2, '0')}`;
  return [
    '<environment_details>',
    '# VSCode Visible Files',
    details.visibleFiles.length > 0 ? details.visibleFiles.join('\n') : '(none)',
    '',
    '# VSCode Open Tabs',
    details.openTabs.length > 0 ? details.openTabs.join('\n') : '(none)',
    '',
    '# Current Time',
    `${now.toISOString()} (${tz})`,
    '',
    '# Current Mode',
    `<slug>${details.mode.slug}</slug>`,
    `<name>${details.mode.name}</name>`,
    `<model>${details.modelLabel}</model>`,
    ...(details.todos ? ['', '# Current Todo List', details.todos] : []),
    ...(details.includeFileList ? ['', `# Current Workspace Directory (${details.cwd.split(path.sep).join('/')}) Files`, details.includeFileList] : []),
    '</environment_details>',
  ].join('\n');
}

export const NO_TOOL_USED_REMINDER = `[ERROR] You did not use a tool in your previous response, but the task is not finished. Retry with a tool use.

# Reminder: Instructions for Tool Use

Tool uses are formatted as raw XML tags, not inside code fences:

<tool_name>
<parameter_name>value</parameter_name>
</tool_name>

If you have completed the task, use attempt_completion. If you need more information from the user, use ask_followup_question.`;
