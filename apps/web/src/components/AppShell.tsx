import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  Boxes,
  ChevronDown,
  Command,
  LayoutDashboard,
  Link2,
  Menu,
  Moon,
  ScrollText,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Sun,
  Route as RouteIcon,
  Waypoints,
  ListTree,
  Stethoscope,
  X,
} from 'lucide-react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import type { AgentStatusData, ProxyHubHealthData } from '@proxyhub/shared';
import { api } from '../api';
import { useUiStore } from '../store';
import type { Admin, NotificationRecord } from '../types';
import { useTranslation } from 'react-i18next';
import { LanguageSwitcher } from './LanguageSwitcher';

const groups = [
  { key: 'overview', items: [{ to: '/dashboard', key: 'dashboard', icon: LayoutDashboard }] },
  {
    key: 'infrastructure',
    items: [
      { to: '/servers', key: 'servers', icon: Server },
      { to: '/nodes', key: 'nodes', icon: Waypoints },
      { to: '/node-pools', key: 'nodePools', icon: Boxes },
      { to: '/diagnostics', key: 'diagnostics', icon: Stethoscope },
      { to: '/security', key: 'security', icon: ShieldCheck },
    ],
  },
  {
    key: 'policy',
    items: [
      { to: '/policies', key: 'policyStudio', icon: RouteIcon },
      { to: '/rule-sets', key: 'ruleSets', icon: ListTree },
      { to: '/subscriptions', key: 'subscriptions', icon: Link2 },
    ],
  },
  { key: 'access', items: [{ to: '/notifications', key: 'notifications', icon: Bell }] },
  {
    key: 'system',
    items: [
      { to: '/audit-logs', key: 'auditLogs', icon: ScrollText },
      { to: '/settings', key: 'settings', icon: Settings },
    ],
  },
];

export function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <i />
        <i />
        <i />
        <i />
        <i />
      </span>
      <strong>ProxyHub</strong>
    </div>
  );
}

export function AppShell({ admin }: { admin: Admin }) {
  const { t } = useTranslation(['navigation', 'common']);
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { sidebarOpen, setSidebarOpen, theme, toggleTheme } = useUiStore();
  const [searchOpen, setSearchOpen] = useState(false);
  const notifications = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<NotificationRecord[]>('/notifications'),
  });
  const coreStatus = useQuery({
    queryKey: ['xray-status'],
    queryFn: () => api<AgentStatusData>('/xray/status'),
    refetchInterval: 15_000,
    retry: false,
  });
  const releaseHealth = useQuery({
    queryKey: ['health'],
    queryFn: () => api<ProxyHubHealthData>('/health'),
    staleTime: 60_000,
    retry: false,
  });
  const currentNavigationKey = groups
    .flatMap((group) => group.items)
    .find((item) => item.to === location.pathname)?.key;
  const unread = notifications.data?.filter((item) => !item.readAt).length ?? 0;
  const xrayState = coreStatus.data?.xray.status;
  const operational = xrayState === 'HEALTHY';
  const systemLabel = coreStatus.isPending
    ? t('navigation:checkingCore')
    : operational
      ? t('navigation:coreOperational')
      : t('navigation:coreStatus', {
          status: xrayState ? t(`common:statusLabels.${xrayState}`) : t('common:unavailable'),
        });
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname, setSidebarOpen]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
  const logout = async () => {
    await api('/auth/logout', { method: 'POST' });
    queryClient.setQueryData(['me'], undefined);
    void queryClient.invalidateQueries({ queryKey: ['me'] });
  };
  return (
    <div className="app-shell">
      <aside className={sidebarOpen ? 'sidebar open' : 'sidebar'}>
        <div className="sidebar-mobile-head">
          <Brand />
          <button className="icon-button" onClick={() => setSidebarOpen(false)}>
            <X size={20} />
          </button>
        </div>
        <div className="sidebar-brand">
          <Brand />
        </div>
        <nav>
          {groups.map((group) => (
            <div className="nav-group" key={group.key}>
              <span>{t(`navigation:${group.key}`).toUpperCase()}</span>
              {group.items
                .filter((item) => item.to !== '/diagnostics' || admin.role === 'ADMIN')
                .map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={({ isActive }) => (isActive ? 'active' : '')}
                  >
                    <item.icon size={18} strokeWidth={1.8} />
                    <b>{t(`navigation:${item.key}`)}</b>
                    {item.key === 'notifications' && unread ? <em>{unread}</em> : null}
                  </NavLink>
                ))}
            </div>
          ))}
        </nav>
        <div className={operational ? 'system-note' : 'system-note warning'}>
          <span>
            <i />
            {systemLabel}
          </span>
          <small>
            {releaseHealth.data?.version ?? t('navigation:versionUnavailable')} ·{' '}
            {t('navigation:openSource')}
          </small>
          <LanguageSwitcher compact />
        </div>
      </aside>
      {sidebarOpen ? (
        <button
          className="sidebar-scrim"
          onClick={() => setSidebarOpen(false)}
          aria-label={t('navigation:closeMenu')}
        />
      ) : null}
      <main className="main-area">
        <header className="topbar">
          <button
            className="mobile-menu icon-button"
            aria-label={t('navigation:openMenu')}
            onClick={() => setSidebarOpen(true)}
          >
            <Menu size={20} />
          </button>
          <h2>
            {location.pathname === '/dashboard'
              ? t('navigation:infrastructureOverview')
              : currentNavigationKey
                ? t(`navigation:${currentNavigationKey}`)
                : 'ProxyHub'}
          </h2>
          <button className="search-button" onClick={() => setSearchOpen(true)}>
            <Search size={18} />
            <span>{t('navigation:searchInfrastructure')}</span>
            <kbd>⌘K</kbd>
          </button>
          <div className="top-actions">
            <button
              className="icon-button notification-button"
              onClick={() => navigate('/notifications')}
            >
              <Bell size={20} />
              {unread ? <i /> : null}
            </button>
            <LanguageSwitcher compact />
            <button
              className="icon-button"
              aria-label={t('navigation:toggleTheme')}
              onClick={toggleTheme}
            >
              {theme === 'light' ? <Moon size={20} /> : <Sun size={20} />}
            </button>
            <button
              className="admin-menu"
              title={t('navigation:signOut')}
              onClick={() => void logout()}
            >
              <span>{admin.username.slice(0, 2).toUpperCase()}</span>
              <b>{admin.username}</b>
              <ChevronDown size={15} />
            </button>
          </div>
        </header>
        <div className="content">
          <Outlet />
        </div>
        <footer>
          <span>© 2026 ProxyHub · MIT License</span>
          <span>
            <i /> {t('navigation:apiOnline')}{' '}
            <b>{releaseHealth.data?.version ?? t('common:unknown')}</b>
          </span>
        </footer>
      </main>
      {searchOpen ? (
        <div
          className="command-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setSearchOpen(false);
          }}
        >
          <div className="command">
            <div>
              <Search size={19} />
              <input
                autoFocus
                placeholder={t('navigation:searchPlaceholder')}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setSearchOpen(false);
                }}
              />
            </div>
            <p>{t('navigation:quickNavigation')}</p>
            {groups
              .flatMap((group) => group.items)
              .filter((item) => item.to !== '/diagnostics' || admin.role === 'ADMIN')
              .slice(0, 8)
              .map((item) => (
                <button
                  key={item.to}
                  onClick={() => {
                    void navigate(item.to);
                    setSearchOpen(false);
                  }}
                >
                  <item.icon size={17} />
                  {t(`navigation:${item.key}`)}
                  <Command size={13} />
                </button>
              ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
