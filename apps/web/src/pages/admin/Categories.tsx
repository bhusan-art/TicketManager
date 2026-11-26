import type { Category } from '@ticketmanager/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Field, FormError } from '../../components/forms';
import { ApiError, apiGet, apiPatch, apiPost } from '../../lib/api';

interface Draft {
  id?: string;
  name: string;
  description: string;
  status: Category['status'];
}

const blank: Draft = { name: '', description: '', status: 'active' };

export function Categories() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    apiGet<{ data: Category[] }>('/categories?all=true').then(
      (r) => setCategories(r.data),
      (e: unknown) => setError(e instanceof ApiError ? e.message : 'Could not load categories'),
    );
  }, []);
  useEffect(load, [load]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!draft) return;
    setError(null);
    setFieldErrors({});
    const body = { name: draft.name, description: draft.description, status: draft.status };
    try {
      if (draft.id) await apiPatch(`/categories/${draft.id}`, body);
      else await apiPost('/categories', body);
      setDraft(null);
      load();
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors);
        setError(err.message);
      } else setError('Could not reach the server. Try again.');
    }
  }

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Expense categories</h1>
          <p className="muted">
            What employees pick for each expense. Switch a category off instead of deleting it, so
            old vouchers keep their category.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setDraft({ ...blank })}>
          + Add category
        </button>
      </div>

      <FormError message={error} />

      {draft && (
        <form className="card form-grid" onSubmit={onSubmit} noValidate>
          <h2 className="full">{draft.id ? 'Edit category' : 'New category'}</h2>
          <Field label="Name" error={fieldErrors.name}>
            <input
              value={draft.name}
              maxLength={60}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              autoFocus
            />
          </Field>
          <Field label="Status">
            <select
              value={draft.status}
              onChange={(e) => setDraft({ ...draft, status: e.target.value as Draft['status'] })}
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </Field>
          <div className="full">
            <Field label="Description" error={fieldErrors.description} hint="Optional">
              <input
                value={draft.description}
                maxLength={200}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </Field>
          </div>
          <div className="actions full">
            <button type="button" className="btn btn-secondary" onClick={() => setDraft(null)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={!draft.name.trim()}>
              Save
            </button>
          </div>
        </form>
      )}

      <div className="card table-card">
        <table className="table">
          <thead>
            <tr>
              <th>Category</th>
              <th>Description</th>
              <th>Status</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {categories.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>{c.description ?? '—'}</td>
                <td>
                  <span className={`pill ${c.status === 'active' ? 'up' : 'muted-pill'}`}>
                    {c.status === 'active' ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td>
                  <button
                    className="btn btn-link"
                    onClick={() =>
                      setDraft({
                        id: c.id,
                        name: c.name,
                        description: c.description ?? '',
                        status: c.status,
                      })
                    }
                  >
                    Edit
                  </button>
                </td>
              </tr>
            ))}
            {categories.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  No categories yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
