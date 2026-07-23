import { compileMihomo } from './adapters/mihomo.js';
import { compileRaw } from './adapters/raw.js';
import { compileSingBox } from './adapters/singbox.js';
import { ADAPTER_METADATA } from './capabilities.js';
import { normalizePolicyInput } from './normalizer.js';
import type { CompilerFormat, CompilerResult, PolicyCompileInput } from './types.js';
import { validatePolicy } from './validator.js';

export function compilePolicy(input: PolicyCompileInput, format: CompilerFormat): CompilerResult {
  const normalized = normalizePolicyInput(input);
  const { warnings, errors } = validatePolicy(normalized, format);
  let output = '';
  if (errors.length === 0) {
    output =
      format === 'mihomo'
        ? compileMihomo(normalized)
        : format === 'sing-box'
          ? compileSingBox(normalized)
          : compileRaw(normalized);
  }
  return {
    success: errors.length === 0,
    format,
    output,
    warnings,
    errors,
    metadata: {
      policyId: normalized.policy.id,
      revision: normalized.policy.revision,
      ruleCount: normalized.rules.length,
      sourceRuleCount: input.rules.filter((rule) => rule.enabled).length,
      expandedRuleCount: normalized.rules.length,
      ruleSetCount: normalized.referencedRuleSetCount,
      nodeCount: normalized.nodes.length,
      poolCount: normalized.nodePools.length,
      adapter: ADAPTER_METADATA[format],
    },
  };
}
