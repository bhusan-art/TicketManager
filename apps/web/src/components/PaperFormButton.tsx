import { FileDown } from 'lucide-react';
import { useState } from 'react';
import { ApiError, fetchFile } from '../lib/api';

/** Downloads a claim form with the person's details filled in, to fill in by hand. */
export function PaperFormButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="paper-form">
      <button
        type="button"
        className="btn btn-secondary"
        disabled={busy}
        title="A printable claim form for when you can't use the app"
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await fetchFile('/forms/claim.pdf', 'save', 'paper-claim-form.pdf');
          } catch (e) {
            setError(e instanceof ApiError ? e.message : 'Could not download the form');
          } finally {
            setBusy(false);
          }
        }}
      >
        <FileDown size={16} aria-hidden /> Paper claim form
      </button>
      {error && (
        <span className="error-text small" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
