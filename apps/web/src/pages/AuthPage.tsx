import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, Eye, EyeOff, KeyRound, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '../api';
import { Brand } from '../components/AppShell';
import { Button, Input, QueryErrorState } from '../components/ui';

export function AuthPage() {
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
          <h1>
            Infrastructure,
            <br />
            under control.
          </h1>
          <p>
            Manage Xray nodes, server health, secure access and resilient node pools from one calm
            workspace.
          </p>
          <ul>
            <li>
              <Check size={16} />
              Validated Xray configuration
            </li>
            <li>
              <Check size={16} />
              Encrypted Reality credentials
            </li>
            <li>
              <Check size={16} />
              Complete operational audit trail
            </li>
          </ul>
        </div>
        <small>ProxyHub v0.3 · Pre-production</small>
      </section>
      <section className="auth-form-wrap">
        <form
          className="auth-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit.mutate();
          }}
        >
          <div className="auth-icon">{isBootstrap ? <ShieldCheck /> : <KeyRound />}</div>
          <h2>{isBootstrap ? 'Create your administrator' : 'Welcome back'}</h2>
          <p>
            {isBootstrap
              ? 'Set up the first secure account for this ProxyHub instance.'
              : 'Sign in to your infrastructure workspace.'}
          </p>
          <Input
            label="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
          <div className="password-field">
            <Input
              label="Password"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={isBootstrap ? 'new-password' : 'current-password'}
              minLength={isBootstrap ? 12 : 1}
              required
            />
            <button type="button" onClick={() => setShowPassword((value) => !value)}>
              {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
          </div>
          {needsTotp ? (
            <Input
              label="6-digit authentication code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              value={totp}
              onChange={(e) => setTotp(e.target.value)}
              autoFocus
              required
            />
          ) : null}
          <Button type="submit" disabled={submit.isPending}>
            {submit.isPending ? 'Please wait…' : isBootstrap ? 'Create workspace' : 'Sign in'}
            <ArrowRight size={17} />
          </Button>
          <span className="auth-security">
            <ShieldCheck size={14} />
            Protected by Argon2id and secure HttpOnly sessions
          </span>
        </form>
      </section>
    </main>
  );
}
