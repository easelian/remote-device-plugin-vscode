export class CredentialError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

export function msg(e: unknown): string {
  if (e instanceof CredentialError) {
    return `${e.reason}: ${e.message}`;
  }
  return e instanceof Error ? e.message : String(e);
}
