import type { DeleteImpactResult, ResourceType } from '@proxyhub/shared';
import i18n from './i18n';
import { api } from './api';

export async function confirmDeleteWithImpact(
  resourceType: ResourceType,
  resourceId: string,
  name: string,
): Promise<boolean> {
  const impact = await api<DeleteImpactResult>(
    `/resources/${resourceType.toLowerCase()}/${resourceId}/delete-impact`,
  );
  const dependencies =
    impact.impacts.map((item) => `• ${item.name} (${item.code})`).join('\n') ||
    impact.usedBy.map((item) => `• ${item.name} (${item.relation})`).join('\n');
  if (impact.status === 'BLOCKED') {
    window.alert(i18n.t('common:deleteImpact.blocked', { dependencies }));
    return false;
  }
  return window.confirm(
    i18n.t(
      impact.status === 'WARNING' ? 'common:deleteImpact.warning' : 'common:deleteImpact.safe',
      { name, dependencies },
    ),
  );
}
