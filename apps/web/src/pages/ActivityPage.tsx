import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck, Search, ScrollText } from 'lucide-react';
import { api, formatRelative } from '../api';
import { Button, EmptyState, PageHeader, QueryErrorState, Status } from '../components/ui';
import type { AuditRecord, NotificationRecord } from '../types';

export default function ActivityPage({ mode }: { mode: 'notifications' | 'audit' }) {
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
        title={isNotifications ? 'Notifications' : 'Audit Logs'}
        description={
          isNotifications
            ? 'Operational events and security signals in one searchable stream.'
            : 'Immutable visibility into every important administrative operation.'
        }
        actions={
          isNotifications ? (
            <Button variant="secondary" onClick={() => readAll.mutate()}>
              <CheckCheck size={16} />
              Mark all read
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
            isNotifications ? 'Search notifications...' : 'Search actor, action or resource...'
          }
        />
        <span>{records.length} records</span>
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
                        Mark read
                      </button>
                    ) : null}
                  </div>
                  <p>{item.message}</p>
                  <time>{formatRelative(item.createdAt)}</time>
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
                    <th>Time</th>
                    <th>Actor</th>
                    <th>Action</th>
                    <th>Resource</th>
                    <th>IP address</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {(records as AuditRecord[]).map((item) => (
                    <tr key={item.id}>
                      <td>{formatRelative(item.createdAt)}</td>
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
          title={isNotifications ? 'No notifications' : 'No audit activity'}
          body="Events will appear here as the platform is used."
        />
      )}
    </>
  );
}
