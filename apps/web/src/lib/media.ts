import { useEffect, useState } from 'react';

/** Phone layout: matches the CSS breakpoint in styles.css. */
export const PHONE_QUERY = '(max-width: 720px)';

/** Whether a CSS media query matches, updated as the window changes. False where unsupported. */
export function useMediaQuery(query: string) {
  const get = () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

export const usePhone = () => useMediaQuery(PHONE_QUERY);

/** A touch screen (phone or tablet), where a camera button makes sense. */
export const useTouch = () => useMediaQuery('(pointer: coarse)');

/** Whether the browser thinks it is online. */
export function useOnline() {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  );
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}
