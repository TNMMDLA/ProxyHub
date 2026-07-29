import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Copy,
  KeyRound,
  Pencil,
  Plus,
  Power,
  PowerOff,
  RefreshCcw,
  Trash2,
  UserRound,
  UsersRound,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '../api';
import {
  Button,
  EmptyState,
  Input,
  Modal,
  PageHeader,
  QueryErrorState,
  Status,
} from '../components/ui';
import { formatBytes, formatDateTime } from '../i18n/formatters';
import type {
  EffectiveUserStatus,
  NodeRecord,
  UserAccessRecord,
  UserGroupRecord,
  UserListRecord,
  UserRecord,
} from '../types';

interface UserForm {
  name: string;
  remark: string;
  groupId: string;
  trafficLimitGiB: string;
  expiresAt: string;
  resetPolicy: 'NEVER' | 'MONTHLY';
  resetDay: string;
  nodeIds: string[];
}

const emptyForm: UserForm = {
  name: '',
  remark: '',
  groupId: '',
  trafficLimitGiB: '',
  expiresAt: '',
  resetPolicy: 'NEVER',
  resetDay: '1',
  nodeIds: [],
};

function payloadOf(form: UserForm, editing: boolean) {
  const trafficLimitBytes = form.trafficLimitGiB
    ? (BigInt(form.trafficLimitGiB) * 1024n * 1024n * 1024n).toString()
    : null;
  return {
    name: form.name,
    remark: form.remark,
    groupId: form.groupId || null,
    trafficLimitBytes,
    expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
    resetPolicy: form.resetPolicy,
    resetDay: form.resetPolicy === 'MONTHLY' ? Number(form.resetDay) : null,
    ...(!editing ? { nodeIds: form.nodeIds } : {}),
  };
}

function formOf(user: UserRecord): UserForm {
  return {
    name: user.name,
    remark: user.remark,
    groupId: user.groupId ?? '',
    trafficLimitGiB: user.trafficLimitBytes
      ? (BigInt(user.trafficLimitBytes) / 1024n / 1024n / 1024n).toString()
      : '',
    expiresAt: user.expiresAt ? user.expiresAt.slice(0, 16) : '',
    resetPolicy: user.resetPolicy,
    resetDay: String(user.resetDay ?? 1),
    nodeIds: user.accesses.map((access) => access.node.id),
  };
}

