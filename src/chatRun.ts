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
  'get_call_status',
  'list_calls',
  'get_operation_status',
  'list_operations',
  'get_billing_status',
]);
export type ChatPermissions = 'read-only' | 'ask' | 'full-access';

export interface ChatPolicy {
  permissions: ChatPermissions;
  maxDurationMinutes: number;
}

type PermissionChoice = vscode.QuickPickItem & { value: ChatPermissions };
type ApprovalChoice = vscode.QuickPickItem & { value: ChatPermissions | 'device-task' };

function settingsHint(): string {
  return vscode.l10n.t(
    'You can change this later in Settings by searching "{0}".',
    `${CHAT_SETTINGS}.permissions`,
  );
}

function permissionChoices(forApproval = false): PermissionChoice[] {
  return [
    {
      label: vscode.l10n.t('Read only'),
      description: vscode.l10n.t('Block changes and commands; inspect devices and files only'),
      detail: settingsHint(),
      value: 'read-only',
    },
    {
      label: vscode.l10n.t('Ask for approval'),
      description: forApproval
        ? vscode.l10n.t('Approve this operation once and ask before later changes')
        : vscode.l10n.t('Ask before changes or commands'),
      detail: settingsHint(),
      value: 'ask',
    },
    {
      label: vscode.l10n.t('Full access'),
      description: vscode.l10n.t('Allow this and future tasks without RDH confirmation prompts'),
      detail:
        vscode.l10n.t(
          'Device restrictions still apply, including enabled commands and file access.',
        ) +
        ' ' +
        settingsHint(),
      value: 'full-access',
    },
  ];
}

const APPROVAL_VALUE_LIMIT = 600;
const APPROVAL_DETAIL_LIMIT = 4000;

// A modal dialog cannot show an unbounded payload. Keep every argument and the
// start and end of each long value visible, and state how much was left out, so
// the user never approves content that silently ran off the dialog.
export function approvalDetail(input: object): { text: string; shortened: boolean } {
  let shortened = false;
  const clip = (value: string, limit: number): string => {
    if (value.length <= limit) {
      return value;
    }
    shortened = true;
    const head = Math.floor(limit * 0.7);
    const tail = limit - head;
    return `${value.slice(0, head)} … [${value.length - limit} characters omitted] … ${value.slice(-tail)}`;
  };
  const text = JSON.stringify(
    input,
    (_key, value: unknown) =>
      typeof value === 'string' ? clip(value, APPROVAL_VALUE_LIMIT) : value,
    2,
  );
  return { text: clip(text, APPROVAL_DETAIL_LIMIT), shortened };
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
  const permissions = read('permissions', 'ask');
  if (permissions !== 'read-only' && permissions !== 'ask' && permissions !== 'full-access') {
    throw new RunStopped(
      'configuration',
      vscode.l10n.t(
        'Choose Read only, Ask for approval, or Full access with Remote Device Hub: Set Chat Permissions.',
      ),
    );
  }
  const maxDurationMinutes = read('maxDurationMinutes', 60);
  if (
    typeof maxDurationMinutes !== 'number' ||
    !Number.isSafeInteger(maxDurationMinutes) ||
    maxDurationMinutes < 0 ||
    maxDurationMinutes > 1440
  ) {
    throw new RunStopped(
      'configuration',
      vscode.l10n.t(
        '{0} must be an integer from 0 to 1440.',
        `${CHAT_SETTINGS}.maxDurationMinutes`,
      ),
    );
  }
  return { permissions, maxDurationMinutes };
}

