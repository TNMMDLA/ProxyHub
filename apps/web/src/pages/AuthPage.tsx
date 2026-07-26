import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, Eye, EyeOff, KeyRound, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { PROXYHUB_RELEASE } from '@proxyhub/shared';
import { api, ApiError } from '../api';
import { Brand } from '../components/AppShell';
import { Button, Input, QueryErrorState } from '../components/ui';
import { useTranslation } from 'react-i18next';
import { LanguageSwitcher } from '../components/LanguageSwitcher';

export function AuthPage() {
  const { t } = useTranslation('auth');
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ['auth-status'],
    queryFn: () => api<{ needsBootstrap: boolean }>('/auth/status'),
  });
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [needsTotp, setNeedsTotp] = useState(false);
  const submit = useMutation({
    mutationFn: async () => {
      const bootstrap = status.data?.needsBootstrap;
      return api(bootstrap ? '/auth/bootstrap' : '/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password, ...(totp ? { totp } : {}) }),
      });
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['me'] }),
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'TOTP_REQUIRED') setNeedsTotp(true);
      else toast.error(error.message);
    },
  });
  const isBootstrap = status.data?.needsBootstrap;
  if (status.isError) {
    return <QueryErrorState error={status.error} fullPage onRetry={() => void status.refetch()} />;
  }
  return (
    <main className="auth-page">
      <section className="auth-story">
        <Brand />
        <div className="auth-message">
          <div className="auth-signal">
            <span />
            <span />
            <span />
          </div>
          <h1>{t('headline')}</h1>
          <p>{t('story')}</p>
          <ul>
            <li>
              <Check size={16} />
              {t('validatedConfig')}
            </li>
            <li>
              <Check size={16} />
              {t('encryptedCredentials')}
            </li>
            <li>
              <Check size={16} />
              {t('auditTrail')}
            </li>
          </ul>
        </div>
        <small>
          ProxyHub {PROXYHUB_RELEASE.version} · {t('preProduction')}
        </small>
      </section>
      <section className="auth-form-wrap">
        <div className="auth-language">
          <LanguageSwitcher />
        </div>
        <form
          className="auth-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit.mutate();
          }}
        >
          <div className="auth-icon">{isBootstrap ? <ShieldCheck /> : <KeyRound />}</div>
          <h2>{isBootstrap ? t('createAdministrator') : t('welcomeBack')}</h2>
          <p>{isBootstrap ? t('bootstrapDescription') : t('loginDescription')}</p>
          <Input
            label={t('username')}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
          <div className="password-field">
            <Input
              label={t('password')}
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={isBootstrap ? 'new-password' : 'current-password'}
              minLength={isBootstrap ? 12 : 1}
              required
            />
            <button
              type="button"
              aria-label={showPassword ? t('hidePassword') : t('showPassword')}
              onClick={() => setShowPassword((value) => !value)}
            >
              {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
          </div>
          {needsTotp ? (
            <Input
              label={t('authenticationCode')}
              inputMode="numeric"
              pattern="[0-9]{6}"
              value={totp}
              onChange={(e) => setTotp(e.target.value)}
              autoFocus
              required
            />
          ) : null}
          <Button type="submit" disabled={submit.isPending}>
            {submit.isPending ? t('pleaseWait') : isBootstrap ? t('createWorkspace') : t('signIn')}
            <ArrowRight size={17} />
          </Button>
          <span className="auth-security">
            <ShieldCheck size={14} />
            {t('securityNote')}
          </span>
        </form>
      </section>
    </main>
  );
}
