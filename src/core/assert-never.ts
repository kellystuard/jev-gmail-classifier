import { JevClassifierError } from './errors.ts';

/**
 * Marks the unreachable `default` of an exhaustive `switch` (Engineering
 * Standards §4). It fails to compile when a case is missing, and throws if an
 * unexpected value arrives at runtime anyway.
 */
export function assertNever(value: never): never {
  throw new JevClassifierError('Unexpected value in an exhaustive check', {
    value: String(value),
  });
}
