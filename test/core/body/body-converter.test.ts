import { describe, expect, expectTypeOf, it } from 'vitest';

import type { Config } from '../../../src/config/schema.ts';
import { basicConverter } from '../../../src/core/body/basic.ts';
import {
  type BodyConverter,
  type PlainTextMethod,
  selectBodyConverter,
} from '../../../src/core/body/body-converter.ts';

describe('selectBodyConverter', () => {
  it('returns the basic converter for basic', () => {
    const converter = selectBodyConverter('basic');
    expect(converter.method).toBe('basic');
    expect(converter).toBe(basicConverter);
    expect(converter.htmlToText('<p>Hello <b>there</b></p><p>again</p>')).toBe(
      'Hello there\n\nagain',
    );
  });

  it('returns a BodyConverter', () => {
    expectTypeOf(selectBodyConverter).returns.toEqualTypeOf<BodyConverter>();
  });

  it('throws for a value outside PlainTextMethod', () => {
    const unknownMethod: unknown = 'advanced';
    // @ts-expect-error -- a value the type rules out, to reach the runtime check.
    expect(() => selectBodyConverter(unknownMethod)).toThrow('Unexpected value');
  });
});

describe('PlainTextMethod', () => {
  it('accepts every value the config schema allows', () => {
    expectTypeOf<Config['plainTextMethod']>().toExtend<PlainTextMethod>();
  });

  it('is only basic in v1', () => {
    expectTypeOf<PlainTextMethod>().toEqualTypeOf<'basic'>();
  });
});
