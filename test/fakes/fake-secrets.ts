import type { SecretsPort } from '../../src/ports/secrets-port.ts';

export type FakeSecretsOptions = {
  readonly jevApiKey?: string;
};

/** The `JEV_API_KEY` Script Property: trimmed, and `undefined` when unset or blank. */
export class FakeSecrets implements SecretsPort {
  private key: string | undefined;

  constructor(options: FakeSecretsOptions = {}) {
    this.key = options.jevApiKey;
  }

  getJevApiKey(): string | undefined {
    const trimmed = this.key?.trim();
    return trimmed === undefined || trimmed === '' ? undefined : trimmed;
  }

  setJevApiKey(key: string): void {
    this.key = key;
  }

  clear(): void {
    this.key = undefined;
  }
}
