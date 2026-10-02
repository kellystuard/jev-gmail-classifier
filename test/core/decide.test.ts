import { describe, expect, it } from 'vitest';
import type { MoveDestination, Rule } from '../../src/config/schema.ts';
import { decideOutcome, movesAllowed } from '../../src/core/decide.ts';
import { InvalidArgumentError } from '../../src/core/errors.ts';

const label = (id: string, name: string, threshold?: number): Rule => ({
  id,
  question: `Is it ${id}?`,
  action: 'label',
  label: name,
  ...(threshold === undefined ? {} : { threshold }),
});
const move = (id: string, destination: MoveDestination, threshold?: number): Rule => ({
  id,
  question: `Is it ${id}?`,
  action: 'move',
  destination,
  ...(threshold === undefined ? {} : { threshold }),
});
const decide = (
  rules: readonly Rule[],
  answers: Record<string, number>,
  allowed = true,
  defaultThreshold = 0.8,
) => decideOutcome({ rules, defaultThreshold }, answers, { movesAllowed: allowed });

describe('decideOutcome thresholds', () => {
  it.each([
    ['above', 0.9, true],
    ['equal', 0.8, true],
    ['just below', 0.799, false],
  ])('default threshold, p %s', (_name, p, fires) => {
    expect(decide([label('a', 'A')], { a: p }).fired).toEqual(fires ? ['a'] : []);
  });

  it.each([
    ['higher rule threshold blocks', 0.9, 0.95, false],
    ['lower rule threshold fires', 0.5, 0.4, true],
    ['threshold 0, p 0', 0, 0, true],
    ['threshold 1, p 1', 1, 1, true],
    ['threshold 1, p 0.999', 0.999, 1, false],
  ])('%s', (_name, p, threshold, fires) => {
    expect(decide([label('a', 'A', threshold)], { a: p }).fired).toEqual(fires ? ['a'] : []);
  });
});

describe('decideOutcome results', () => {
  it('returns no move key when nothing fires', () => {
    const d = decide([label('a', 'A'), move('m', { kind: 'archive' })], { a: 0, m: 0 });
    expect(d).toEqual({ fired: [], labels: [] });
    expect('move' in d).toBe(false);
  });

  it('adds every firing label in config order', () => {
    const rules = [label('a', 'A'), label('b', 'B'), label('c', 'C')];
    expect(decide(rules, { a: 1, b: 0, c: 1 })).toEqual({ fired: ['a', 'c'], labels: ['A', 'C'] });
  });

  it('de-duplicates labels by labelKey, first spelling wins', () => {
    const rules = [label('a', 'Finance/Bill'), label('b', 'FINANCE/BILL')];
    expect(decide(rules, { a: 1, b: 1 })).toEqual({
      fired: ['a', 'b'],
      labels: ['Finance/Bill'],
    });
  });

  it('de-duplicates labels Gmail takes for one name', () => {
    const rules = [label('a', 'Finance/Bill'), label('b', 'Finance-Bill')];
    expect(decide(rules, { a: 1, b: 1 }).labels).toEqual(['Finance/Bill']);
  });

  it('keeps labels Gmail holds apart', () => {
    const rules = [label('a', 'Finance/Bill'), label('b', 'Finance_Bill')];
    expect(decide(rules, { a: 1, b: 1 }).labels).toEqual(['Finance/Bill', 'Finance_Bill']);
  });

  it('picks the first firing move rule, both in fired', () => {
    const rules = [move('m1', { kind: 'archive' }), move('m2', { kind: 'trash' })];
    expect(decide(rules, { m1: 1, m2: 1 })).toEqual({
      fired: ['m1', 'm2'],
      labels: [],
      move: { ruleId: 'm1', destination: { kind: 'archive' } },
    });
  });

  it('uses the second move when the first does not fire', () => {
    const rules = [move('m1', { kind: 'archive' }), move('m2', { kind: 'trash' })];
    expect(decide(rules, { m1: 0, m2: 1 }).move).toEqual({
      ruleId: 'm2',
      destination: { kind: 'trash' },
    });
  });

  it.each<MoveDestination>([
    { kind: 'archive' },
    { kind: 'spam' },
    { kind: 'trash' },
    { kind: 'label', label: 'Later/Soon' },
  ])('passes destination %j through', (destination) => {
    expect(decide([move('m', destination)], { m: 1 }).move?.destination).toEqual(destination);
  });

  it('applies no move when moves are not allowed, and adds no move label', () => {
    const rules = [move('m', { kind: 'label', label: 'Later' }), label('a', 'A')];
    expect(decide(rules, { m: 1, a: 1 }, false)).toEqual({ fired: ['m', 'a'], labels: ['A'] });
  });

  it('keeps config order when label and move rules interleave', () => {
    const rules = [label('a', 'A'), move('m', { kind: 'spam' }), label('b', 'B')];
    const d = decide(rules, { a: 1, m: 1, b: 1 });
    expect(d.fired).toEqual(['a', 'm', 'b']);
    expect(d.labels).toEqual(['A', 'B']);
  });

  it('ignores extra answer keys', () => {
    expect(decide([label('a', 'A')], { a: 1, extra: 5 }).fired).toEqual(['a']);
  });

  it('does not mutate frozen inputs', () => {
    const rules = Object.freeze([Object.freeze(label('a', 'A'))]);
    const answers = Object.freeze({ a: 1 });
    const d = decideOutcome({ rules, defaultThreshold: 0.5 }, answers, { movesAllowed: true });
    expect(d.fired).toEqual(['a']);
  });
});

describe('decideOutcome invalid answers', () => {
  it.each([
    ['missing', {}, 'missing'],
    ['undefined', { a: undefined }, 'missing'],
    ['-0.1', { a: -0.1 }, 'outside 0..1'],
    ['1.1', { a: 1.1 }, 'outside 0..1'],
    ['NaN', { a: Number.NaN }, 'outside 0..1'],
    ['not a number', { a: '1' }, 'outside 0..1'],
  ])('throws for %s', (_name, answers, text) => {
    let caught: unknown;
    try {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- forges bad answers that only a bug could produce
      decide([label('a', 'A')], answers as Record<string, number>);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidArgumentError);
    if (!(caught instanceof InvalidArgumentError)) throw new Error('unreachable');
    const e = caught;
    expect(e.argument).toBe('answers');
    expect(e.reason).toContain('"a"');
    expect(e.reason).toContain(text);
  });

  it('validates rules that would not fire', () => {
    expect(() => decide([label('a', 'A'), label('b', 'B')], { a: 1 })).toThrow(
      InvalidArgumentError,
    );
  });
});

describe('movesAllowed', () => {
  it.each([
    [undefined, undefined, false],
    [false, undefined, false],
    [true, undefined, true],
    [undefined, true, true],
    [false, true, true],
    [true, true, true],
    [false, false, false],
  ])('firstClassification %s, applyMoves %s -> %s', (first, apply, expected) => {
    expect(
      movesAllowed({
        ...(first === undefined ? {} : { firstClassification: first }),
        ...(apply === undefined ? {} : { applyMoves: apply }),
      }),
    ).toBe(expected);
  });
});
