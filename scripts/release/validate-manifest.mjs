// @ts-nocheck -- This standalone release CLI is validated through JSON Schema and regression tests.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArguments, root, validateReleaseManifest } from './manifest-lib.mjs';

const arguments_ = parseArguments(process.argv.slice(2));
if (!arguments_.manifest) {
  throw new Error(
    'Usage: pnpm release:manifest:validate -- --manifest <path> [--mode dry-run|release]',
  );
}
const manifestPath = resolve(root, arguments_.manifest);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
await validateReleaseManifest(manifest, { requireDigests: arguments_.mode === 'release' });
process.stdout.write(`${manifestPath}: valid\n`);
