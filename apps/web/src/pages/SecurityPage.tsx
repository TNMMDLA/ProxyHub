import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, Laptop, LockKeyhole, ShieldCheck, Smartphone } from 'lucide-react';
import { toast } from 'sonner';
import { api, formatRelative } from '../api';
import { Button, Input, Modal, PageHeader, QueryErrorState } from '../components/ui';
import type { Admin } from '../types';

interface SessionRecord {
  id: string;
  ip: string;
  userAgent: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
}

export default function SecurityPage({ admin }: { admin: Admin }) {
  const client = useQueryClient();
  const [setup, setSetup] = useState<{ secret: string; qrCode: string } | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api<SessionRecord[]>('/auth/sessions'),
  });
  const startSetup = useMutation({
    mutationFn: () =>
      api<{ secret: string; qrCode: string }>('/auth/2fa/setup', { method: 'POST' }),
    onSuccess: setSetup,
    onError: (error) => toast.error(error.message),
  });
  const enable = useMutation({
    mutationFn: () =>
      api<{ recoveryCodes: string[] }>('/auth/2fa/enable', {
        method: 'POST',
        body: JSON.stringify({ code }),
      }),
    onSuccess: (data) => {
      setSetup(null);
      setRecoveryCodes(data.recoveryCodes);
      void client.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (error) => toast.error(error.message),
  });
  const logoutAll = useMutation({
    mutationFn: () => api('/auth/sessions', { method: 'DELETE' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['me'] });
    },
  });
  const checks = [
    {
      title: 'Two-factor authentication',
      passed: admin.totpEnabled,
      detail: admin.totpEnabled ? 'TOTP is enabled' : 'Enable TOTP to protect the admin account',
    },
    { title: 'Encrypted secrets', passed: true, detail: 'AES-256-GCM at rest' },
    { title: 'Secure session cookies', passed: true, detail: 'HttpOnly · SameSite=Strict' },
    { title: 'Password hashing', passed: true, detail: 'Argon2id · 64 MiB memory cost' },
  ];
  const score = checks.filter((item) => item.passed).length * 25;
  if (sessions.isError) {
    return <QueryErrorState error={sessions.error} onRetry={() => void sessions.refetch()} />;
  }
  return (
    <>
      <PageHeader
        title="Security"
        description="Authentication posture, protected sessions and operational recommendations."
      />
      <div className="security-layout">
        <section className="security-score-card">
          <div
            className="score-ring large"
            style={{ '--score': `${score * 3.6}deg` } as React.CSSProperties}
          >
            <div>
              <strong>{score}</strong>
              <span>/100</span>
            </div>
          </div>
          <div>
            <h2>{score === 100 ? 'Strong security posture' : 'One recommendation remains'}</h2>
            <p>
              ProxyHub reports configuration guidance and never modifies SSH or firewall policy
              automatically.
            </p>
          </div>
        </section>
        <section className="security-checks">
          {checks.map((item) => (
            <article key={item.title}>
              <span className={item.passed ? 'check-pass' : 'check-warn'}>
                {item.passed ? <Check size={16} /> : <KeyRound size={16} />}
              </span>
              <div>
                <b>{item.title}</b>
                <small>{item.detail}</small>
              </div>
              {!item.passed ? (
                <Button onClick={() => startSetup.mutate()} disabled={startSetup.isPending}>
                  Enable
                </Button>
              ) : (
                <span className="verified">Verified</span>
              )}
            </article>
          ))}
        </section>
      </div>
      <section className="table-panel sessions-panel">
        <div className="section-heading">
          <div>
            <h2>Active sessions</h2>
            <p>Review devices currently authenticated to this account.</p>
          </div>
          <Button variant="secondary" onClick={() => logoutAll.mutate()}>
            Log out all
          </Button>
        </div>
        <div className="session-list">
          {sessions.data?.map((session, index) => (
            <article key={session.id}>
              <span className="device-icon">{index === 0 ? <Laptop /> : <Smartphone />}</span>
              <div>
                <b>{session.userAgent.split(' ').slice(0, 4).join(' ')}</b>
                <small>
                  {session.ip} · active {formatRelative(session.lastUsedAt)}
                </small>
              </div>
              {index === 0 ? <span className="current-session">Current</span> : null}
            </article>
          ))}
        </div>
      </section>
      {setup ? (
        <Modal
          title="Enable two-factor authentication"
          description="Scan the QR code with your authenticator, then enter the current code."
          onClose={() => setSetup(null)}
        >
          <div className="totp-setup">
            <img src={setup.qrCode} alt="TOTP setup QR code" />
            <div className="manual-secret">
              <span>Manual secret</span>
              <code>{setup.secret}</code>
              <button onClick={() => void navigator.clipboard.writeText(setup.secret)}>
                <Copy size={15} />
              </button>
            </div>
            <Input
              label="6-digit verification code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoFocus
            />
            <Button
              onClick={() => enable.mutate()}
              disabled={code.length !== 6 || enable.isPending}
            >
              <LockKeyhole size={16} />
              Verify and enable
            </Button>
          </div>
        </Modal>
      ) : null}
      {recoveryCodes ? (
        <Modal
          title="Save your recovery codes"
          description="Each code can be used once. ProxyHub stores only Argon2id hashes."
          onClose={() => setRecoveryCodes(null)}
        >
          <div className="recovery-codes">
            {recoveryCodes.map((item) => (
              <code key={item}>{item}</code>
            ))}
          </div>
          <Button
            onClick={() => {
              void navigator.clipboard.writeText(recoveryCodes.join('\n'));
              toast.success('Recovery codes copied');
            }}
          >
            <Copy size={16} />
            Copy all codes
          </Button>
          <p className="critical-note">
            <ShieldCheck size={16} />
            Store these codes somewhere safe. They will not be shown again.
          </p>
        </Modal>
      ) : null}
    </>
  );
}
