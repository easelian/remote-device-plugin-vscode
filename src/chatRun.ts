import * as vscode from 'vscode';
import { isRecord, isUnknownArray } from './boundaries';

export const CHAT_SETTINGS = 'remoteDeviceHub.chat';
export const READ_TOOLS = new Set([
  'list_devices',
  'device_info',
  'list_directory',
  'read_file',
  'file_info',
  'read_file_chunk',
  'read_multiple_files',
  'search_files',
  'read_process',
  'list_processes',
  'list_searches',
  'get_search_results',
  'get_billing_status',
]);
const GLOBAL_READ_TOOLS = new Set(['list_devices', 'get_billing_status']);

export interface ChatPolicy {
  executionMode: 'confirm' | 'automatic';
  automaticDevices: string[];
  automaticTools: string[];
  maxModelTurns: number;
  maxToolCalls: number;
  maxDurationMinutes: number;
}

export class RunStopped extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

export function readChatPolicy(): ChatPolicy {
  const config = vscode.workspace.getConfiguration(CHAT_SETTINGS);
  // Permission grants must never come from a repository the model can edit.
  // Machine-scoped settings live in User/Remote settings. Reject workspace and
  // folder values explicitly when inspecting permission settings.
  const read = (name: string, fallback: unknown): unknown => {
    const value = config.inspect<unknown>(name);
    return value?.globalValue ?? value?.defaultValue ?? fallback;
  };
  const executionMode = read('executionMode', 'confirm');
  if (executionMode !== 'confirm' && executionMode !== 'automatic') {
    throw new RunStopped(
      'configuration',
      'Set remoteDeviceHub.chat.executionMode to confirm or automatic.',
    );
  }
  const list = (name: string): string[] => {
    const value = read(name, []);
    if (
      !isUnknownArray(value) ||
      !value.every((v): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v))
    ) {
      throw new RunStopped(
        'configuration',
        `${CHAT_SETTINGS}.${name} must contain exact names or IDs, without wildcards.`,
      );
    }
    return [...new Set(value)];
  };
  const budget = (name: string, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number => {
    const value = read(name, fallback);
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
      throw new RunStopped(
        'configuration',
        `${CHAT_SETTINGS}.${name} must be an integer from 0 to ${maximum}.`,
      );
    }
    return value;
  };
  return {
    executionMode,
    automaticDevices: list('automaticDevices'),
    automaticTools: list('automaticTools'),
    maxModelTurns: budget('maxModelTurns', 0),
    maxToolCalls: budget('maxToolCalls', 0),
    maxDurationMinutes: budget('maxDurationMinutes', 60, 1440),
  };
}

export function checkAutomaticCall(
  policy: ChatPolicy,
  name: string,
  input: object,
  schema: object,
): void {
  if (policy.executionMode !== 'automatic') {
    return;
  }
  if (!vscode.workspace.isTrusted) {
    throw new RunStopped('permission', 'Automatic execution requires a trusted workspace.');
  }
  if (GLOBAL_READ_TOOLS.has(name)) {
    return;
  }
  if (
    !isRecord(schema) ||
    !isRecord(schema.properties) ||
    !schema.properties.device_id ||
    !isUnknownArray(schema.required) ||
    !schema.required.includes('device_id')
  ) {
    throw new RunStopped(
      'permission',
      `Tool ${name} does not declare a required device_id. Automatic mode only permits device-scoped operations and global read-only discovery.`,
    );
  }
  const device = isRecord(input) ? input.device_id : undefined;
  if (typeof device !== 'string' || !policy.automaticDevices.includes(device)) {
    throw new RunStopped(
      'permission',
      `Tool ${name} requires a device ID listed in ${CHAT_SETTINGS}.automaticDevices. No call was sent.`,
    );
  }
  if (!READ_TOOLS.has(name) && !policy.automaticTools.includes(name)) {
    throw new RunStopped(
      'permission',
      `Tool ${name} is not listed in ${CHAT_SETTINGS}.automaticTools. No call was sent.`,
    );
  }
}

// Race every external wait with cancellation. Some model providers and UI
// promises do not settle when their cancellation token is signaled.
export function cancellable<T>(
  start: () => Thenable<T>,
  token: vscode.CancellationToken,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let finished = false;
    let subscription: vscode.Disposable | undefined;
    const finish = (outcome: { ok: true; value: T } | { ok: false; error: unknown }): void => {
      if (finished) {
        return;
      }
      finished = true;
      subscription?.dispose();
      if (outcome.ok) {
        resolve(outcome.value);
      } else {
        reject(outcome.error);
      }
    };
    const cancel = (): void => finish({ ok: false, error: new vscode.CancellationError() });
    if (token.isCancellationRequested) {
      cancel();
      return;
    }
    subscription = token.onCancellationRequested(cancel);
    if (finished || token.isCancellationRequested) {
      subscription.dispose();
      cancel();
      return;
    }
    try {
      Promise.resolve(start()).then(
        (value) => finish({ ok: true, value }),
        (error) => finish({ ok: false, error }),
      );
    } catch (error) {
      finish({ ok: false, error });
    }
  });
}

export class ChatRun implements vscode.Disposable {
  private readonly source = new vscode.CancellationTokenSource();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly timer: ReturnType<typeof setTimeout> | undefined;
  private readonly started = Date.now();
  private readonly deadline: number;
  reason = 'error';
  turns = 0;
  calls = 0;
  get token(): vscode.CancellationToken {
    return this.source.token;
  }
  get elapsedSeconds(): number {
    return Math.round((Date.now() - this.started) / 1000);
  }

  constructor(
    readonly policy: ChatPolicy,
    parent: vscode.CancellationToken,
    shutdown?: vscode.CancellationToken,
  ) {
    const link = (token: vscode.CancellationToken): void => {
      this.subscriptions.push(token.onCancellationRequested(() => this.stop('canceled')));
      if (token.isCancellationRequested) {
        this.stop('canceled');
      }
    };
    link(parent);
    if (shutdown) {
      link(shutdown);
    }
    this.deadline = policy.maxDurationMinutes
      ? this.started + policy.maxDurationMinutes * 60_000
      : Infinity;
    if (policy.maxDurationMinutes) {
      this.timer = setTimeout(() => this.stop('duration'), policy.maxDurationMinutes * 60_000);
    }
    this.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(CHAT_SETTINGS)) {
          this.stop('configuration-changed');
        }
      }),
    );
  }

  private stop(reason: string): void {
    if (this.token.isCancellationRequested) {
      return;
    }
    this.reason = reason;
    this.source.cancel();
  }
  check(): void {
    if (Date.now() >= this.deadline) {
      this.stop('duration');
    }
    if (this.token.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
  }
  nextTurn(): void {
    this.check();
    if (this.policy.maxModelTurns && this.turns >= this.policy.maxModelTurns) {
      throw new RunStopped(
        'turn-budget',
        `Reached the model turn budget (${this.policy.maxModelTurns}). Send a follow-up to continue or change ${CHAT_SETTINGS}.maxModelTurns.`,
      );
    }
    this.turns++;
  }
  checkCallBudget(): void {
    this.check();
    if (this.policy.maxToolCalls && this.calls >= this.policy.maxToolCalls) {
      throw new RunStopped(
        'tool-budget',
        `Reached the tool call budget (${this.policy.maxToolCalls}). Send a follow-up to continue or change ${CHAT_SETTINGS}.maxToolCalls.`,
      );
    }
  }
  dispose(): void {
    clearTimeout(this.timer);
    this.subscriptions.forEach((subscription) => subscription.dispose());
    this.source.dispose();
  }
}
