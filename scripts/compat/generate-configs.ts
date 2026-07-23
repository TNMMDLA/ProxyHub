import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { compilePolicy } from '../../packages/policy-core/src/index.js';
import type { CompilerFormat, PolicyCompileInput } from '../../packages/policy-core/src/index.js';

const outputArgument = process.argv.indexOf('--output');
const prefixArgument = process.argv.indexOf('--prefix');
const filenamePrefix =
  prefixArgument >= 0 && process.argv[prefixArgument + 1] ? process.argv[prefixArgument + 1]! : '';
const outputDirectory = resolve(
  outputArgument >= 0 && process.argv[outputArgument + 1]
    ? process.argv[outputArgument + 1]!
    : '.tmp/compat',
);
const fixturePath = resolve('packages/policy-core/src/test-fixtures/basic-routing.input.json');
const input = JSON.parse(await readFile(fixturePath, 'utf8')) as PolicyCompileInput;
input.rules.push({
  id: 'compat-rule-set-reference',
  name: 'Compatibility Rule Set',
  description: 'Expanded from the local last known good cache fixture.',
  enabled: true,
  priority: 15,
  matchSourceType: 'RULE_SET',
  matchType: 'DOMAIN',
  matchValue: '',
  ruleSetId: 'compat-rule-set',
  ruleSetName: 'Compatibility Rules',
  actionType: 'DIRECT',
  nodePoolId: null,
});
input.ruleSets = [
  {
    id: 'compat-rule-set',
    name: 'Compatibility Rules',
    enabled: true,
    sourceType: 'REMOTE',
    status: 'READY',
    entries: [
      { type: 'DOMAIN_SUFFIX', value: 'openai.com', order: 0 },
      { type: 'IP_CIDR', value: '192.0.2.0/24', order: 1 },
    ],
  },
];
const outputs: Array<[CompilerFormat, string]> = [
  ['mihomo', 'mihomo.yaml'],
  ['sing-box', 'sing-box.json'],
  ['raw', 'raw.txt'],
];

await mkdir(outputDirectory, { recursive: true });
for (const [format, filename] of outputs) {
  const result = compilePolicy(input, format);
  if (!result.success) {
    throw new Error(`${format} fixture compilation failed: ${JSON.stringify(result.errors)}`);
  }
  await writeFile(resolve(outputDirectory, `${filenamePrefix}${filename}`), result.output, 'utf8');
}

process.stdout.write(`Generated compatibility fixtures in ${outputDirectory}\n`);
