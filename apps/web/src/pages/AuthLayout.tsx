import { BadgeCheck, ReceiptText, ShieldCheck, Smartphone } from 'lucide-react';
import type { ReactNode } from 'react';
import { ThemeToggle } from '../components/ThemeToggle';

const POINTS = [
  { icon: ReceiptText, text: 'Snap a bill and submit a claim in under a minute' },
  { icon: ShieldCheck, text: 'Manager, Accounts and Director approvals, every step logged' },
  { icon: BadgeCheck, text: 'Payments and advances settled and tracked to the paisa' },
  { icon: Smartphone, text: 'Works on your phone, even with a weak signal' },
];

/** Split screen used by sign-in and password pages: brand panel left, form right. */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth-shell">
      <aside className="auth-brand">
        <div className="auth-orbs" aria-hidden>
          <span />
          <span />
          <span />
        </div>
        <div className="brand brand-light">
          <span className="brand-mark" aria-hidden>
            <img src="/favicon.svg" alt="" width={36} height={36} />
          </span>
          <span className="brand-name">TicketManager</span>
        </div>
        <div className="auth-pitch">
          <p className="auth-title">Submit, approve and pay expense claims in one place.</p>
          <ul className="auth-points">
            {POINTS.map(({ icon: Icon, text }) => (
              <li key={text}>
                <span aria-hidden>
                  <Icon size={16} />
                </span>
                {text}
              </li>
            ))}
          </ul>
        </div>
        <p className="auth-foot small">Expense claims, approvals and payments</p>
      </aside>
      <main className="auth-panel">
        <ThemeToggle className="auth-toggle" />
        <div className="brand auth-mobile-brand mobile-only">
          <span className="brand-mark" aria-hidden>
            <img src="/favicon.svg" alt="" width={32} height={32} />
          </span>
          <span className="brand-name">TicketManager</span>
        </div>
        <div className="auth-card">{children}</div>
      </main>
    </div>
  );
}
