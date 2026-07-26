import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, Pencil, Plus, Power, PowerOff, Trash2, Waypoints } from 'lucide-react';
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
import type { NodeRecord, PoolRecord } from '../types';
import { useTranslation } from 'react-i18next';
import { confirmDeleteWithImpact } from '../delete-impact';

interface PoolForm {
  name: string;
  description: string;
  region: string;
  strategy: string;
  enabled: boolean;
  nodeIds: string[];
}

const initialForm: PoolForm = {
  name: '',
  description: '',
  region: 'Global',
  strategy: 'MANUAL',
  enabled: true,
  nodeIds: [],
};

function poolPayload(pool: PoolRecord, enabled = pool.enabled): PoolForm {
  return {
    name: pool.name,
    description: pool.description,
    region: pool.region,
    strategy: pool.strategy,
    enabled,
    nodeIds: pool.members.map(({ node }) => node.id),
  };
}

export default function PoolsPage() {
  const { t } = useTranslation(['resources', 'common']);
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [form, setForm] = useState<PoolForm>(initialForm);
  const pools = useQuery({ queryKey: ['pools'], queryFn: () => api<PoolRecord[]>('/node-pools') });
  const nodes = useQuery({ queryKey: ['nodes'], queryFn: () => api<NodeRecord[]>('/nodes') });

  const closeEditor = () => {
    setOpen(false);
    setEditingId(undefined);
    setForm(initialForm);
  };
  const openCreate = () => {
    setEditingId(undefined);
    setForm(initialForm);
    setOpen(true);
  };
  const openEdit = (pool: PoolRecord) => {
    setEditingId(pool.id);
    setForm(poolPayload(pool));
    setOpen(true);
  };

  const save = useMutation({
    mutationFn: () =>
      api(editingId ? `/node-pools/${editingId}` : '/node-pools', {
        method: editingId ? 'PUT' : 'POST',
        body: JSON.stringify(form),
      }),
    onSuccess: () => {
      toast.success(editingId ? 'Node pool updated' : 'Node pool created');
      closeEditor();
      void client.invalidateQueries({ queryKey: ['pools'] });
    },
    onError: (error) => toast.error(error.message),
  });
  const toggle = useMutation({
    mutationFn: (pool: PoolRecord) =>
      api(`/node-pools/${pool.id}`, {
        method: 'PUT',
        body: JSON.stringify(poolPayload(pool, !pool.enabled)),
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['pools'] }),
    onError: (error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/node-pools/${id}`, { method: 'DELETE' }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['pools'] }),
    onError: (error) => toast.error(error.message),
  });

  if (pools.isError || nodes.isError) {
    const failedQuery = pools.isError ? pools : nodes;
    return (
      <QueryErrorState
        error={failedQuery.error}
        onRetry={() => {
          void pools.refetch();
          void nodes.refetch();
        }}
      />
    );
  }

  return (
    <>
      <PageHeader
        title={t('resources:pools.title')}
        description={t('resources:pools.description')}
        actions={
          <Button onClick={openCreate}>
            <Plus size={16} />
            {t('resources:pools.create')}
          </Button>
        }
      />
      {pools.data?.length ? (
        <div className="pool-list">
          {pools.data.map((pool) => {
            const healthyNodes = pool.members.filter(
              ({ node }) => node.status === 'HEALTHY',
            ).length;
            const offlineNodes = pool.members.filter(
              ({ node }) => node.status === 'OFFLINE',
            ).length;
            return (
              <article key={pool.id}>
                <div className="pool-symbol">
                  <Boxes size={21} />
                </div>
                <div className="pool-main">
                  <header>
                    <div>
                      <h3>{pool.name}</h3>
                      <p>{pool.description || t('common:notAvailable')}</p>
                    </div>
                    <Status value={pool.enabled ? 'HEALTHY' : 'OFFLINE'} />
                  </header>
                  <div className="pool-meta">
                    <span>
                      {t('resources:servers.region')} <b>{pool.region}</b>
                    </span>
                    <span>
                      {t('resources:pools.strategy')} <b>{pool.strategy.replaceAll('_', ' ')}</b>
                    </span>
                    <span>
                      {t('resources:pools.members')} <b>{pool.members.length}</b>
                    </span>
                    <span>
                      {t('common:healthy')} <b>{healthyNodes}</b>
                    </span>
                    <span>
                      {t('common:statusLabels.OFFLINE')} <b>{offlineNodes}</b>
                    </span>
                  </div>
                  <div className="pool-members">
                    {pool.members.length ? (
                      pool.members.map(({ node }) => (
                        <span key={node.id}>
                          <i className={`node-dot ${node.status.toLowerCase()}`} />
                          {node.name}
                        </span>
                      ))
                    ) : (
                      <span className="muted">
                        <Waypoints size={14} />
                        {t('resources:pools.noNodesAssigned')}
                      </span>
                    )}
                  </div>
                </div>
                <div className="pool-actions">
                  <button title={t('resources:pools.edit')} onClick={() => openEdit(pool)}>
                    <Pencil size={16} />
                  </button>
                  <button
                    title={
                      pool.enabled ? t('resources:pools.disable') : t('resources:pools.enable')
                    }
                    disabled={toggle.isPending}
                    onClick={() => toggle.mutate(pool)}
                  >
                    {pool.enabled ? <PowerOff size={16} /> : <Power size={16} />}
                  </button>
                  <button
                    title={t('common:delete')}
                    onClick={() =>
                      void confirmDeleteWithImpact('NODE_POOL', pool.id, pool.name)
                        .then((confirmed) => {
                          if (confirmed) remove.mutate(pool.id);
                        })
                        .catch((error: Error) => toast.error(error.message))
                    }
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <EmptyState
          icon={<Boxes />}
          title={t('resources:pools.noPools')}
          body={t('resources:pools.empty')}
          action={
            <Button onClick={openCreate}>
              <Plus size={16} />
              {t('resources:pools.create')}
            </Button>
          }
        />
      )}
      {open ? (
        <Modal
          title={editingId ? t('resources:pools.edit') : t('resources:pools.create')}
          description={t('resources:pools.editDescription')}
          onClose={closeEditor}
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
                label={t('common:name')}
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder={t('resources:pools.namePlaceholder')}
                required
              />
              <Input
                label={t('resources:servers.region')}
                value={form.region}
                onChange={(event) => setForm({ ...form, region: event.target.value })}
              />
              <Input
                label={t('common:description')}
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
              />
              <label className="field">
                <span>{t('resources:pools.strategy')}</span>
                <select
                  value={form.strategy}
                  onChange={(event) => setForm({ ...form, strategy: event.target.value })}
                >
                  <option value="MANUAL">{t('resources:pools.manual')}</option>
                  <option value="AUTO">{t('resources:pools.auto')}</option>
                  <option value="FALLBACK">{t('resources:pools.fallback')}</option>
                  <option value="LOAD_BALANCE">{t('resources:pools.loadBalance')}</option>
                  <option value="LATENCY_BASED">{t('resources:pools.latencyBased')}</option>
                </select>
              </label>
            </div>
            <label className="pool-enabled-toggle">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
              />
              <span>
                <b>{t('resources:pools.poolEnabled')}</b>
                <small>{t('resources:pools.enabledHelp')}</small>
              </span>
            </label>
            <fieldset className="node-picker">
              <legend>{t('resources:pools.assignedNodes', { count: form.nodeIds.length })}</legend>
              {nodes.data?.length ? (
                nodes.data.map((node) => (
                  <label key={node.id}>
                    <input
                      type="checkbox"
                      checked={form.nodeIds.includes(node.id)}
                      onChange={() =>
                        setForm((current) => ({
                          ...current,
                          nodeIds: current.nodeIds.includes(node.id)
                            ? current.nodeIds.filter((id) => id !== node.id)
                            : [...current.nodeIds, node.id],
                        }))
                      }
                    />
                    <span>
                      <b>{node.name}</b>
                      <small>
                        {node.host}:{node.port}
                      </small>
                    </span>
                    <Status value={node.status} />
                  </label>
                ))
              ) : (
                <p>{t('resources:pools.createNodeFirst')}</p>
              )}
            </fieldset>
            <div className="modal-actions">
              <Button type="button" variant="secondary" onClick={closeEditor}>
                {t('common:cancel')}
              </Button>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending
                  ? t('common:loading')
                  : editingId
                    ? t('common:save')
                    : t('resources:pools.create')}
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}
    </>
  );
}
