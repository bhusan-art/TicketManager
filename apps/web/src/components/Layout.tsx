import {
  Bell,
  CheckSquare,
  ChartColumn,
  LayoutDashboard,
  Receipt,
  Scale,
  User,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { NavLink, Outlet } from 'react-router';

const NAV: { to: string; label: string; icon: LucideIcon }[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/expenses', label: 'Expenses', icon: Receipt },
  { to: '/approvals', label: 'Approvals', icon: CheckSquare },
  { to: '/advances', label: 'Advances', icon: Wallet },
  { to: '/settlements', label: 'Settlements', icon: Scale },
  { to: '/reports', label: 'Reports', icon: ChartColumn },
  { to: '/notifications', label: 'Notifications', icon: Bell },
  { to: '/profile', label: 'Profile', icon: User },
];

export function Layout() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img src="/favicon.svg" alt="" width={28} height={28} />
          <span>TicketManager</span>
        </div>
        <nav aria-label="Main">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} end={to === '/'} className="nav-link">
              <Icon size={18} aria-hidden />
              {label}
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
            <Bell size={20} aria-label="Notifications" />
            <span className="avatar" aria-label="Signed-in user">
              TM
            </span>
          </div>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
