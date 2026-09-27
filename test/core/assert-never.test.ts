import { describe, expect, it } from 'vitest';

import { assertNever } from '../../src/core/assert-never.ts';
import { JevClassifierError } from '../../src/core/errors.ts';

describe('assertNever', () => {
  it('throws a JevClassifierError naming the unexpected value', () => {
    // A value the types say can't exist, as it might arrive from bad data at runtime.
    const unexpected = 'surprise' as never;
    let thrown: unknown;
    try {
      assertNever(unexpected);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(JevClassifierError);
    expect(thrown).toMatchObject({ name: 'JevClassifierError', fields: { value: 'surprise' } });
  });
});
