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
        title="Node Pools"
        description="Create service groups, manage membership in batches, and control pool availability."
        actions={
          <Button onClick={openCreate}>
            <Plus size={16} />
            Create pool
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
                      <p>{pool.description || 'No description'}</p>
                    </div>
                    <Status value={pool.enabled ? 'HEALTHY' : 'OFFLINE'} />
                  </header>
                  <div className="pool-meta">
                    <span>
                      Region <b>{pool.region}</b>
                    </span>
                    <span>
                      Strategy <b>{pool.strategy.replaceAll('_', ' ')}</b>
                    </span>
                    <span>
                      Total nodes <b>{pool.members.length}</b>
                    </span>
                    <span>
                      Healthy <b>{healthyNodes}</b>
                    </span>
                    <span>
                      Offline <b>{offlineNodes}</b>
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
                        No nodes assigned
                      </span>
                    )}
                  </div>
                </div>
                <div className="pool-actions">
                  <button title="Edit pool" onClick={() => openEdit(pool)}>
                    <Pencil size={16} />
                  </button>
                  <button
                    title={pool.enabled ? 'Disable pool' : 'Enable pool'}
                    disabled={toggle.isPending}
                    onClick={() => toggle.mutate(pool)}
                  >
                    {pool.enabled ? <PowerOff size={16} /> : <Power size={16} />}
                  </button>
                  <button
                    title="Delete pool"
                    onClick={() => {
                      if (confirm(`Delete ${pool.name}?`)) remove.mutate(pool.id);
                    }}
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
          title="No node pools"
          body="Pools provide stable groups for future subscriptions, fallback and latency-based selection."
          action={
            <Button onClick={openCreate}>
              <Plus size={16} />
              Create first pool
            </Button>
          }
        />
      )}
      {open ? (
        <Modal
          title={editingId ? 'Edit node pool' : 'Create node pool'}
          description="Select or remove multiple nodes and save the relationship set atomically."
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
                label="Pool name"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="Japan Pool"
                required
              />
              <Input
                label="Region"
                value={form.region}
                onChange={(event) => setForm({ ...form, region: event.target.value })}
              />
              <Input
                label="Description"
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
              />
              <label className="field">
                <span>Strategy</span>
                <select
                  value={form.strategy}
                  onChange={(event) => setForm({ ...form, strategy: event.target.value })}
                >
                  <option value="MANUAL">Manual</option>
                  <option value="AUTO">Auto</option>
                  <option value="FALLBACK">Fallback</option>
                  <option value="LOAD_BALANCE">Load balance</option>
                  <option value="LATENCY_BASED">Latency based</option>
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
                <b>Pool enabled</b>
                <small>Disabled pools remain configured but are unavailable for selection.</small>
              </span>
            </label>
            <fieldset className="node-picker">
              <legend>Assigned nodes ({form.nodeIds.length})</legend>
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
                <p>Create a node before assigning pool members.</p>
              )}
            </fieldset>
            <div className="modal-actions">
              <Button type="button" variant="secondary" onClick={closeEditor}>
                Cancel
              </Button>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? 'Saving…' : editingId ? 'Save pool' : 'Create pool'}
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}
    </>
  );
}
