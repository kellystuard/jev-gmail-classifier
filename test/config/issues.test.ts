import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { configIssues } from '../../src/config/issues.ts';

describe('configIssues', () => {
  it('formats paths as rules[2].destination, with the top level as a bare name', () => {
    const error = new z.ZodError([
      { code: 'custom', path: ['defaultThreshold'], message: 'm1', input: undefined },
      { code: 'custom', path: ['rules', 2, 'destination'], message: 'm2', input: undefined },
      { code: 'custom', path: ['rules', 0], message: 'm3', input: undefined },
      { code: 'custom', path: ['rules'], message: 'm4', input: undefined },
    ]);
    expect(configIssues(error)).toEqual([
      { path: 'defaultThreshold', message: 'm1' },
      { path: 'rules[2].destination', message: 'm2' },
      { path: 'rules[0]', message: 'm3' },
      { path: 'rules', message: 'm4' },
    ]);
  });

  it('gives a problem with the whole file the empty (root) path', () => {
    const error = new z.ZodError([{ code: 'custom', path: [], message: 'm', input: undefined }]);
    expect(configIssues(error)).toEqual([{ path: '', message: 'm' }]);
  });

  it('reports each unknown key at its own path', () => {
    const error = new z.ZodError([
      {
        code: 'unrecognized_keys',
        keys: ['treshold', 'lable'],
        path: ['rules', 1],
        message: 'unknown field',
        input: { treshold: 0.9, lable: 'Bill' },
      },
    ]);
    expect(configIssues(error)).toEqual([
      { path: 'rules[1].treshold', message: 'unknown field' },
      { path: 'rules[1].lable', message: 'unknown field' },
    ]);
  });
});
