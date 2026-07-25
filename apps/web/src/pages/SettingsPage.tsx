import { useQuery } from '@tanstack/react-query';
import { Box, Clock3, Database, GitCommitHorizontal, ServerCog } from 'lucide-react';
import type { ProxyHubHealthData } from '@proxyhub/shared';
import { api } from '../api';
import { PageHeader, QueryErrorState, Status } from '../components/ui';

function displayBuildTime(value: string): string {
  return value === 'unknown' ? 'Not embedded' : new Date(value).toLocaleString();
}

export default function SettingsPage() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => api<ProxyHubHealthData>('/health'),
    staleTime: 60_000,
  });
  if (health.isError) {
    return <QueryErrorState error={health.error} onRetry={() => void health.refetch()} />;
  }
  if (!health.data) {
    return (
      <div className="page-skeleton">
        <span />
        <span />
      </div>
    );
  }
  const metadata = health.data;
  const details = [
    { label: 'ProxyHub version', value: metadata.version, icon: Box },
    {
      label: 'Git commit',
      value: metadata.gitShortSha,
      title: metadata.gitSha,
      icon: GitCommitHorizontal,
    },
    { label: 'Build time', value: displayBuildTime(metadata.buildTime), icon: Clock3 },
    { label: 'Xray Core', value: metadata.xrayVersion, icon: ServerCog },
    {
      label: 'Migration fingerprint',
      value: metadata.database.migrationFingerprint.slice(0, 16),
      title: metadata.database.migrationFingerprint,
      icon: Database,
    },
  ];
  return (
    <>
      <PageHeader
        title="Settings"
        description="Read-only release identity for support, deployment and rollback verification."
      />
      <section className="release-identity">
        <header>
          <div>
            <span>Release identity</span>
            <h2>ProxyHub {metadata.version}</h2>
            <p>
              {metadata.buildEnvironment} build · {metadata.deployMode} deployment
            </p>
          </div>
          <Status value={metadata.status === 'ok' ? 'HEALTHY' : 'UNKNOWN'} />
        </header>
        <div className="release-identity-grid">
          {details.map((detail) => (
            <article key={detail.label}>
              <detail.icon size={18} />
              <div>
                <span>{detail.label}</span>
                <code title={detail.title}>{detail.value}</code>
              </div>
            </article>
          ))}
        </div>
        <p className="release-identity-note">
          This page contains public build metadata only. Secrets, environment values and database
          paths are never returned by the health endpoint.
        </p>
      </section>
    </>
  );
}
