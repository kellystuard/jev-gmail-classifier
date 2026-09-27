/**
 * Reads, parses and validates the config file for the build (Solution Design
 * §7.2, §11; ADR-0013). It returns the lines to print instead of printing, so
 * `scripts/build.ts` owns `console` and the exit code, and tests call it
 * directly.
 */
import { readFileSync } from 'node:fs';

import { LineCounter, parseAllDocuments } from 'yaml';

import { configIssues, configSchema } from '../src/config/schema.ts';
import { formatConfigIssue } from '../src/core/errors.ts';
import { fail, ok, type Fail, type Result } from '../src/core/result.ts';

export type ConfigSourceFailure = Fail<
  'not_found' | 'unreadable' | 'yaml' | 'empty' | 'multiple_documents' | 'invalid',
  { lines: readonly string[] }
>;

/** The raw YAML data, validated but not transformed: the runtime parses it again. */
export type ConfigSourceResult = Result<{ raw: unknown }, ConfigSourceFailure>;

export interface ReadConfigOptions {
  /** True when no `--config` was given, so a missing file gets the "copy the example" help. */
  readonly isDefault: boolean;
  /** The name used in messages. Defaults to `file`. */
  readonly displayName?: string;
}

export const MISSING_DEFAULT_CONFIG =
  'config.yaml not found. Copy config.example.yaml to config.yaml and edit your rules ' +
  '(see README, "Configuration"). To build the example instead, run: ' +
  'npm run build -- --config config.example.yaml';

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

/** Parses the text as exactly one YAML document, with duplicate keys rejected. */
export function parseConfigText(text: string, displayName: string): ConfigSourceResult {
  const lineCounter = new LineCounter();
  const documents = parseAllDocuments(text, { lineCounter, prettyErrors: false });
  const at = (offset: number): string => {
    const { line, col } = lineCounter.linePos(offset);
    return `${displayName}:${String(line)}:${String(col)}`;
  };

  const yamlErrors = documents.flatMap((document) => document.errors);
  if (yamlErrors.length > 0) {
    return fail('yaml', {
      lines: yamlErrors.map((error) => `${at(error.pos[0])}: ${error.message}`),
    });
  }

  const [document, second] = documents;
  if (second !== undefined) {
    return fail('multiple_documents', {
      lines: [`${at(second.range[0])}: the file holds more than one YAML document (---); keep one`],
    });
  }
  const raw: unknown = document?.toJS();
  if (raw === undefined || raw === null) {
    return fail('empty', {
      lines: [`${displayName} is empty. Copy config.example.yaml and edit your rules.`],
    });
  }

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('invalid', {
      lines: [
        `${displayName} is invalid:`,
        ...configIssues(parsed.error).map((issue) => `  ${formatConfigIssue(issue)}`),
      ],
    });
  }
  return ok({ raw });
}

/** Reads `file` and validates it. Never throws for a missing, unreadable or invalid file. */
export function readConfig(file: string, options: ReadConfigOptions): ConfigSourceResult {
  const displayName = options.displayName ?? file;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return fail('not_found', {
        lines: [
          options.isDefault ? MISSING_DEFAULT_CONFIG : `Config file ${displayName} not found.`,
        ],
      });
    }
    return fail('unreadable', {
      lines: [`Cannot read config file ${displayName}: ${String(errorCode(error) ?? error)}`],
    });
  }
  return parseConfigText(text, displayName);
}
