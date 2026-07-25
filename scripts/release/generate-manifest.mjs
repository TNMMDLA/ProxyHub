// @ts-nocheck -- This standalone release CLI is validated through JSON Schema and regression tests.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createReleaseManifest, parseArguments, root } from './manifest-lib.mjs';

const arguments_ = parseArguments(process.argv.slice(2));
const output = resolve(root, arguments_.output ?? 'artifacts/release-manifest.json');
const gitSha =
  arguments_['git-sha'] ??
  process.env.GITHUB_SHA ??
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const names = ['web', 'server', 'agent', 'xray'];
const digests = Object.fromEntries(
  names.map((name) => [name, arguments_[`${name}-digest`] ?? null]),
);
const manifest = await createReleaseManifest({
  gitSha,
  buildTime: arguments_['build-time'],
  buildEnvironment: arguments_.environment,
  deployMode: arguments_['deploy-mode'],
  imagePrefix: arguments_['image-prefix'],
  tag: arguments_.tag,
  digests,
  mode: arguments_.mode ?? 'dry-run',
});
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, {
  encoding: 'utf8',
  mode: 0o600,
});
process.stdout.write(`${output}\n`);
