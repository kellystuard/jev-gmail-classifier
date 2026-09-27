/**
 * The Jev API key, from the `JEV_API_KEY` Script Property (Solution Design
 * §5.2, §7.3). The key is never logged (Engineering Standards §6). Only this
 * port reads it; `StatePort` never does.
 */
export interface SecretsPort {
  /** The key, trimmed. `undefined` if it's unset or blank. */
  getJevApiKey(): string | undefined;
}
