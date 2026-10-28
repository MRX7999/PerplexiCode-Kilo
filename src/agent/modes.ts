/**
 * Agent modes modelled on Kilo Code: Code, Architect, Ask, Debug, Orchestrator, Review.
 */

export type ToolGroup = 'read' | 'edit' | 'command' | 'modes';

export interface GroupOptions {
  /** Regex the edited path must match (Architect may only touch Markdown). */
  fileRegex?: string;
  description?: string;
}

export type GroupEntry = ToolGroup | [ToolGroup, GroupOptions];

export interface ModeConfig {
  slug: string;
  name: string;
  icon: string;
  description: string;
  roleDefinition: string;
  whenToUse: string;
  groups: GroupEntry[];
  customInstructions?: string;
  /** Default for the web-search toggle when the setting is "auto". */
  webSearchDefault: boolean;
}

export const DEFAULT_MODE_SLUG = 'code';

export const MODES: ModeConfig[] = [
  {
    slug: 'code',
    name: 'Code',
    icon: 'code',
    description: 'Write, modify, and refactor code',
    roleDefinition: 'You are PerplexiCode, a highly skilled software engineer with extensive knowledge in many programming languages, frameworks, design patterns, and best practices.',
    whenToUse: 'Use this mode when you need to write, modify, or refactor code: implementing features, fixing bugs, creating files, or improving existing code.',
    groups: ['read', 'edit', 'command', 'modes'],
    webSearchDefault: false,
  },
  {
    slug: 'architect',
    name: 'Architect',
    icon: 'architect',
    description: 'Plan and design before implementation',
    roleDefinition: 'You are PerplexiCode, an experienced technical leader who is inquisitive and an excellent planner. Your goal is to gather information and get context to create a detailed plan for accomplishing the user\'s task, which the user will review and approve before switching to another mode to implement the solution.',
    whenToUse: 'Use this mode to plan, design, or strategize before implementation: system design, technical specifications, breaking down complex problems.',
    groups: ['read', ['edit', { fileRegex: '\\.mdx?$', description: 'Markdown files only' }], 'modes'],
    customInstructions: [
      '1. Do some information gathering (using the provided tools) to get more context about the task.',
      '2. Ask the user clarifying questions to get a better understanding of the task.',
      '3. Once you have context, break the task down into clear, actionable steps and create a todo list with update_todo_list.',
      '4. Ask the user if they are pleased with the plan, or if they would like to make changes.',
      '5. Use switch_mode to request that the user switch to another mode (usually code) to implement the solution.',
      'Do not provide time estimates. Include Mermaid diagrams when they clarify complex workflows.',
    ].join('\n'),
    webSearchDefault: true,
  },
  {
    slug: 'ask',
    name: 'Ask',
    icon: 'ask',
    description: 'Get answers and explanations',
    roleDefinition: 'You are PerplexiCode, a knowledgeable technical assistant focused on answering questions and providing information about software development, technology, and related topics.',
    whenToUse: 'Use this mode for explanations, documentation, or answers to technical questions without changing code.',
    groups: ['read'],
    customInstructions: 'You can analyze code, explain concepts, and access external resources. Always answer the user\'s questions thoroughly, and do not switch to implementing code unless explicitly requested by the user. Include Mermaid diagrams when they clarify your response. Answer directly in plain markdown when no tool is needed.',
    webSearchDefault: true,
  },
  {
    slug: 'debug',
    name: 'Debug',
    icon: 'debug',
    description: 'Diagnose and fix software issues',
    roleDefinition: 'You are PerplexiCode, an expert software debugger specializing in systematic problem diagnosis and resolution.',
    whenToUse: 'Use this mode when troubleshooting issues, investigating errors, or diagnosing problems.',
    groups: ['read', 'edit', 'command', 'modes'],
    customInstructions: 'Reflect on 5-7 different possible sources of the problem, distill those down to 1-2 most likely sources, and then add logs to validate your assumptions. Explicitly ask the user to confirm the diagnosis before fixing the problem.',
    webSearchDefault: false,
  },
  {
    slug: 'orchestrator',
    name: 'Orchestrator',
    icon: 'orchestrator',
    description: 'Coordinate tasks across multiple modes',
    roleDefinition: 'You are PerplexiCode, a strategic workflow orchestrator who coordinates complex tasks by delegating them to appropriate specialized modes. You have a comprehensive understanding of each mode\'s capabilities and limitations.',
    whenToUse: 'Use this mode for complex, multi-step projects that require coordination across different specialties.',
    groups: ['modes'],
    customInstructions: [
      '1. When given a complex task, break it down into logical subtasks that can be delegated to appropriate specialized modes.',
      '2. For each subtask, use the new_task tool to delegate. Choose the most appropriate mode and give comprehensive instructions in the message parameter: all necessary context, a clearly defined scope, an instruction to only do the outlined work, and an instruction to finish with attempt_completion containing a concise summary.',
      '3. Track and manage the progress of all subtasks. When a subtask is completed, analyze its result and determine the next steps.',
      '4. When all subtasks are completed, synthesize the results and provide a comprehensive overview with attempt_completion.',
    ].join('\n'),
    webSearchDefault: false,
  },
  {
    slug: 'review',
    name: 'Review',
    icon: 'review',
    description: 'Review local changes before you commit',
    roleDefinition: 'You are PerplexiCode, a meticulous senior code reviewer. You review uncommitted changes for correctness, security, performance, and maintainability.',
    whenToUse: 'Use this mode to review uncommitted changes or a specific set of files before committing.',
    groups: ['read', 'command', 'modes'],
    customInstructions: 'Start by running `git status --short` and `git diff` (and `git diff --cached`) to see the changes. Read the surrounding code where needed. Report findings grouped by severity (critical, warning, suggestion) with file paths and line numbers, then finish with attempt_completion. Do not modify files.',
    webSearchDefault: false,
  },
];

