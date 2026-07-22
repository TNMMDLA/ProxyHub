import type { NormalizedPolicyInput } from '../types.js';

export function compileRaw(input: NormalizedPolicyInput): string {
  return input.nodes.map((node) => node.uri).join('\n') + (input.nodes.length ? '\n' : '');
}
