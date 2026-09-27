import type { z } from 'zod';

/** One config problem, ready to print as `<path>: <message>`. */
export interface ConfigIssue {
  readonly path: string;
  readonly message: string;
}

/** The path shown for a problem with the file as a whole. */
const ROOT_PATH = '(config)';

/** Formats a Zod issue path as `rules[2].destination`. */
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
  return out === '' ? ROOT_PATH : out;
}

/**
 * Turns a failed parse of the config into one entry per problem, in the order
 * Zod found them. An unknown-key issue becomes one entry per key, at the key's
 * own path, so a typo such as `treshold` is reported where it is.
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
