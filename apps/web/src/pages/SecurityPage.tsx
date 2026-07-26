import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, Laptop, LockKeyhole, ShieldCheck, Smartphone } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../api';
import { Button, Input, Modal, PageHeader, QueryErrorState } from '../components/ui';
import type { Admin } from '../types';
import { useTranslation } from 'react-i18next';
import { formatRelativeTime } from '../i18n/formatters';
import type { SupportedLocale } from '../i18n';

interface SessionRecord {
  id: string;
  ip: string;
  userAgent: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
}

export default function SecurityPage({ admin }: { admin: Admin }) {
  const { t, i18n } = useTranslation('security');
  const locale: SupportedLocale = i18n.resolvedLanguage === 'zh-CN' ? 'zh-CN' : 'en';
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
      title: t('twoFactor'),
      passed: admin.totpEnabled,
      detail: admin.totpEnabled ? t('totpEnabled') : t('enableTotp'),
    },
    { title: t('encryptedSecrets'), passed: true, detail: t('encryptedDetail') },
    { title: t('sessionCookies'), passed: true, detail: t('sessionDetail') },
    { title: t('passwordHashing'), passed: true, detail: t('passwordDetail') },
  ];
  const score = checks.filter((item) => item.passed).length * 25;
  if (sessions.isError) {
    return <QueryErrorState error={sessions.error} onRetry={() => void sessions.refetch()} />;
  }
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
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
            <h2>{score === 100 ? t('strongPosture') : t('recommendation')}</h2>
            <p>{t('boundary')}</p>
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
                  {t('enable')}
                </Button>
              ) : (
                <span className="verified">{t('verified')}</span>
              )}
            </article>
          ))}
        </section>
      </div>
      <section className="table-panel sessions-panel">
        <div className="section-heading">
          <div>
            <h2>{t('activeSessions')}</h2>
            <p>{t('sessionsDescription')}</p>
          </div>
          <Button variant="secondary" onClick={() => logoutAll.mutate()}>
            {t('logoutAll')}
          </Button>
        </div>
        <div className="session-list">
          {sessions.data?.map((session, index) => (
            <article key={session.id}>
              <span className="device-icon">{index === 0 ? <Laptop /> : <Smartphone />}</span>
              <div>
                <b>{session.userAgent.split(' ').slice(0, 4).join(' ')}</b>
                <small>
                  {session.ip} ·{' '}
                  {t('active', { time: formatRelativeTime(session.lastUsedAt, locale) })}
                </small>
              </div>
              {index === 0 ? <span className="current-session">{t('current')}</span> : null}
            </article>
          ))}
        </div>
      </section>
      {setup ? (
        <Modal
          title={t('enable2fa')}
          description={t('setupDescription')}
          onClose={() => setSetup(null)}
        >
          <div className="totp-setup">
            <img src={setup.qrCode} alt={t('qrAlt')} />
            <div className="manual-secret">
              <span>{t('manualSecret')}</span>
              <code>{setup.secret}</code>
              <button onClick={() => void navigator.clipboard.writeText(setup.secret)}>
                <Copy size={15} />
              </button>
            </div>
            <Input
              label={t('verificationCode')}
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
              {t('verifyEnable')}
            </Button>
          </div>
        </Modal>
      ) : null}
      {recoveryCodes ? (
        <Modal
          title={t('saveRecovery')}
          description={t('recoveryDescription')}
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
              toast.success(t('recoveryCopied'));
            }}
          >
            <Copy size={16} />
            {t('copyCodes')}
          </Button>
          <p className="critical-note">
            <ShieldCheck size={16} />
            {t('recoveryWarning')}
          </p>
        </Modal>
      ) : null}
    </>
  );
}
