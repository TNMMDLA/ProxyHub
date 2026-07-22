import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  Boxes,
  ChevronDown,
  Command,
  LayoutDashboard,
  Menu,
  Moon,
  ScrollText,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Sun,
  Waypoints,
  X,
} from 'lucide-react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import type { AgentStatusData } from '@proxyhub/shared';
import { api } from '../api';
import { useUiStore } from '../store';
import type { Admin, NotificationRecord } from '../types';

const groups = [
  { label: 'OVERVIEW', items: [{ to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard }] },
  {
    label: 'INFRASTRUCTURE',
    items: [
      { to: '/servers', label: 'Servers', icon: Server },
      { to: '/nodes', label: 'Nodes', icon: Waypoints },
      { to: '/node-pools', label: 'Node Pools', icon: Boxes },
      { to: '/security', label: 'Security', icon: ShieldCheck },
    ],
  },
  { label: 'ACCESS', items: [{ to: '/notifications', label: 'Notifications', icon: Bell }] },
  {
    label: 'SYSTEM',
    items: [
      { to: '/audit-logs', label: 'Audit Logs', icon: ScrollText },
      { to: '/settings', label: 'Settings', icon: Settings },
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
  const unread = notifications.data?.filter((item) => !item.readAt).length ?? 0;
  const xrayState = coreStatus.data?.xray.status;
  const operational = xrayState === 'HEALTHY';
  const systemLabel = coreStatus.isPending
    ? 'Checking core systems'
    : operational
      ? 'All core systems operational'
      : `Core status: ${xrayState?.toLowerCase() ?? 'unavailable'}`;
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
            <div className="nav-group" key={group.label}>
              <span>{group.label}</span>
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) => (isActive ? 'active' : '')}
                >
                  <item.icon size={18} strokeWidth={1.8} />
                  <b>{item.label}</b>
                  {item.label === 'Notifications' && unread ? <em>{unread}</em> : null}
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
          <small>v0.1.0 · Open source</small>
        </div>
      </aside>
      {sidebarOpen ? (
        <button
          className="sidebar-scrim"
          onClick={() => setSidebarOpen(false)}
          aria-label="Close navigation"
        />
      ) : null}
      <main className="main-area">
        <header className="topbar">
          <button className="mobile-menu icon-button" onClick={() => setSidebarOpen(true)}>
            <Menu size={20} />
          </button>
          <h2>
            {location.pathname === '/dashboard'
              ? 'Infrastructure overview'
              : (groups
                  .flatMap((group) => group.items)
                  .find((item) => item.to === location.pathname)?.label ?? 'ProxyHub')}
          </h2>
          <button className="search-button" onClick={() => setSearchOpen(true)}>
            <Search size={18} />
            <span>Search servers, nodes, pools...</span>
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
            <button className="icon-button" onClick={toggleTheme}>
              {theme === 'light' ? <Moon size={20} /> : <Sun size={20} />}
            </button>
            <button className="admin-menu" title="Sign out" onClick={() => void logout()}>
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
          <span>© 2026 ProxyHub · Open source under MIT License</span>
          <span>
            <i /> API online <b>v0.1.0</b>
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
                placeholder="Search or jump to..."
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setSearchOpen(false);
                }}
              />
            </div>
            <p>Quick navigation</p>
            {groups
              .flatMap((group) => group.items)
              .slice(0, 6)
              .map((item) => (
                <button
                  key={item.to}
                  onClick={() => {
                    void navigate(item.to);
                    setSearchOpen(false);
                  }}
                >
                  <item.icon size={17} />
                  {item.label}
                  <Command size={13} />
                </button>
              ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
