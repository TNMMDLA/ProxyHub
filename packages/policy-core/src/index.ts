/** Stable client-agnostic policy boundary reserved for the Policy Studio phase. */
export interface ProxyHubPolicy {
  id: string;
  metadata: { name: string; version: number; status: 'DRAFT' | 'PUBLISHED' };
  rules: PolicyRule[];
  ruleSets: unknown[];
  proxyGroups: unknown[];
  dns: Record<string, unknown>;
  clientSettings: Record<string, unknown>;
  routing: Record<string, unknown>;
}

export interface PolicyRule {
  id: string;
  name: string;
  priority: number;
  enabled: boolean;
  match: { type: string; value?: string };
  action: { type: 'route' | 'direct' | 'reject'; target?: string };
}
