import { createHash } from 'node:crypto';
import { ADAPTER_METADATA, type CompilerFormat, type CompilerNode } from '@proxyhub/policy-core';
import { AppError } from './errors.js';
import { compileStoredPolicy } from './policy-service.js';
import { runSubscriptionReadiness, type SubscriptionCandidate } from './subscription-readiness.js';

const MAX_PREVIEW_BYTES = 1024 * 1024;
const MAX_PREVIEW_NODES = 100;
const MAX_PREVIEW_RULES = 2_000;

export function contentTypeFor(format: CompilerFormat): string {
  return format === 'mihomo'
    ? 'text/yaml; charset=utf-8'
    : format === 'sing-box'
      ? 'application/json; charset=utf-8'
      : 'text/plain; charset=utf-8';
}

export function sanitizeSubscriptionOutput(output: string, nodes: CompilerNode[]): string {
  let sanitized = output;
  for (const node of nodes) {
    if (node.uuid) sanitized = sanitized.split(node.uuid).join('[REDACTED-UUID]');
    if (node.shortId) sanitized = sanitized.split(node.shortId).join('[REDACTED-SHORT-ID]');
  }
  return sanitized
    .replace(/(\/sub\/)[^/?#\s"']+/gi, '$1[REDACTED-TOKEN]')
    .replace(/(vless:\/\/)[^@\s]+@/gi, '$1[REDACTED-UUID]@')
    .replace(
      /([?&](?:token|access_token|auth|authorization|key|secret)=)[^&#\s"']+/gi,
      '$1[REDACTED]',
    )
    .replace(/(authorization\s*[:=]\s*)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(
      /((?:privateKey|private_key|private-key)\s*["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi,
      '$1[REDACTED]',
    );
}

function truncateUtf8(value: string, maximumBytes: number): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= maximumBytes) return { value, truncated: false };
  return {
    value: bytes
      .subarray(0, maximumBytes)
      .toString('utf8')
      .replace(/\uFFFD$/u, ''),
    truncated: true,
  };
}

export async function generateSubscriptionPreview(
  candidate: SubscriptionCandidate,
  requestedFormat?: CompilerFormat,
) {
  const format = requestedFormat ?? candidate.format;
  const effective = { ...candidate, format };
  const readiness = await runSubscriptionReadiness(effective, { cache: false });
  if (readiness.status === 'BLOCKED') {
    throw new AppError(
      'SUBSCRIPTION_NOT_READY',
      'Subscription is not ready for preview',
      422,
      readiness,
    );
  }
  const { input, result } = await compileStoredPolicy(candidate.policyId, format);
  if (!result.success) {
    throw new AppError(
      'SUBSCRIPTION_COMPILE_FAILED',
      'Subscription policy could not be compiled',
      422,
      {
        stage: 'COMPILER',
        format,
        diagnostics: result.errors,
      },
    );
  }
  const sanitized = sanitizeSubscriptionOutput(result.output, input.nodes);
  const limited = truncateUtf8(sanitized, MAX_PREVIEW_BYTES);
  const limitsExceeded =
    result.metadata.nodeCount > MAX_PREVIEW_NODES ||
    result.metadata.expandedRuleCount > MAX_PREVIEW_RULES;
  return {
    format,
    contentType: contentTypeFor(format),
    output: limited.value,
    sanitized: true,
    truncated: limited.truncated || limitsExceeded,
    originalBytes: Buffer.byteLength(sanitized),
    displayedBytes: Buffer.byteLength(limited.value),
    limits: {
      maxBytes: MAX_PREVIEW_BYTES,
      maxNodes: MAX_PREVIEW_NODES,
      maxRules: MAX_PREVIEW_RULES,
      timeoutMs: 10_000,
      concurrency: 2,
    },
    metadata: result.metadata,
    warnings: result.warnings,
    readiness,
  };
}

export async function testSubscriptionResponse(candidate: SubscriptionCandidate) {
  const readiness = await runSubscriptionReadiness(candidate, { cache: false });
  if (readiness.status === 'BLOCKED') {
    return {
      accessible: false,
      statusCode: candidate.enabled ? 422 : 403,
      errorCode:
        readiness.checks.find((item) => item.status === 'FAILED')?.errorCode ??
        'SUBSCRIPTION_NOT_READY',
      token: '[REDACTED]',
      readiness,
    };
  }
  const { result } = await compileStoredPolicy(candidate.policyId, candidate.format);
  const etag = `"${createHash('sha256').update(result.output).digest('hex')}"`;
  return {
    accessible: true,
    statusCode: 200,
    contentType: contentTypeFor(candidate.format),
    cacheControl: 'private, no-store',
    etag,
    responseBytes: Buffer.byteLength(result.output),
    format: candidate.format,
    token: '[REDACTED]',
    compileSuccess: result.success,
    readiness,
  };
}

export function subscriptionCapabilities() {
  return (['mihomo', 'sing-box', 'raw'] as const).map((format) => {
    const metadata = ADAPTER_METADATA[format];
    return {
      format,
      validatedAgainst: metadata.validatedAgainst,
      features: {
        nodes: 'SUPPORTED',
        reality: 'SUPPORTED',
        visionFlow: 'SUPPORTED',
        proxyGroups:
          format === 'mihomo' ? 'SUPPORTED' : format === 'sing-box' ? 'PARTIAL' : 'NOT_APPLICABLE',
        nodePoolMapping: format === 'raw' ? 'NOT_APPLICABLE' : 'SUPPORTED',
        routingRules: metadata.capabilities.routing ? 'SUPPORTED' : 'UNSUPPORTED',
        ruleSets: metadata.capabilities.routing ? 'SUPPORTED' : 'UNSUPPORTED',
        dns: 'UNSUPPORTED',
        finalRule: metadata.capabilities.routing ? 'SUPPORTED' : 'NOT_APPLICABLE',
        subscriptionToken: 'SUPPORTED',
        etag: 'SUPPORTED',
        configPreview: 'SUPPORTED',
      },
      supportedRuleTypes: metadata.capabilities.ruleTypes,
    };
  });
}
