import type { z } from 'zod';

import type { ConfigIssue } from '../core/errors.ts';

/** Formats a Zod issue path as `rules[2].destination`. The root is `''`. */
function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const key of path) {
    if (typeof key === 'number') {
      out += `[${String(key)}]`;
    } else {
      const name = String(key);
      out += out === '' ? name : `.${name}`;
    }
  }
  return out;
}

/**
 * Turns a failed parse of the config into one `ConfigIssue` per problem, in
 * the order Zod found them, for `ConfigError` and the build's output. An
 * unknown-key issue becomes one entry per key, at the key's own path, so a
 * typo such as `treshold` is reported where it is. A problem with the whole
 * file has the empty path, which `formatConfigIssue` shows as `(root)`.
 */
export function configIssues(error: z.ZodError): ConfigIssue[] {
  const out: ConfigIssue[] = [];
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        out.push({ path: formatPath([...issue.path, key]), message: issue.message });
      }
    } else {
      out.push({ path: formatPath(issue.path), message: issue.message });
    }
  }
  return out;
}
