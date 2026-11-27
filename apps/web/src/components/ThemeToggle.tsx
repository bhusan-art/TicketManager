import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../lib/theme';

/** A light/dark switch: sun on the left, moon on the right, the knob shows which is on. */
export function ThemeToggle({ className = '' }: { className?: string }) {
  const { theme, toggle } = useTheme();
  const dark = theme === 'dark';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      aria-label="Dark mode"
      title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      className={`theme-toggle ${dark ? 'is-dark' : ''} ${className}`}
      onClick={toggle}
    >
      <span className="theme-toggle-icon sun" aria-hidden>
        <Sun size={14} />
      </span>
      <span className="theme-toggle-icon moon" aria-hidden>
        <Moon size={14} />
      </span>
      <span className="theme-toggle-knob" aria-hidden />
    </button>
  );
}
