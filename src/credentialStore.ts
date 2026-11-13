import type * as vscode from 'vscode';
import { isRecord, isTokenSet, parseJson, type TokenSet } from './boundaries';
import { CredentialError, SafeAuthError } from './authErrors';

export interface RevocationCredential {
  token: string;
  token_type_hint: 'refresh_token' | 'access_token';
}

// The session owns locking and transitions; this adapter owns storage format.
export class CredentialStore {
  private readonly secretKey: string;
  private readonly authStateKey: string;
  private readonly refreshKeyPrefix: string;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    namespace: string,
  ) {
    // Unscoped records have no trustworthy deployment identity. Never
    // copy them into a configured deployment or use them as a fallback.
    this.secretKey = `${namespace}.tokens.v1`;
    this.authStateKey = `${namespace}.authState.v1`;
    this.refreshKeyPrefix = `${namespace}.refreshKey.v1.`;
  }

  private async secretAction<T>(action: () => Thenable<T>): Promise<T> {
    try {
      return await action();
    } catch {
      throw new SafeAuthError(
        'secret storage unavailable; unlock the system keyring and try again.',
      );
    }
  }

  private readSecret(key: string): Promise<string | undefined> {
    return this.secretAction(() => this.secrets.get(key));
  }
  private writeSecret(key: string, value: string): Promise<void> {
    return this.secretAction(() => this.secrets.store(key, value));
  }
  private deleteSecret(key: string): Promise<void> {
    return this.secretAction(() => this.secrets.delete(key));
  }

  onDidChange(listener: () => void): vscode.Disposable {
    return this.secrets.onDidChange((event) => {
      if (event.key === this.secretKey) {
        listener();
      }
    });
  }

  async read(): Promise<TokenSet | undefined> {
    const raw = await this.readSecret(this.secretKey);
    if (!raw) {
      return undefined;
    }
    let value: unknown;
    try {
      value = parseJson(raw);
    } catch {
      throw new CredentialError(
        'invalid_storage',
        'Saved credentials could not be read. Use Remote Device Hub: Sign In to reconnect.',
      );
    }
    if (!isTokenSet(value)) {
      throw new CredentialError(
        'invalid_storage',
        'Saved credentials have an invalid format. Use Remote Device Hub: Sign In to reconnect.',
      );
    }
    return value;
  }

  save(token: TokenSet): Thenable<void> {
    return this.writeSecret(this.secretKey, JSON.stringify(token));
  }
  hasAuthHistory(): Thenable<string | undefined> {
    return this.readSecret(this.authStateKey);
  }
  recordAuthHistory(
    state:
      | { attempted_at: number; attempt_id: string }
      | { signed_out_at: number }
      | { previously_signed_in: true },
  ): Thenable<void> {
    return this.writeSecret(this.authStateKey, JSON.stringify(state));
  }
  recoveryKey(clientId: string): Thenable<string | undefined> {
    return this.readSecret(this.refreshKeyPrefix + clientId);
  }
  saveRecoveryKey(clientId: string, key: string): Thenable<void> {
    return this.writeSecret(this.refreshKeyPrefix + clientId, key);
  }

  // Sign-out must revoke expired and pending tokens without refreshing first.
  async readRevocation(): Promise<
    { clientId: string; issuer?: string; credential?: RevocationCredential } | undefined
  > {
    const raw = await this.readSecret(this.secretKey);
    if (!raw) {
      return undefined;
    }
    const stored = parseJson(raw);
    if (!isRecord(stored) || typeof stored.client_id !== 'string' || !stored.client_id) {
      throw new SafeAuthError('Saved credentials have no OAuth client');
    }
    const hasRefresh = typeof stored.refresh_token === 'string' && Boolean(stored.refresh_token);
    const token = hasRefresh ? stored.refresh_token : stored.access_token;
    return {
      clientId: stored.client_id,
      ...(typeof stored._issuer === 'string' ? { issuer: stored._issuer } : {}),
      ...(typeof token === 'string' && token
        ? { credential: { token, token_type_hint: hasRefresh ? 'refresh_token' : 'access_token' } }
        : {}),
    };
  }

  // Return true when a newer account was preserved. Caller holds the lock.
  async clearForClient(clientId: string | undefined): Promise<boolean> {
    const latest = await this.readSecret(this.secretKey);
    let replaced = false;
    try {
      const value = latest ? parseJson(latest) : undefined;
      const latestClient = isRecord(value) ? value.client_id : undefined;
      replaced = Boolean(
        typeof latestClient === 'string' && latestClient && latestClient !== clientId,
      );
    } catch {
      /* Malformed credentials still need local cleanup. */
    }
    if (!replaced) {
      await this.deleteSecret(this.secretKey);
    }
    if (clientId) {
      await this.deleteSecret(this.refreshKeyPrefix + clientId);
    }
    return replaced;
  }
}
