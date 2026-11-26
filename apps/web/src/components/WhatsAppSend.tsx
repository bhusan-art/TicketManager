import { formatWhatsApp, type WhatsAppSuggestions } from '@ticketmanager/shared';
import { MessageCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { apiGet } from '../lib/api';

/**
 * Ready-made WhatsApp messages about a claim or advance. Each button opens WhatsApp (app or web)
 * with the person's number and the message filled in; the user presses Send there. Nothing is
 * sent by the app. `path` is /vouchers/:id or /advances/:id.
 */
export function WhatsAppSend({ path, version }: { path: string; version: number }) {
  const [data, setData] = useState<WhatsAppSuggestions | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    apiGet<WhatsAppSuggestions>(`${path}/whatsapp`).then(
      (d) => active && setData(d),
      () => active && setData(null),
    );
    return () => {
      active = false;
    };
  }, [path, version]);

  if (!data || (data.suggestions.length === 0 && data.missing.length === 0)) return null;

  return (
    <div className="card wide whatsapp">
      <div className="follow-up-head">
        <div>
          <strong>Send on WhatsApp</strong>
          <span className="muted small">
            Opens WhatsApp with the message ready. Check it and press Send there.
          </span>
        </div>
      </div>
      <ul className="whatsapp-list">
        {data.suggestions.map((s) => (
          <li key={s.to.id}>
            <div>
              <strong>{s.to.name}</strong>{' '}
              <span className="muted small">
                {s.reason} · {formatWhatsApp(s.number)}
              </span>
              <button
                type="button"
                className="link-button small"
                aria-expanded={preview === s.to.id}
                onClick={() => setPreview((p) => (p === s.to.id ? null : s.to.id))}
              >
                {preview === s.to.id ? 'Hide message' : 'See message'}
              </button>
              {preview === s.to.id && <p className="whatsapp-text">{s.text}</p>}
            </div>
            <a
              className="btn btn-secondary btn-sm"
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              <MessageCircle size={14} aria-hidden /> WhatsApp {s.to.name.split(' ')[0]}
            </a>
          </li>
        ))}
      </ul>
      {data.missing.length > 0 && (
        <p className="muted small">
          No WhatsApp number saved for {data.missing.map((m) => m.name).join(', ')}. An admin can
          add it on the user&apos;s page, or they can add it on their profile.
        </p>
      )}
    </div>
  );
}
