import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  Cpu,
  HardDrive,
  MemoryStick,
  RefreshCw,
  Server as ServerIcon,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import type { AgentStatusData } from '@proxyhub/shared';
import { api } from '../api';
import { Button, PageHeader, QueryErrorState, Status } from '../components/ui';
import type { ServerRecord } from '../types';
import { useTranslation } from 'react-i18next';
import { formatRelativeTime } from '../i18n/formatters';
import type { SupportedLocale } from '../i18n';
import { confirmDeleteWithImpact } from '../delete-impact';

export default function ServersPage() {
  const { t, i18n } = useTranslation(['resources', 'common']);
  const locale: SupportedLocale = i18n.resolvedLanguage === 'zh-CN' ? 'zh-CN' : 'en';
  const client = useQueryClient();
  const servers = useQuery({
    queryKey: ['servers'],
    queryFn: () => api<ServerRecord[]>('/servers'),
  });
  const xray = useQuery({
    queryKey: ['xray-status'],
    queryFn: () => api<AgentStatusData>('/xray/status'),
    retry: false,
  });
  const restart = useMutation({
    mutationFn: () => api('/xray/restart', { method: 'POST' }),
    onSuccess: () => {
      toast.success(t('resources:servers.restartRequested'));
      void client.invalidateQueries({ queryKey: ['xray-status'] });
    },
    onError: (error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/servers/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['servers'] }),
        client.invalidateQueries({ queryKey: ['dashboard'] }),
        client.invalidateQueries({ queryKey: ['setup-progress'] }),
      ]);
      toast.success(t('resources:servers.deleted'));
    },
    onError: (error) => toast.error(error.message),
  });
  if (servers.isError) {
    return <QueryErrorState error={servers.error} onRetry={() => void servers.refetch()} />;
  }
  return (
    <>
      <PageHeader
        title={t('resources:servers.title')}
        description={t('resources:servers.description')}
        actions={
          <Button onClick={() => restart.mutate()} disabled={restart.isPending}>
            <RefreshCw size={16} className={restart.isPending ? 'spin' : ''} />
            {t('resources:servers.restartXray')}
          </Button>
        }
      />
      <section className="summary-strip">
        <div>
          <ServerIcon />
          <span>
            {t('resources:servers.registered')}
            <strong>{servers.data?.length ?? 0}</strong>
          </span>
        </div>
        <div>
          <Activity />
          <span>
            {t('resources:servers.xrayStatus')}
            <strong>{xray.data?.xray.status ?? t('common:unavailable')}</strong>
          </span>
        </div>
        <div>
          <Cpu />
          <span>
            {t('resources:servers.systemLoad')}
            <strong>{xray.data?.system.load.toFixed(2) ?? '—'}</strong>
          </span>
        </div>
        <div>
          <MemoryStick />
          <span>
            {t('resources:servers.memoryUsed')}
            <strong>{xray.data?.system.memoryUsage ?? '—'}%</strong>
          </span>
        </div>
      </section>
      <section className="table-panel">
        <div className="section-heading">
          <h2>{t('resources:servers.infrastructure')}</h2>
          <p>{t('resources:servers.phaseNote')}</p>
        </div>
        <div className="responsive-table">
          <table>
            <thead>
              <tr>
                <th>{t('resources:servers.server')}</th>
                <th>{t('common:status')}</th>
                <th>{t('resources:servers.region')}</th>
                <th>{t('resources:servers.address')}</th>
                <th>{t('resources:servers.nodes')}</th>
                <th>{t('resources:servers.lastHeartbeat')}</th>
                <th>{t('common:actions')}</th>
              </tr>
            </thead>
            <tbody>
              {servers.data?.map((server) => (
                <tr key={server.id}>
                  <td>
                    <span className="name-cell">
                      <i />
                      <b>{server.name}</b>
                      <small>{server.hostname}</small>
                    </span>
                  </td>
                  <td>
                    <Status value={server.status} />
                  </td>
                  <td>{server.region}</td>
                  <td className="mono">{server.ip}</td>
                  <td>{server._count?.nodes ?? 0}</td>
                  <td>
                    {server.lastHeartbeat
                      ? formatRelativeTime(server.lastHeartbeat, locale)
                      : t('common:never')}
                  </td>
                  <td>
                    <button
                      className="icon-danger"
                      type="button"
                      aria-label={t('resources:servers.delete')}
                      disabled={remove.isPending}
                      onClick={() => {
                        void confirmDeleteWithImpact('SERVER', server.id, server.name).then(
                          (confirmed) => {
                            if (confirmed) remove.mutate(server.id);
                          },
                        );
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="xray-detail">
        <div>
          <HardDrive size={20} />
          <span>
            <b>Xray Core</b>
            <small>
              {xray.isError
                ? t('resources:servers.agentUnavailable')
                : (xray.data?.xray.version ?? t('resources:servers.xrayUnavailable'))}
            </small>
          </span>
        </div>
        <Status value={xray.data?.xray.status ?? 'UNKNOWN'} />
      </section>
      {xray.data ? (
        <section className="xray-health-grid">
          <div>
            <span>{t('resources:servers.process')}</span>
            <Status value={xray.data.xray.checks.process.healthy ? 'HEALTHY' : 'OFFLINE'} />
          </div>
          <div>
            <span>{t('resources:servers.containerHeartbeat')}</span>
            <Status value={xray.data.xray.checks.container.healthy ? 'HEALTHY' : 'OFFLINE'} />
          </div>
          <div>
            <span>{t('resources:servers.configuredPorts')}</span>
            <Status
              value={
                !xray.data.xray.checks.ports.known
                  ? 'UNKNOWN'
                  : xray.data.xray.checks.ports.healthy
                    ? 'HEALTHY'
                    : 'DEGRADED'
              }
            />
            <small>
              {xray.data.xray.checks.ports.known
                ? t('resources:servers.listening', {
                    listening: xray.data.xray.checks.ports.listening.length,
                    configured: xray.data.xray.checks.ports.configured.length,
                  })
                : t('resources:servers.configUnreadable')}
            </small>
          </div>
          <div>
            <span>{t('resources:servers.configValidity')}</span>
            <Status value={xray.data.xray.checks.config.healthy ? 'HEALTHY' : 'DEGRADED'} />
          </div>
        </section>
      ) : null}
    </>
  );
}
