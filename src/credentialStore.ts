import type * as vscode from 'vscode';
import { isRecord, isTokenSet, parseJson, type TokenSet } from './boundaries';
import { CredentialError } from './authErrors';

const SECRET_KEY = 'rdh.tokens.v1';
const AUTH_STATE_KEY = 'rdh.authState.v1';
const REFRESH_KEY_PREFIX = 'rdh.refreshKey.v1.';

export interface RevocationCredential {
  token: string;
  token_type_hint: 'refresh_token' | 'access_token';
}

// The session owns locking and transitions; this adapter owns storage format.
export class CredentialStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  onDidChange(listener: () => void): vscode.Disposable {
    return this.secrets.onDidChange((event) => {
      if (event.key === SECRET_KEY) {
        listener();
      }
    });
  }

  async read(): Promise<TokenSet | undefined> {
    const raw = await this.secrets.get(SECRET_KEY);
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
    return this.secrets.store(SECRET_KEY, JSON.stringify(token));
  }
  hasAuthHistory(): Thenable<string | undefined> {
    return this.secrets.get(AUTH_STATE_KEY);
  }
  recordAuthHistory(
    state: { attempted_at: number } | { signed_out_at: number } | { previously_signed_in: true },
  ): Thenable<void> {
    return this.secrets.store(AUTH_STATE_KEY, JSON.stringify(state));
  }
  recoveryKey(clientId: string): Thenable<string | undefined> {
    return this.secrets.get(REFRESH_KEY_PREFIX + clientId);
  }
  saveRecoveryKey(clientId: string, key: string): Thenable<void> {
    return this.secrets.store(REFRESH_KEY_PREFIX + clientId, key);
  }

  // Sign-out must revoke expired and pending tokens without refreshing first.
  async readRevocation(): Promise<
    { clientId: string; credential?: RevocationCredential } | undefined
  > {
    const raw = await this.secrets.get(SECRET_KEY);
    if (!raw) {
      return undefined;
    }
    const stored = parseJson(raw);
    if (!isRecord(stored) || typeof stored.client_id !== 'string' || !stored.client_id) {
      throw new Error('Saved credentials have no OAuth client');
    }
    const hasRefresh = typeof stored.refresh_token === 'string' && Boolean(stored.refresh_token);
    const token = hasRefresh ? stored.refresh_token : stored.access_token;
    return {
      clientId: stored.client_id,
      ...(typeof token === 'string' && token
        ? { credential: { token, token_type_hint: hasRefresh ? 'refresh_token' : 'access_token' } }
        : {}),
    };
  }

  // Return true when a newer account was preserved. Caller holds the lock.
  async clearForClient(clientId: string | undefined): Promise<boolean> {
    const latest = await this.secrets.get(SECRET_KEY);
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
      await this.secrets.delete(SECRET_KEY);
    }
    if (clientId) {
      await this.secrets.delete(REFRESH_KEY_PREFIX + clientId);
    }
    return replaced;
  }
}
