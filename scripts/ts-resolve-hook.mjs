// The app is bundled by Next, so its imports are extensionless ("./cache").
// Node's ESM resolver requires a real filename. This hook adds the extension
// so `node --test` can load the source modules unchanged — no bundler, no
// transpile step, and no ".ts" suffixes leaking into application code.
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
    const base = dirname(fileURLToPath(context.parentURL));
    for (const ext of ['.ts', '.tsx', '/index.ts']) {
      const candidate = resolvePath(base, specifier + ext);
      if (existsSync(candidate)) {
        // No explicit `format`: Node infers it from the .ts extension and applies
        // type stripping. Pinning it to 'module' skips that and the first
        // `interface` in the file is a syntax error.
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
  }
  return nextResolve(specifier, context);
}
