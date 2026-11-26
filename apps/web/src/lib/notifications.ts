import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { apiGet } from './api';

const CHANGED = 'notifications:changed';

/** Tells the unread badge to refresh, e.g. after marking notifications read. */
export const notificationsChanged = () => window.dispatchEvent(new Event(CHANGED));

/** Unread notifications for the signed-in person. Refreshes on navigation and every minute. */
export function useUnreadCount(): number {
  const [unread, setUnread] = useState(0);
  const { pathname } = useLocation();
  useEffect(() => {
    let active = true;
    const load = () =>
      apiGet<{ unread: number }>('/notifications/unread-count').then(
        (r) => active && setUnread(r.unread),
        () => {},
      );
    void load();
    const timer = setInterval(load, 60_000);
    window.addEventListener(CHANGED, load);
    window.addEventListener('focus', load);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener(CHANGED, load);
      window.removeEventListener('focus', load);
    };
  }, [pathname]);
  return unread;
}
