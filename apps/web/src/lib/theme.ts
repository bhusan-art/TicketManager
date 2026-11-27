import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

/** Same key as public/theme.js, which applies the theme before the page first draws. */
const KEY = 'tm-theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

function saved(): Theme | null {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : null;
  } catch {
    return null;
  }
}

function system(): Theme {
  return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches
    ? 'dark'
    : 'light';
}

function current(): Theme {
  const attr = document.documentElement.getAttribute('data-theme');
  return attr === 'dark' || attr === 'light' ? attr : (saved() ?? system());
}

function apply(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

/** The light/dark choice. Saved on this device; follows the system until someone picks one. */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(current);

  // Until a choice is saved, follow the system as it switches (e.g. at sunset).
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(DARK_QUERY);
    const onChange = () => {
      if (saved()) return;
      const t = system();
      apply(t);
      setThemeState(t);
    };
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, []);

  // Another tab changed it.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== KEY) return;
      const t = saved() ?? system();
      apply(t);
      setThemeState(t);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    try {
      localStorage.setItem(KEY, t);
    } catch {
      // Storage blocked: the choice lasts until the page is closed.
    }
    apply(t);
    setThemeState(t);
  }, []);

  return { theme, setTheme, toggle: () => setTheme(theme === 'dark' ? 'light' : 'dark') };
}
