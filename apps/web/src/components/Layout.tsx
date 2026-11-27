import { ROLE_LABELS, type Role } from '@ticketmanager/shared';
import {
  Bell,
  Building2,
  ChartColumn,
  CheckSquare,
  FolderKanban,
  FileArchive,
  History,
  HandCoins,
  LayoutDashboard,
  LogOut,
  Mail,
  Receipt,
  Scale,
  Settings,
  Tags,
  User,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router';
import { useAuth, useUser } from '../auth/AuthContext';
import { useUnreadCount } from '../lib/notifications';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Roles that see this item. Omitted = everyone. */
  roles?: Role[];
}

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/expenses', label: 'My expenses', icon: Receipt, roles: ['employee'] },
  {
    to: '/advances',
    label: 'Advances',
    icon: HandCoins,
    roles: ['employee', 'manager', 'accounts', 'director'],
  },
  { to: '/settlements', label: 'Settlements', icon: Scale, roles: ['employee', 'accounts'] },
  { to: '/approvals', label: 'Approvals', icon: CheckSquare, roles: ['manager', 'director'] },
  { to: '/verification', label: 'Verification', icon: CheckSquare, roles: ['accounts'] },
  { to: '/payments', label: 'Payments', icon: Wallet, roles: ['accounts'] },
  { to: '/reports', label: 'Reports', icon: ChartColumn, roles: ['accounts', 'director', 'admin'] },
  {
    to: '/documents',
    label: 'Documents',
    icon: FileArchive,
    roles: ['employee', 'manager', 'accounts', 'director'],
  },
  { to: '/audit', label: 'Audit log', icon: History, roles: ['admin', 'director', 'accounts'] },
  { to: '/admin/users', label: 'Users & roles', icon: Users, roles: ['admin'] },
  { to: '/admin/departments', label: 'Departments', icon: Building2, roles: ['admin'] },
  { to: '/admin/categories', label: 'Categories', icon: Tags, roles: ['admin'] },
  { to: '/admin/projects', label: 'Projects', icon: FolderKanban, roles: ['admin'] },
  { to: '/admin/emails', label: 'Email log', icon: Mail, roles: ['admin'] },
  { to: '/admin/settings', label: 'Settings', icon: Settings, roles: ['admin'] },
  { to: '/notifications', label: 'Notifications', icon: Bell },
  { to: '/profile', label: 'Profile', icon: User },
];

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');

export function Layout() {
  const user = useUser();
  const nav = NAV.filter((item) => !item.roles || item.roles.includes(user.activeRole));
  const unread = useUnreadCount();
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img src="/favicon.svg" alt="" width={28} height={28} />
          <span>TicketManager</span>
        </div>
        <nav aria-label="Main">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} end={to === '/'} className="nav-link">
              <Icon size={18} aria-hidden />
              {label}
              {to === '/notifications' && unread > 0 && (
                <span className="nav-count" aria-label={`${unread} unread`}>
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <input
            className="search"
            type="search"
            placeholder="Search…"
            aria-label="Search"
            disabled
          />
          <div className="topbar-actions">
            <Link
              to="/notifications"
              className="bell"
              aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
            >
              <Bell size={20} aria-hidden />
              {unread > 0 && <span className="bell-dot">{unread > 9 ? '9+' : unread}</span>}
            </Link>
            <RoleSwitcher />
            <UserMenu />
          </div>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function RoleSwitcher() {
  const { user, switchRole } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  if (!user || user.roles.length < 2) return null;
  return (
    <label className="role-switcher">
      <span className="muted small">Viewing as</span>
      <select
        aria-label="Active role"
        value={user.activeRole}
        disabled={busy}
        onChange={async (e) => {
          setBusy(true);
          try {
            await switchRole(e.target.value as Role);
            navigate('/');
          } finally {
            setBusy(false);
          }
        }}
      >
        {user.roles.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABELS[r]}
          </option>
        ))}
      </select>
    </label>
  );
}

function UserMenu() {
  const { user, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  if (!user) return null;
  return (
    <div className="user-menu">
      <button
        className="avatar"
        aria-label={`Account menu for ${user.name}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {initials(user.name)}
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-head">
            <strong>{user.name}</strong>
            <span className="muted small">{user.email}</span>
          </div>
          <NavLink to="/profile" role="menuitem" onClick={() => setOpen(false)}>
            <User size={16} aria-hidden /> Profile
          </NavLink>
          <button role="menuitem" onClick={() => void signOut()}>
            <LogOut size={16} aria-hidden /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