export async function selectChatPermissions(): Promise<void> {
  const config = vscode.workspace.getConfiguration(CHAT_SETTINGS);
  const setting = config.inspect<unknown>('permissions');
  const current = setting?.globalValue ?? setting?.defaultValue ?? 'ask';
  const choice = await vscode.window.showQuickPick(
    permissionChoices().map((item) => ({
      ...item,
      description:
        item.value === current
          ? vscode.l10n.t('Current: {0}', item.description ?? '')
          : (item.description ?? ''),
    })),
    {
      title: vscode.l10n.t('Remote Device Hub Chat Permissions'),
      placeHolder: vscode.l10n.t(
        'Applies to @remote-device-hub. Copilot Agent uses VS Code tool approvals.',
      ),
    },
  );
  if (!choice) {
    return;
  }
  if (choice.value === 'full-access' && !vscode.workspace.isTrusted) {
    await vscode.window.showErrorMessage(
      vscode.l10n.t('Trust this workspace before enabling Remote Device Hub Full access.'),
    );
    return;
  }
  if (choice.value !== current) {
    await config.update('permissions', choice.value, vscode.ConfigurationTarget.Global);
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
  private readonly approvedDevices = new Set<string>();
  private approvingPermissions: ChatPermissions | undefined;
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
        if (
          event.affectsConfiguration(`${CHAT_SETTINGS}.permissions`) ||
          event.affectsConfiguration(`${CHAT_SETTINGS}.maxDurationMinutes`)
        ) {
          this.syncPolicy();
        }
      }),
    );
  }

  private syncPolicy(): void {
    try {
      const next = readChatPolicy();
      if (next.maxDurationMinutes === this.policy.maxDurationMinutes) {
        if (next.permissions === this.policy.permissions) {
          return;
        }
        // Only the run whose user selected this mode may continue. Other runs
        // stop when their settings change. Check effective values so delayed
        // configuration events cannot restore a superseded permission.
        if (next.permissions === this.approvingPermissions) {
          this.policy.permissions = next.permissions;
          return;
        }
      }
    } catch {
      // Invalid settings also stop the run before another operation is sent.
    }
    this.stop('configuration-changed');
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
  async approveCall(name: string, input: object, schema: object): Promise<boolean> {
    this.check();
    if (READ_TOOLS.has(name)) {
      return true;
    }
    if (this.policy.permissions === 'read-only') {
      throw new RunStopped(
        'permission',
        vscode.l10n.t(
          'Read only permissions do not allow {0}. Use Remote Device Hub: Set Chat Permissions to allow changes.',
          name,
        ),
      );
    }
    if (this.policy.permissions === 'full-access') {
      if (!vscode.workspace.isTrusted) {
        throw new RunStopped(
          'permission',
          vscode.l10n.t('Full access requires a trusted workspace.'),
        );
      }
      return true;
    }
    // A device grant cannot authorize a global operation with a fabricated ID.
    const device =
      isRecord(schema) &&
      isRecord(schema.properties) &&
      isRecord(schema.properties.device_id) &&
      schema.properties.device_id.type === 'string' &&
      isUnknownArray(schema.required) &&
      schema.required.includes('device_id') &&
      isRecord(input) &&
      typeof input.device_id === 'string' &&
      /^[a-zA-Z0-9_-]{1,128}$/.test(input.device_id)
        ? input.device_id
        : undefined;
    const canAllowDevice = vscode.workspace.isTrusted && device !== undefined;
    if (canAllowDevice && this.approvedDevices.has(device)) {
      return true;
    }
    const runOnce = vscode.l10n.t('Run Once');
    const approvalOptions = vscode.l10n.t('Approval Options…');
    const detail = approvalDetail(input);
    const choice = await cancellable(
      () =>
        vscode.window.showWarningMessage(
          vscode.l10n.t('Allow Remote Device Hub to run {0}?', name),
          {
            modal: true,
            detail:
              detail.text +
              '\n\n' +
              (detail.shortened
                ? vscode.l10n.t(
                    'Long values are shortened in this preview. The complete arguments will be sent.',
                  ) + '\n'
                : '') +
              vscode.l10n.t(
                'Choose Approval Options to decide how later operations are approved.',
              ) +
              '\n' +
              settingsHint(),
          },
          runOnce,
          approvalOptions,
        ),
      this.token,
    );
    this.check();
    if (choice === runOnce) {
      return true;
    }
    if (choice === approvalOptions) {
      const choices: ApprovalChoice[] = permissionChoices(true);
      if (canAllowDevice) {
        choices.unshift({
          label: vscode.l10n.t('Allow Device for This Task'),
          description: vscode.l10n.t('Allow operations on {0} until this request ends', device),
          detail: vscode.l10n.t(
            'Includes file changes and shell commands on this device. Does not change saved permissions.',
          ),
          value: 'device-task',
        });
      }
      const decision = await cancellable(
        () =>
          vscode.window.showQuickPick(
            choices,
            {
              title: vscode.l10n.t('Approval for {0}', name),
              placeHolder: settingsHint(),
            },
            this.token,
          ),
        this.token,
      );
      this.check();
      if (decision?.value === 'device-task') {
        if (canAllowDevice && vscode.workspace.isTrusted) {
          this.approvedDevices.add(device);
          return true;
        }
      } else if (decision) {
        if (decision.value === 'full-access' && !vscode.workspace.isTrusted) {
          throw new RunStopped(
            'permission',
            vscode.l10n.t('Full access requires a trusted workspace.'),
          );
        }
        if (decision.value !== this.policy.permissions) {
          this.approvingPermissions = decision.value;
          try {
            await cancellable(
              () =>
                vscode.workspace
                  .getConfiguration(CHAT_SETTINGS)
                  .update('permissions', decision.value, vscode.ConfigurationTarget.Global),
              this.token,
            );
            this.syncPolicy();
            this.check();
            if (readChatPolicy().permissions !== decision.value) {
              throw new RunStopped(
                'configuration',
                vscode.l10n.t(
                  'Could not apply the selected permissions. Change them in Settings and try again.',
                ),
              );
            }
          } catch (error) {
            if (this.token.isCancellationRequested) {
              throw error;
            }
            throw new RunStopped(
              'configuration',
              vscode.l10n.t(
                'Could not save the selected permissions. Change them in Settings and try again.',
              ),
            );
          } finally {
            this.approvingPermissions = undefined;
          }
        }
        if (decision.value === 'full-access' && !vscode.workspace.isTrusted) {
          throw new RunStopped(
            'permission',
            vscode.l10n.t('Full access requires a trusted workspace.'),
          );
        }
        if (decision.value !== 'read-only') {
          return true;
        }
      }
    }
    this.reason = 'declined';
    return false;
  }
  dispose(): void {
    clearTimeout(this.timer);
    this.subscriptions.forEach((subscription) => subscription.dispose());
    this.source.dispose();
  }
}
