import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const requireFromServer = createRequire(new URL('../../apps/server/package.json', import.meta.url));

/** @type {Array<readonly [string, readonly string[]]>} */
const packages = [
  ['@proxyhub/policy-core', ['compilePolicy', 'CAPABILITIES']],
  ['@proxyhub/rule-set-core', ['parseRuleSet', 'normalizeRuleSet']],
  ['@proxyhub/shared', ['createNodeSchema', 'createRuleSetSchema']],
  ['@proxyhub/xray-manager', ['buildXrayConfig', 'createVlessUri']],
];

for (const [packageName, expectedExports] of packages) {
  const resolvedPath = requireFromServer.resolve(packageName);
  const normalizedPath = resolvedPath.replaceAll('\\', '/');
  if (!normalizedPath.endsWith('/dist/index.js') || normalizedPath.includes('/src/')) {
    throw new Error(`${packageName} resolved to a non-production entry: ${normalizedPath}`);
  }

  /** @type {unknown} */
  const runtimeModule = await import(pathToFileURL(resolvedPath).href);
  if (typeof runtimeModule !== 'object' || runtimeModule === null) {
    throw new Error(`${packageName} did not load as an ESM namespace`);
  }
  for (const expectedExport of expectedExports) {
    if (!Object.hasOwn(runtimeModule, expectedExport)) {
      throw new Error(`${packageName} is missing runtime export ${expectedExport}`);
    }
  }

  console.log(`${packageName} -> ${normalizedPath}`);
}

console.log('All Server runtime workspace packages load from compiled dist JavaScript.');