export function getModeBySlug(slug: string | undefined): ModeConfig {
  return MODES.find((mode) => mode.slug === slug) || MODES.find((mode) => mode.slug === DEFAULT_MODE_SLUG)!;
}

export function modeHasGroup(mode: ModeConfig, group: ToolGroup): boolean {
  return mode.groups.some((entry) => (Array.isArray(entry) ? entry[0] : entry) === group);
}

export function getGroupOptions(mode: ModeConfig, group: ToolGroup): GroupOptions | undefined {
  const entry = mode.groups.find((item) => (Array.isArray(item) ? item[0] : item) === group);
  return Array.isArray(entry) ? entry[1] : undefined;
}

export const TOOL_GROUPS: Record<ToolGroup, string[]> = {
  read: ['read_file', 'list_files', 'search_files', 'list_code_definition_names'],
  edit: ['write_to_file', 'apply_diff', 'insert_content'],
  command: ['execute_command'],
  modes: ['switch_mode', 'new_task'],
};

/** Tools every mode can use. */
export const ALWAYS_AVAILABLE_TOOLS = ['ask_followup_question', 'attempt_completion', 'update_todo_list'];

export function getToolsForMode(mode: ModeConfig): string[] {
  const tools = new Set<string>(ALWAYS_AVAILABLE_TOOLS);
  for (const entry of mode.groups) {
    const group = Array.isArray(entry) ? entry[0] : entry;
    TOOL_GROUPS[group].forEach((tool) => tools.add(tool));
  }
  return [...tools];
}

export function isToolAllowedForMode(tool: string, mode: ModeConfig): boolean {
  return getToolsForMode(mode).includes(tool);
}

export function editAllowedForPath(mode: ModeConfig, relPath: string): boolean {
  if (!modeHasGroup(mode, 'edit')) {
    return false;
  }
  const options = getGroupOptions(mode, 'edit');
  if (!options?.fileRegex) {
    return true;
  }
  try {
    return new RegExp(options.fileRegex, 'i').test(relPath);
  } catch {
    return false;
  }
}
