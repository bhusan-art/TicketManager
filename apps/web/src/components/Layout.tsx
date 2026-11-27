import { ROLE_LABELS, type Role } from '@ticketmanager/shared';
import {
  Bell,
  Building2,
  ChartColumn,
  CheckSquare,
  Download,
  FolderKanban,
  FileArchive,
  History,
  HandCoins,
  LayoutDashboard,
  LogOut,
  Mail,
  Menu,
  Receipt,
  Scale,
  Settings,
  Tags,
  User,
  Users,
  Wallet,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router';
import { useAuth, useUser } from '../auth/AuthContext';
import { useUnreadCount } from '../lib/notifications';
import { useInstallPrompt } from '../lib/install';
import { useOnline, usePhone } from '../lib/media';
import { initials } from '../lib/initials';
import { ThemeToggle } from './ThemeToggle';
import { useTableLabels } from '../lib/tableLabels';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Roles that see this item. Omitted = everyone. */
  roles?: Role[];
  /** Shorter label for the tab bar on phones. */
  short?: string;
  /** Sidebar section heading. */
  group: Group;
}

const GROUPS = ['Overview', 'Expenses', 'Accounts', 'Insights', 'Admin', 'You'] as const;
type Group = (typeof GROUPS)[number];

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, short: 'Home', group: 'Overview' },
  {
    to: '/expenses',
    label: 'My expenses',
    icon: Receipt,
    roles: ['employee'],
    short: 'Expenses',
    group: 'Expenses',
  },
  {
    to: '/advances',
    label: 'Advances',
    icon: HandCoins,
    roles: ['employee', 'manager', 'accounts', 'director'],
    group: 'Expenses',
  },
  {
    to: '/settlements',
    label: 'Settlements',
    icon: Scale,
    roles: ['employee', 'accounts'],
    group: 'Expenses',
  },
  {
    to: '/approvals',
    label: 'Approvals',
    icon: CheckSquare,
    roles: ['manager', 'director'],
    group: 'Expenses',
  },
  {
    to: '/verification',
    label: 'Verification',
    icon: CheckSquare,
    roles: ['accounts'],
    group: 'Accounts',
  },
  { to: '/payments', label: 'Payments', icon: Wallet, roles: ['accounts'], group: 'Accounts' },
  {
    to: '/reports',
    label: 'Reports',
    icon: ChartColumn,
    roles: ['accounts', 'director', 'admin'],
    group: 'Insights',
  },
  {
    to: '/documents',
    label: 'Documents',
    icon: FileArchive,
    roles: ['employee', 'manager', 'accounts', 'director'],
    group: 'Insights',
  },
  {
    to: '/audit',
    label: 'Audit log',
    icon: History,
    roles: ['admin', 'director', 'accounts'],
    group: 'Insights',
  },
  {
    to: '/admin/users',
    label: 'Users & roles',
    icon: Users,
    roles: ['admin'],
    short: 'Users',
    group: 'Admin',
  },
  {
    to: '/admin/departments',
    label: 'Departments',
    icon: Building2,
    roles: ['admin'],
    group: 'Admin',
  },
  { to: '/admin/categories', label: 'Categories', icon: Tags, roles: ['admin'], group: 'Admin' },
  {
    to: '/admin/projects',
    label: 'Projects',
    icon: FolderKanban,
    roles: ['admin'],
    group: 'Admin',
  },
  { to: '/admin/emails', label: 'Email log', icon: Mail, roles: ['admin'], group: 'Admin' },
  { to: '/admin/settings', label: 'Settings', icon: Settings, roles: ['admin'], group: 'Admin' },
  { to: '/notifications', label: 'Notifications', icon: Bell, short: 'Alerts', group: 'You' },
  { to: '/profile', label: 'Profile', icon: User, group: 'You' },
];

/** The four places each role visits most, as tabs along the bottom of a phone screen. */
const TABS: Record<Role, string[]> = {
  employee: ['/', '/expenses', '/advances', '/notifications'],
  manager: ['/', '/approvals', '/advances', '/notifications'],
  accounts: ['/', '/verification', '/payments', '/reports'],
  director: ['/', '/approvals', '/reports', '/notifications'],
  admin: ['/', '/admin/users', '/reports', '/notifications'],
};

