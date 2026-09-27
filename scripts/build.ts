/**
 * `npm run build`: validate the config, regenerate `config.schema.json`,
 * typecheck, then bundle into `dist/` (Solution Design §11).
 *
 *     npm run build                                      # reads config.yaml
 *     npm run build -- --config config.example.yaml      # reads another file
 *
 * Each step is a named function. The config comes first, so a bad config
 * fails in well under a second with no typecheck noise, and leaves `dist/`
 * and `src/generated/` untouched. On failure it prints `Build failed:
 * <step>: …` and exits 1.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { bundle, REPO_ROOT, resolveOutDir } from './bundle.ts';
import { CONFIG_JSON_SCHEMA_FILE, configJsonSchemaText } from './config-json-schema.ts';
import { readConfig } from './config-source.ts';
import { GENERATED_CONFIG_FILE, generatedConfigModule } from './generated-config.ts';

const OUT_DIR = 'dist';
const DEFAULT_CONFIG = 'config.yaml';

class StepFailed extends Error {}

interface ConfigSource {
  /** The file to read. */
  readonly file: string;
  /** How messages and the generated header name it. */
  readonly displayName: string;
  readonly isDefault: boolean;
}

function parseArguments(): ConfigSource {
  let config: string | undefined;
  try {
    ({
      values: { config },
    } = parseArgs({
      args: process.argv.slice(2),
      options: { config: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new StepFailed(`arguments: ${message}. Usage: npm run build [-- --config <path>]`);
  }
  if (config === undefined) {
    return { file: join(REPO_ROOT, DEFAULT_CONFIG), displayName: DEFAULT_CONFIG, isDefault: true };
  }
  return { file: resolve(config), displayName: config, isDefault: false };
}

function validateConfig(source: ConfigSource): unknown {
  const result = readConfig(source.file, {
    isDefault: source.isDefault,
    displayName: source.displayName,
  });
  if (!result.ok) {
    throw new StepFailed(`config: ${result.lines.join('\n')}`);
  }
  return result.raw;
}

function typecheck(): void {
  try {
    execFileSync(join(REPO_ROOT, 'node_modules', '.bin', 'tsc'), ['--noEmit'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
  } catch {
    throw new StepFailed('typecheck: tsc --noEmit reported the errors above');
  }
}

async function bundleToDist(embeddedConfig: unknown, configSourceName: string): Promise<void> {
  try {
    await bundle({ outDir: OUT_DIR, embeddedConfig, configSourceName });
  } catch (error) {
    // An esbuild failure carries `errors`, which esbuild has already printed.
    const fromEsbuild = error instanceof Error && 'errors' in error;
    const firstLine = (error instanceof Error ? error.message : String(error)).split('\n')[0];
    const summary = (firstLine ?? '').replace(/:$/, '') || 'unknown error';
    throw new StepFailed(`bundle: ${summary}${fromEsbuild ? ' (details above)' : ''}`);
  }
}

/**
 * Regenerates the committed `config.schema.json` from the schema, so a stale
 * copy shows up as a diff (CI runs `git diff --exit-code` after the build).
 */
function writeJsonSchema(): void {
  writeFileSync(join(REPO_ROOT, CONFIG_JSON_SCHEMA_FILE), configJsonSchemaText());
}

/**
 * Writes the module the bundle embedded to `src/generated/config.ts`, for
 * reading only: the bundle doesn't read it. Both come from
 * `generatedConfigModule()`, so they can't differ.
 */
function writeGeneratedConfig(embeddedConfig: unknown, configSourceName: string): void {
  const file = join(REPO_ROOT, GENERATED_CONFIG_FILE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, generatedConfigModule(embeddedConfig, configSourceName));
}

function reportOutputs(): void {
  const dir = resolveOutDir(OUT_DIR);
  for (const name of readdirSync(dir).sort()) {
    const kib = (statSync(join(dir, name)).size / 1024).toFixed(1);
    console.log(`  ${relative(REPO_ROOT, join(dir, name))}  ${kib} KiB`);
  }
  console.log(`  ${GENERATED_CONFIG_FILE}  (a copy of the embedded config, for reading)`);
}

async function main(): Promise<void> {
  const source = parseArguments();
  const embeddedConfig = validateConfig(source);
  writeJsonSchema();
  typecheck();
  await bundleToDist(embeddedConfig, source.displayName);
  writeGeneratedConfig(embeddedConfig, source.displayName);
  reportOutputs();
}

try {
  await main();
} catch (error) {
  const message = error instanceof StepFailed ? error.message : String(error);
  console.error(`Build failed: ${message}`);
  process.exitCode = 1;
}
