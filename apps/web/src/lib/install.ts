import { useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

if (typeof window !== 'undefined') {
  // Chrome and Edge offer installing when the app qualifies; keep the offer for our own button.
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    notify();
  });
}

/**
 * Returns a function that shows the browser's "Install app" prompt, or null when the browser
 * hasn't offered one (already installed, Safari, or not served over HTTPS).
 */
export function useInstallPrompt(): (() => Promise<void>) | null {
  const [, setTick] = useState(0);
  useEffect(() => {
    const l = () => setTick((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  if (!deferred) return null;
  const event = deferred;
  return async () => {
    await event.prompt();
    await event.userChoice;
    deferred = null;
    notify();
  };
}
