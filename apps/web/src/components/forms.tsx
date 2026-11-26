import { PASSWORD_RULES } from '@ticketmanager/shared';
import { cloneElement, useId, type ReactElement } from 'react';

/**
 * A labelled form control. The label names the control; the hint and error are linked with
 * aria-describedby so screen readers read them without making them part of the name.
 */
export function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: ReactElement<{ id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }>;
}) {
  const id = useId();
  const controlId = children.props.id ?? `${id}-control`;
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="field">
      <label className="field-label" htmlFor={controlId}>
        {label}
      </label>
      {cloneElement(children, {
        id: controlId,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
      })}
      {hint && !error && (
        <span className="field-hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
      {error && (
        <span className="field-error" id={`${id}-error`} role="alert">
          {error}
        </span>
      )}
    </div>
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
