import { PASSWORD_RULES } from '@ticketmanager/shared';
import type { ReactNode } from 'react';

export function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && !error && <span className="field-hint">{hint}</span>}
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="form-error" role="alert">
      {message}
    </div>
  );
}

/** Live checklist of the password rules, as on the reset password board. */
export function PasswordChecklist({ password }: { password: string }) {
  return (
    <ul className="password-rules" aria-label="Password rules">
      {PASSWORD_RULES.map((rule) => {
        const ok = rule.test(password);
        return (
          <li key={rule.id} className={ok ? 'ok' : undefined}>
            <span aria-hidden>{ok ? '✓' : '○'}</span> {rule.label}
          </li>
        );
      })}
    </ul>
  );
}

export const passwordOk = (p: string) => PASSWORD_RULES.every((r) => r.test(p));