export function Layout() {
  const user = useUser();
  const nav = NAV.filter((item) => !item.roles || item.roles.includes(user.activeRole));
  const tabs = TABS[user.activeRole]
    .map((to) => nav.find((item) => item.to === to))
    .filter((item): item is NavItem => Boolean(item));
  const unread = useUnreadCount();
  const [menuOpen, setMenuOpen] = useState(false);
  const phone = usePhone();
  const online = useOnline();
  const main = useRef<HTMLElement>(null);
  useTableLabels(main);

  // Close the phone menu with Escape (choosing a page closes it too).
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  return (
    <div className={`shell${menuOpen ? ' menu-open' : ''}`}>
      <aside className="sidebar" id="main-menu">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            <img src="/favicon.svg" alt="" width={30} height={30} />
          </span>
          <span className="brand-name">TicketManager</span>
          <button
            type="button"
            className="icon-btn mobile-only close-menu"
            aria-label="Close menu"
            onClick={() => setMenuOpen(false)}
          >
            <X size={20} aria-hidden />
          </button>
        </div>
        {phone && (
          <div className="drawer-role">
            <RoleSwitcher />
          </div>
        )}
        <nav aria-label="Main">
          {GROUPS.map((group) => {
            const items = nav.filter((item) => item.group === group);
            if (items.length === 0) return null;
            return (
              <div key={group} className="nav-group">
                {group !== 'Overview' && <span className="nav-heading">{group}</span>}
                {items.map(({ to, label, icon: Icon }) => (
                  <NavLink
                    key={to}
                    to={to}
                    end={to === '/'}
                    className="nav-link"
                    onClick={() => setMenuOpen(false)}
                  >
                    <Icon size={18} aria-hidden />
                    {label}
                    {to === '/notifications' && unread > 0 && (
                      <span className="nav-count" aria-label={`${unread} unread`}>
                        {unread > 99 ? '99+' : unread}
                      </span>
                    )}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
      </aside>
      {menuOpen && <div className="backdrop" aria-hidden onClick={() => setMenuOpen(false)} />}
      <div className="main">
        <header className="topbar">
          <button
            type="button"
            className="icon-btn mobile-only"
            aria-label="Open menu"
            aria-controls="main-menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
          >
            <Menu size={22} aria-hidden />
          </button>
          <Link to="/" className="mobile-only topbar-brand" aria-label="TicketManager home">
            <img src="/favicon.svg" alt="" width={26} height={26} />
          </Link>
          <input
            className="search"
            type="search"
            placeholder="Search…"
            aria-label="Search"
            disabled
          />
          <div className="topbar-actions">
            <ThemeToggle />
            <Link
              to="/notifications"
              className="bell"
              aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
            >
              <Bell size={20} aria-hidden />
              {unread > 0 && <span className="bell-dot">{unread > 9 ? '9+' : unread}</span>}
            </Link>
            {!phone && <RoleSwitcher />}
            <UserMenu />
          </div>
        </header>
        <main className="content" ref={main}>
          {!online && (
            <div className="offline-banner" role="status">
              You&apos;re offline. You can look around, but changes can&apos;t be saved until
              you&apos;re back online.
            </div>
          )}
          <Outlet />
        </main>
      </div>
      {phone && (
        <nav className="tabbar" aria-label="Quick links">
          {tabs.map(({ to, label, short, icon: Icon }) => (
            <NavLink key={to} to={to} end={to === '/'} className="tab-link">
              <span className="tab-icon">
                <Icon size={22} aria-hidden />
                {to === '/notifications' && unread > 0 && (
                  <span className="bell-dot">{unread > 9 ? '9+' : unread}</span>
                )}
              </span>
              {short ?? label}
            </NavLink>
          ))}
          <button
            type="button"
            className="tab-link"
            aria-controls="main-menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
          >
            <span className="tab-icon">
              <Menu size={22} aria-hidden />
            </span>
            More
          </button>
        </nav>
      )}
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
  const install = useInstallPrompt();
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
          {install && (
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void install();
              }}
            >
              <Download size={16} aria-hidden /> Install app
            </button>
          )}
          <button role="menuitem" onClick={() => void signOut()}>
            <LogOut size={16} aria-hidden /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
