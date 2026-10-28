/* Minimal `vscode` mock for settingsStore tests: a configuration registry that rejects unknown keys like VS Code does. */
export const registry = new Map<string, unknown>(); // key -> default value
export const userValues = new Map<string, unknown>();
export const warnings: string[] = [];
export const executed: string[] = [];
export let nextWarningChoice: string | undefined;
export let failNextUpdateWith: Error | undefined;

export function reset(): void {
  registry.clear();
  userValues.clear();
  warnings.length = 0;
  executed.length = 0;
  nextWarningChoice = undefined;
  failNextUpdateWith = undefined;
}
export function setWarningChoice(choice: string | undefined): void {
  nextWarningChoice = choice;
}
export function failNextUpdate(error: Error | undefined): void {
  failNextUpdateWith = error;
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export class EventEmitter<T> {
  private listeners: Array<(value: T) => void> = [];
  event = (listener: (value: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => (this.listeners = this.listeners.filter((entry) => entry !== listener)) };
  };
  fire(value: T): void {
    this.listeners.forEach((listener) => listener(value));
  }
  dispose(): void {
    this.listeners = [];
  }
}

export const workspace = {
  getConfiguration() {
    return {
      get<T>(key: string, defaultValue?: T): T | undefined {
        if (userValues.has(key)) return userValues.get(key) as T;
        if (registry.has(key)) return registry.get(key) as T;
        return defaultValue;
      },
      inspect(key: string) {
        return { key, defaultValue: registry.get(key), globalValue: userValues.get(key) };
      },
      async update(key: string, value: unknown): Promise<void> {
        if (failNextUpdateWith) {
          const error = failNextUpdateWith;
          failNextUpdateWith = undefined;
          throw error;
        }
        if (!registry.has(key)) {
          throw new Error(`Unable to write to User Settings because ${key} is not a registered configuration.`);
        }
        userValues.set(key, value);
      },
    };
  },
};

export const window = {
  async showWarningMessage(message: string): Promise<string | undefined> {
    warnings.push(message);
    return nextWarningChoice;
  },
};

export const commands = {
  async executeCommand(command: string): Promise<void> {
    executed.push(command);
  },
};
