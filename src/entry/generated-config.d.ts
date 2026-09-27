/**
 * The config embedded by the build (Solution Design §11). esbuild serves this
 * module from memory (`scripts/bundle.ts`); this declaration lets `tsc` and
 * ESLint resolve it with no file on disk. Only `src/entry/` may import it.
 *
 * The value is the raw YAML data, typed `unknown`: read it only through the
 * config loader, which validates it again.
 */
declare module 'virtual:generated-config' {
  export const EMBEDDED_CONFIG: unknown;
}
