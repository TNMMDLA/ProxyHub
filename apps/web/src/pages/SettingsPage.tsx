import { useQuery } from '@tanstack/react-query';
import { Box, Clock3, Database, GitCommitHorizontal, ServerCog } from 'lucide-react';
import type { ProxyHubHealthData } from '@proxyhub/shared';
import { api } from '../api';
import { PageHeader, QueryErrorState, Status } from '../components/ui';
import { useTranslation } from 'react-i18next';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { formatDateTime } from '../i18n/formatters';
import type { SupportedLocale } from '../i18n';

export default function SettingsPage() {
  const { t, i18n } = useTranslation(['settings', 'common']);
  const locale: SupportedLocale = i18n.resolvedLanguage === 'zh-CN' ? 'zh-CN' : 'en';
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
    { label: t('settings:version'), value: metadata.version, icon: Box },
    {
      label: t('settings:gitCommit'),
      value: metadata.gitShortSha,
      title: metadata.gitSha,
      icon: GitCommitHorizontal,
    },
    {
      label: t('settings:buildTime'),
      value:
        metadata.buildTime === 'unknown'
          ? t('common:notEmbedded')
          : formatDateTime(metadata.buildTime, locale),
      icon: Clock3,
    },
    { label: t('settings:xrayCore'), value: metadata.xrayVersion, icon: ServerCog },
    {
      label: t('settings:migrationFingerprint'),
      value: metadata.database.migrationFingerprint.slice(0, 16),
      title: metadata.database.migrationFingerprint,
      icon: Database,
    },
  ];
  return (
    <>
      <PageHeader title={t('settings:title')} description={t('settings:description')} />
      <section className="settings-language-card">
        <div>
          <h2>{t('settings:languageTitle')}</h2>
          <p>{t('settings:languageDescription')}</p>
        </div>
        <LanguageSwitcher />
      </section>
      <section className="release-identity">
        <header>
          <div>
            <span>{t('settings:releaseIdentity')}</span>
            <h2>ProxyHub {metadata.version}</h2>
            <p>
              {t('settings:buildDeployment', {
                environment: metadata.buildEnvironment,
                mode: metadata.deployMode,
              })}
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
        <p className="release-identity-note">{t('settings:metadataNote')}</p>
      </section>
    </>
  );
}
