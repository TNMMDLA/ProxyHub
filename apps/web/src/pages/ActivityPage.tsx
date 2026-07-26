import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck, Search, ScrollText } from 'lucide-react';
import { api } from '../api';
import { Button, EmptyState, PageHeader, QueryErrorState, Status } from '../components/ui';
import type { AuditRecord, NotificationRecord } from '../types';
import { useTranslation } from 'react-i18next';
import { formatRelativeTime } from '../i18n/formatters';
import type { SupportedLocale } from '../i18n';

export default function ActivityPage({ mode }: { mode: 'notifications' | 'audit' }) {
  const { t, i18n } = useTranslation(['activity', 'common']);
  const locale: SupportedLocale = i18n.resolvedLanguage === 'zh-CN' ? 'zh-CN' : 'en';
  const client = useQueryClient();
  const [search, setSearch] = useState('');
  const isNotifications = mode === 'notifications';
  const query = useQuery<Array<NotificationRecord | AuditRecord>>({
    queryKey: [mode],
    queryFn: async () =>
      isNotifications
        ? api<NotificationRecord[]>('/notifications')
        : api<AuditRecord[]>('/audit-logs'),
  });
  const readAll = useMutation({
    mutationFn: () => api('/notifications/read-all', { method: 'POST' }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const markRead = useMutation({
    mutationFn: (id: string) => api(`/notifications/${id}/read`, { method: 'PATCH' }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const records = useMemo(
    () =>
      (query.data ?? []).filter((item) =>
        JSON.stringify(item).toLowerCase().includes(search.toLowerCase()),
      ),
    [query.data, search],
  );
  if (query.isError) {
    return <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }
  return (
    <>
      <PageHeader
        title={isNotifications ? t('activity:notifications') : t('activity:auditLogs')}
        description={
          isNotifications ? t('activity:notificationsDescription') : t('activity:auditDescription')
        }
        actions={
          isNotifications ? (
            <Button variant="secondary" onClick={() => readAll.mutate()}>
              <CheckCheck size={16} />
              {t('activity:markAllRead')}
            </Button>
          ) : undefined
        }
      />
      <div className="filter-bar">
        <Search size={17} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={
            isNotifications ? t('activity:searchNotifications') : t('activity:searchAudit')
          }
        />
        <span>{t('activity:records', { count: records.length })}</span>
      </div>
      {records.length ? (
        isNotifications ? (
          <section className="notification-list">
            {(records as NotificationRecord[]).map((item) => (
              <article key={item.id} className={item.readAt ? '' : 'unread'}>
                <span className={`notice-symbol ${item.level.toLowerCase()}`}>
                  <Bell size={18} />
                </span>
                <div>
                  <div>
                    <h3>{item.title}</h3>
                    <Status value={item.level} />
                    {!item.readAt ? (
                      <button className="notice-read" onClick={() => markRead.mutate(item.id)}>
                        {t('activity:markRead')}
                      </button>
                    ) : null}
                  </div>
                  <p>{item.message}</p>
                  <time>{formatRelativeTime(item.createdAt, locale)}</time>
                </div>
              </article>
            ))}
          </section>
        ) : (
          <section className="table-panel">
            <div className="responsive-table">
              <table>
                <thead>
                  <tr>
                    <th>{t('activity:time')}</th>
                    <th>{t('activity:actor')}</th>
                    <th>{t('activity:action')}</th>
                    <th>{t('activity:resource')}</th>
                    <th>{t('activity:ipAddress')}</th>
                    <th>{t('activity:result')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(records as AuditRecord[]).map((item) => (
                    <tr key={item.id}>
                      <td>{formatRelativeTime(item.createdAt, locale)}</td>
                      <td>
                        <b>{item.actorName}</b>
                      </td>
                      <td className="mono">{item.action}</td>
                      <td>{item.resource}</td>
                      <td className="mono">{item.ip ?? '—'}</td>
                      <td>
                        <Status value={item.result} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )
      ) : (
        <EmptyState
          icon={isNotifications ? <Bell /> : <ScrollText />}
          title={isNotifications ? t('activity:noNotifications') : t('activity:noAudit')}
          body={t('activity:empty')}
        />
      )}
    </>
  );
}