export default function UsersPage() {
  const { t, i18n } = useTranslation(['users', 'common']);
  const locale = i18n.language === 'zh-CN' ? 'zh-CN' : 'en';
  const client = useQueryClient();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<EffectiveUserStatus | ''>('');
  const [groupId, setGroupId] = useState('');
  const [page, setPage] = useState(1);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<UserForm>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [groupDescription, setGroupDescription] = useState('');
  const [groupEditingId, setGroupEditingId] = useState<string | null>(null);

  const query = new URLSearchParams({ page: String(page), limit: '25' });
  if (search) query.set('search', search);
  if (status) query.set('status', status);
  if (groupId) query.set('groupId', groupId);
  const users = useQuery({
    queryKey: ['users', page, search, status, groupId],
    queryFn: () => api<UserListRecord>(`/users?${query.toString()}`),
  });
  const groups = useQuery({
    queryKey: ['user-groups'],
    queryFn: () => api<UserGroupRecord[]>('/user-groups'),
  });
  const nodes = useQuery({
    queryKey: ['nodes'],
    queryFn: () => api<NodeRecord[]>('/nodes'),
  });
  const selected = useQuery({
    queryKey: ['user', selectedId],
    queryFn: () => api<UserRecord>(`/users/${selectedId}`),
    enabled: selectedId !== null,
  });

  const invalidate = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['users'] }),
      client.invalidateQueries({ queryKey: ['user', selectedId] }),
      client.invalidateQueries({ queryKey: ['node-users'] }),
    ]);
  };
  const save = useMutation({
    mutationFn: () =>
      api<UserRecord>(editingId ? `/users/${editingId}` : '/users', {
        method: editingId ? 'PATCH' : 'POST',
        body: JSON.stringify(payloadOf(form, Boolean(editingId))),
      }),
    onSuccess: async (record) => {
      toast.success(t(editingId ? 'users:messages.updated' : 'users:messages.created'));
      setFormOpen(false);
      setEditingId(null);
      setForm(emptyForm);
      setSelectedId(record.id);
      await invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const action = useMutation({
    mutationFn: ({ path, method = 'POST' }: { path: string; method?: string }) =>
      api(path, { method }),
    onSuccess: (_data, variables) => {
      if (variables.method === 'DELETE' && variables.path === `/users/${selectedId}`) {
        setSelectedId(null);
      }
      void invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const createGroup = useMutation({
    mutationFn: () =>
      api<UserGroupRecord>(groupEditingId ? `/user-groups/${groupEditingId}` : '/user-groups', {
        method: groupEditingId ? 'PATCH' : 'POST',
        body: JSON.stringify({ name: groupName, description: groupDescription }),
      }),
    onSuccess: async () => {
      setGroupName('');
      setGroupDescription('');
      setGroupEditingId(null);
      await client.invalidateQueries({ queryKey: ['user-groups'] });
      toast.success(
        t(groupEditingId ? 'users:messages.groupUpdated' : 'users:messages.groupCreated'),
      );
    },
    onError: (error) => toast.error(error.message),
  });
  const deleteGroup = useMutation({
    mutationFn: (id: string) => api(`/user-groups/${id}`, { method: 'DELETE' }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['user-groups'] }),
    onError: (error) => toast.error(error.message),
  });
  const grantAccess = useMutation({
    mutationFn: ({ userId, nodeIds }: { userId: string; nodeIds: string[] }) =>
      api(`/users/${userId}/access`, {
        method: 'POST',
        body: JSON.stringify({ nodeIds }),
      }),
    onSuccess: () => void invalidate(),
    onError: (error) => toast.error(error.message),
  });

  const summary = useMemo(() => {
    const items = users.data?.items ?? [];
    return {
      active: items.filter((user) => user.status === 'ACTIVE').length,
      exhausted: items.filter((user) => user.status === 'TRAFFIC_EXHAUSTED').length,
      traffic: items.reduce(
        (total, user) => total + BigInt(user.traffic.currentCycleTotalBytes),
        0n,
      ),
    };
  }, [users.data]);
  const availableNodes =
    nodes.data?.filter(
      (node) =>
        node.protocol === 'VLESS' &&
        ['TCP', 'RAW'].includes(node.transport) &&
        node.flow === 'xtls-rprx-vision',
    ) ?? [];

  if (users.isError || groups.isError || nodes.isError) {
    return (
      <QueryErrorState
        error={users.error ?? groups.error ?? nodes.error}
        onRetry={() => {
          void users.refetch();
          void groups.refetch();
          void nodes.refetch();
        }}
      />
    );
  }

  return (
    <>
      <PageHeader
        title={t('users:title')}
        description={t('users:description')}
        actions={
          <>
            <Button variant="secondary" onClick={() => setGroupsOpen(true)}>
              <UsersRound size={16} />
              {t('users:groups.manage')}
            </Button>
            <Button
              onClick={() => {
                setEditingId(null);
                setForm(emptyForm);
                setFormOpen(true);
              }}
            >
              <Plus size={16} />
              {t('users:create')}
            </Button>
          </>
        }
      />

      <section className="summary-strip users-summary">
        <div>
          <UserRound size={20} />
          <span>
            {t('users:summary.total')}
            <strong>{users.data?.total ?? 0}</strong>
          </span>
        </div>
        <div>
          <Power size={20} />
          <span>
            {t('users:summary.active')}
            <strong>{summary.active}</strong>
          </span>
        </div>
        <div>
          <PowerOff size={20} />
          <span>
            {t('users:summary.exhausted')}
            <strong>{summary.exhausted}</strong>
          </span>
        </div>
        <div>
          <RefreshCcw size={20} />
          <span>
            {t('users:summary.cycleTraffic')}
            <strong>{formatBytes(summary.traffic, locale)}</strong>
          </span>
        </div>
      </section>

      <section className="users-toolbar">
        <Input
          label={t('users:filters.search')}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
          placeholder={t('users:filters.searchPlaceholder')}
        />
        <label className="field">
          <span>{t('users:filters.status')}</span>
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as EffectiveUserStatus | '');
              setPage(1);
            }}
          >
            <option value="">{t('users:filters.allStatuses')}</option>
            {(['ACTIVE', 'DISABLED', 'EXPIRED', 'TRAFFIC_EXHAUSTED'] as const).map((value) => (
              <option value={value} key={value}>
                {t(`common:statusLabels.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('users:filters.group')}</span>
          <select
            value={groupId}
            onChange={(event) => {
              setGroupId(event.target.value);
              setPage(1);
            }}
          >
            <option value="">{t('users:filters.allGroups')}</option>
            {groups.data?.map((group) => (
              <option value={group.id} key={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </label>
      </section>

      {users.data?.items.length ? (
        <>
          <section className="table-panel users-table">
            <div className="responsive-table">
              <table>
                <thead>
                  <tr>
                    <th>{t('users:columns.user')}</th>
                    <th>{t('users:columns.status')}</th>
                    <th>{t('users:columns.traffic')}</th>
                    <th>{t('users:columns.quota')}</th>
                    <th>{t('users:columns.nodes')}</th>
                    <th>{t('users:columns.lastActivity')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {users.data.items.map((user) => (
                    <tr key={user.id}>
                      <td>
                        <span className="name-cell">
                          <i className={user.status === 'ACTIVE' ? '' : 'disabled'} />
                          <b>{user.name}</b>
                          <small>{user.group?.name ?? t('users:noGroup')}</small>
                        </span>
                      </td>
                      <td>
                        <Status value={user.status} />
                      </td>
                      <td>{formatBytes(user.traffic.currentCycleTotalBytes, locale)}</td>
                      <td>
                        {user.trafficLimitBytes
                          ? formatBytes(user.trafficLimitBytes, locale)
                          : t('users:unlimited')}
                      </td>
                      <td>{user.accesses.length}</td>
                      <td>
                        {user.lastTrafficAt
                          ? formatDateTime(user.lastTrafficAt, locale)
                          : t('users:noActivity')}
                      </td>
                      <td>
                        <div className="row-actions">
                          <Button
                            variant="ghost"
                            aria-label={t('users:actions.details')}
                            onClick={() => setSelectedId(user.id)}
                          >
                            <UserRound size={15} />
                          </Button>
                          <Button
                            variant="ghost"
                            aria-label={t('common:edit')}
                            onClick={() => {
                              setEditingId(user.id);
                              setForm(formOf(user));
                              setFormOpen(true);
                            }}
                          >
                            <Pencil size={15} />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <div className="users-pagination">
            <Button
              variant="secondary"
              disabled={page === 1}
              onClick={() => setPage((value) => value - 1)}
            >
              {t('common:previous')}
            </Button>
            <span>
              {t('users:pagination', {
                page,
                pages: Math.max(1, Math.ceil(users.data.total / users.data.limit)),
              })}
            </span>
            <Button
              variant="secondary"
              disabled={page * users.data.limit >= users.data.total}
              onClick={() => setPage((value) => value + 1)}
            >
              {t('common:next')}
            </Button>
          </div>
        </>
      ) : (
        <EmptyState
          icon={<UserRound />}
          title={t('users:empty.title')}
          body={t('users:empty.body')}
          action={<Button onClick={() => setFormOpen(true)}>{t('users:create')}</Button>}
        />
      )}

      {formOpen ? (
        <Modal
          title={t(editingId ? 'users:form.editTitle' : 'users:form.createTitle')}
          description={t('users:form.description')}
          onClose={() => setFormOpen(false)}
          className="user-modal"
        >
          <form
            className="modal-form"
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate();
            }}
          >
            <div className="form-grid">
              <Input
                required
                label={t('users:form.name')}
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
              <Input
                label={t('users:form.remark')}
                value={form.remark}
                onChange={(event) => setForm({ ...form, remark: event.target.value })}
              />
              <label className="field">
                <span>{t('users:form.group')}</span>
                <select
                  value={form.groupId}
                  onChange={(event) => setForm({ ...form, groupId: event.target.value })}
                >
                  <option value="">{t('users:noGroup')}</option>
                  {groups.data?.map((group) => (
                    <option value={group.id} key={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
              </label>
              <Input
                type="number"
                min="1"
                label={t('users:form.quotaGiB')}
                value={form.trafficLimitGiB}
                onChange={(event) => setForm({ ...form, trafficLimitGiB: event.target.value })}
              />
              <Input
                type="datetime-local"
                label={t('users:form.expiresAt')}
                value={form.expiresAt}
                onChange={(event) => setForm({ ...form, expiresAt: event.target.value })}
              />
              <label className="field">
                <span>{t('users:form.resetPolicy')}</span>
                <select
                  value={form.resetPolicy}
                  onChange={(event) =>
                    setForm({ ...form, resetPolicy: event.target.value as UserForm['resetPolicy'] })
                  }
                >
                  <option value="NEVER">{t('users:form.never')}</option>
                  <option value="MONTHLY">{t('users:form.monthly')}</option>
                </select>
              </label>
              {form.resetPolicy === 'MONTHLY' ? (
                <Input
                  type="number"
                  min="1"
                  max="28"
                  required
                  label={t('users:form.resetDay')}
                  value={form.resetDay}
                  onChange={(event) => setForm({ ...form, resetDay: event.target.value })}
                />
              ) : null}
            </div>
            {!editingId ? (
              <fieldset className="node-checklist">
                <legend>{t('users:form.initialNodes')}</legend>
                {availableNodes.map((node) => (
                  <label key={node.id}>
                    <input
                      type="checkbox"
                      checked={form.nodeIds.includes(node.id)}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          nodeIds: event.target.checked
                            ? [...form.nodeIds, node.id]
                            : form.nodeIds.filter((id) => id !== node.id),
                        })
                      }
                    />
                    <span>{node.name}</span>
                    <small>{node.server.name}</small>
                  </label>
                ))}
              </fieldset>
            ) : null}
            <div className="modal-actions">
              <Button type="button" variant="secondary" onClick={() => setFormOpen(false)}>
                {t('common:cancel')}
              </Button>
              <Button type="submit" disabled={save.isPending}>
                {t('common:save')}
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}

      {selectedId ? (
        <Modal
          title={selected.data?.name ?? t('users:details.title')}
          description={t('users:details.description')}
          onClose={() => setSelectedId(null)}
          className="user-detail-modal"
        >
          {selected.isError ? (
            <QueryErrorState error={selected.error} onRetry={() => void selected.refetch()} />
          ) : selected.data ? (
            <UserDetails
              user={selected.data}
              nodes={availableNodes}
              locale={locale}
              busy={action.isPending || grantAccess.isPending}
              onAction={(path, method) =>
                action.mutate({ path, ...(method !== undefined ? { method } : {}) })
              }
              onGrant={(nodeIds) => grantAccess.mutate({ userId: selected.data.id, nodeIds })}
              onShare={async (access) => {
                try {
                  const result = await api<{ uri: string }>(
                    `/users/${selected.data.id}/access/${access.id}/share-link`,
                    { method: 'POST' },
                  );
                  await navigator.clipboard.writeText(result.uri);
                  toast.success(t('common:copied'));
                } catch (error) {
                  toast.error((error as Error).message);
                }
              }}
            />
          ) : null}
        </Modal>
      ) : null}

      {groupsOpen ? (
        <Modal
          title={t('users:groups.title')}
          description={t('users:groups.description')}
          onClose={() => setGroupsOpen(false)}
        >
          <form
            className="modal-form group-create"
            onSubmit={(event) => {
              event.preventDefault();
              createGroup.mutate();
            }}
          >
            <Input
              required
              label={t('users:groups.name')}
              value={groupName}
              onChange={(event) => setGroupName(event.target.value)}
            />
            <Input
              label={t('users:groups.groupDescription')}
              value={groupDescription}
              onChange={(event) => setGroupDescription(event.target.value)}
            />
            <Button type="submit" disabled={createGroup.isPending}>
              {groupEditingId ? <Pencil size={15} /> : <Plus size={15} />}
              {t(groupEditingId ? 'common:save' : 'users:groups.create')}
            </Button>
          </form>
          <div className="group-list">
            {groups.data?.map((group) => (
              <article key={group.id}>
                <div>
                  <b>{group.name}</b>
                  <small>{group.description || t('users:groups.noDescription')}</small>
                </div>
                <span>{t('users:groups.userCount', { count: group._count?.users ?? 0 })}</span>
                <Button
                  variant="ghost"
                  aria-label={t('common:edit')}
                  onClick={() => {
                    setGroupEditingId(group.id);
                    setGroupName(group.name);
                    setGroupDescription(group.description);
                  }}
                >
                  <Pencil size={14} />
                </Button>
                <Button
                  variant="danger"
                  aria-label={t('common:delete')}
                  disabled={(group._count?.users ?? 0) > 0}
                  onClick={() => deleteGroup.mutate(group.id)}
                >
                  <Trash2 size={14} />
                </Button>
              </article>
            ))}
          </div>
        </Modal>
      ) : null}
    </>
  );
}

function UserDetails({
  user,
  nodes,
  locale,
  busy,
  onAction,
  onGrant,
  onShare,
}: {
  user: UserRecord;
  nodes: NodeRecord[];
  locale: 'en' | 'zh-CN';
  busy: boolean;
  onAction: (path: string, method?: string) => void;
  onGrant: (nodeIds: string[]) => void;
  onShare: (access: UserAccessRecord) => void;
}) {
  const { t } = useTranslation(['users', 'common']);
  const [nodeIds, setNodeIds] = useState<string[]>([]);
  const granted = new Set(user.accesses.map((access) => access.node.id));
  const available = nodes.filter((node) => !granted.has(node.id));
  return (
    <div className="user-details">
      <div className="user-detail-metrics">
        <div>
          <span>{t('users:details.status')}</span>
          <Status value={user.status} />
        </div>
        <div>
          <span>{t('users:details.currentTraffic')}</span>
          <b>{formatBytes(user.traffic.currentCycleTotalBytes, locale)}</b>
        </div>
        <div>
          <span>{t('users:details.lifetimeTraffic')}</span>
          <b>{formatBytes(user.traffic.lifetimeTotalBytes, locale)}</b>
        </div>
        <div>
          <span>{t('users:details.remaining')}</span>
          <b>
            {user.remainingBytes ? formatBytes(user.remainingBytes, locale) : t('users:unlimited')}
          </b>
        </div>
      </div>
      <div className="user-detail-actions">
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => onAction(`/users/${user.id}/${user.adminEnabled ? 'disable' : 'enable'}`)}
        >
          {user.adminEnabled ? <PowerOff size={15} /> : <Power size={15} />}
          {t(user.adminEnabled ? 'users:actions.disable' : 'users:actions.enable')}
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => onAction(`/users/${user.id}/traffic/reset`)}
        >
          <RefreshCcw size={15} />
          {t('users:actions.resetTraffic')}
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => onAction(`/users/${user.id}/credential/rotate`)}
        >
          <KeyRound size={15} />
          {t('users:actions.rotate')}
        </Button>
        <Button
          variant="danger"
          disabled={busy}
          onClick={() => {
            if (window.confirm(t('users:actions.confirmDelete')))
              onAction(`/users/${user.id}`, 'DELETE');
          }}
        >
          <Trash2 size={15} />
          {t('common:delete')}
        </Button>
      </div>
      <section className="access-list">
        <header>
          <div>
            <h3>{t('users:access.title')}</h3>
            <p>{t('users:access.description')}</p>
          </div>
        </header>
        {user.accesses.map((access) => (
          <article key={access.id}>
            <div>
              <b>{access.node.name}</b>
              <small>
                {access.node.server.name} ·{' '}
                {formatBytes(access.traffic.currentCycleTotalBytes, locale)}
              </small>
            </div>
            <Status value={access.enabled ? 'ACTIVE' : 'DISABLED'} />
            <div className="row-actions">
              <Button
                variant="ghost"
                aria-label={t('users:actions.copyLink')}
                onClick={() => void onShare(access)}
              >
                <Copy size={15} />
              </Button>
              <Button
                variant="ghost"
                aria-label={t(access.enabled ? 'users:actions.disable' : 'users:actions.enable')}
                onClick={() =>
                  onAction(
                    `/users/${user.id}/access/${access.id}/${access.enabled ? 'disable' : 'enable'}`,
                  )
                }
              >
                {access.enabled ? <PowerOff size={15} /> : <Power size={15} />}
              </Button>
              <Button
                variant="danger"
                aria-label={t('users:actions.revoke')}
                onClick={() => onAction(`/users/${user.id}/access/${access.id}`, 'DELETE')}
              >
                <Trash2 size={14} />
              </Button>
            </div>
          </article>
        ))}
        {available.length ? (
          <div className="access-grant">
            <label className="field">
              <span>{t('users:access.addNodes')}</span>
              <select
                multiple
                value={nodeIds}
                onChange={(event) =>
                  setNodeIds([...event.target.selectedOptions].map((option) => option.value))
                }
              >
                {available.map((node) => (
                  <option value={node.id} key={node.id}>
                    {node.name}
                  </option>
                ))}
              </select>
            </label>
            <Button
              disabled={!nodeIds.length || busy}
              onClick={() => {
                onGrant(nodeIds);
                setNodeIds([]);
              }}
            >
              <Plus size={15} />
              {t('users:access.grant')}
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
