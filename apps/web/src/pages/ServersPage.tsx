import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  Cpu,
  HardDrive,
  MemoryStick,
  RefreshCw,
  Server as ServerIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import type { AgentStatusData } from '@proxyhub/shared';
import { api, formatRelative } from '../api';
import { Button, PageHeader, QueryErrorState, Status } from '../components/ui';
import type { ServerRecord } from '../types';

export default function ServersPage() {
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
      toast.success('Xray restart requested');
      void client.invalidateQueries({ queryKey: ['xray-status'] });
    },
    onError: (error) => toast.error(error.message),
  });
  if (servers.isError) {
    return <QueryErrorState error={servers.error} onRetry={() => void servers.refetch()} />;
  }
  return (
    <>
      <PageHeader
        title="Servers"
        description="Controller and Agent health across your infrastructure."
        actions={
          <Button onClick={() => restart.mutate()} disabled={restart.isPending}>
            <RefreshCw size={16} className={restart.isPending ? 'spin' : ''} />
            Restart Xray
          </Button>
        }
      />
      <section className="summary-strip">
        <div>
          <ServerIcon />
          <span>
            Registered servers<strong>{servers.data?.length ?? 0}</strong>
          </span>
        </div>
        <div>
          <Activity />
          <span>
            Xray status<strong>{xray.data?.xray.status ?? 'Unavailable'}</strong>
          </span>
        </div>
        <div>
          <Cpu />
          <span>
            System load<strong>{xray.data?.system.load.toFixed(2) ?? '—'}</strong>
          </span>
        </div>
        <div>
          <MemoryStick />
          <span>
            Memory used<strong>{xray.data?.system.memoryUsage ?? '—'}%</strong>
          </span>
        </div>
      </section>
      <section className="table-panel">
        <div className="section-heading">
          <h2>Infrastructure</h2>
          <p>
            Phase 1 operates the local controller; remote Agent enrollment is architecture-ready.
          </p>
        </div>
        <div className="responsive-table">
          <table>
            <thead>
              <tr>
                <th>Server</th>
                <th>Status</th>
                <th>Region</th>
                <th>Address</th>
                <th>Nodes</th>
                <th>Last heartbeat</th>
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
                  <td>{server.lastHeartbeat ? formatRelative(server.lastHeartbeat) : 'Never'}</td>
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
                ? 'Agent connection unavailable'
                : (xray.data?.xray.version ?? 'Xray Core unavailable')}
            </small>
          </span>
        </div>
        <Status value={xray.data?.xray.status ?? 'UNKNOWN'} />
      </section>
      {xray.data ? (
        <section className="xray-health-grid">
          <div>
            <span>Process</span>
            <Status value={xray.data.xray.checks.process.healthy ? 'HEALTHY' : 'OFFLINE'} />
          </div>
          <div>
            <span>Container heartbeat</span>
            <Status value={xray.data.xray.checks.container.healthy ? 'HEALTHY' : 'OFFLINE'} />
          </div>
          <div>
            <span>Configured ports</span>
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
                ? `${xray.data.xray.checks.ports.listening.length}/${xray.data.xray.checks.ports.configured.length} listening`
                : 'Config could not be read'}
            </small>
          </div>
          <div>
            <span>Config validity</span>
            <Status value={xray.data.xray.checks.config.healthy ? 'HEALTHY' : 'DEGRADED'} />
          </div>
        </section>
      ) : null}
    </>
  );
}
