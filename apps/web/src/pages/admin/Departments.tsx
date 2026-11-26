import type { DepartmentSummary, Paginated, UserSummary } from '@ticketmanager/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Field, FormError } from '../../components/forms';
import { ApiError, apiGet, apiPatch, apiPost } from '../../lib/api';

interface Draft {
  id?: string;
  name: string;
  code: string;
  headId: string;
  status: 'active' | 'inactive';
}

const blank: Draft = { name: '', code: '', headId: '', status: 'active' };

export function Departments() {
  const [departments, setDepartments] = useState<DepartmentSummary[]>([]);
  const [people, setPeople] = useState<UserSummary[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    apiGet<{ data: DepartmentSummary[] }>('/admin/departments').then(
      (r) => setDepartments(r.data),
      (e: unknown) => setError(e instanceof ApiError ? e.message : 'Could not load departments'),
    );
  }, []);

  useEffect(() => {
    load();
    apiGet<Paginated<UserSummary>>('/admin/users?status=active&pageSize=100').then((r) =>
      setPeople(r.data),
    );
  }, [load]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!draft) return;
    setError(null);
    setFieldErrors({});
    const body = {
      name: draft.name,
      code: draft.code,
      headId: draft.headId || null,
      status: draft.status,
    };
    try {
      if (draft.id) await apiPatch(`/admin/departments/${draft.id}`, body);
      else await apiPost('/admin/departments', body);
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
          <h1>Departments</h1>
          <p className="muted">Group people and name a head for each department.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setDraft({ ...blank })}>
          + Add department
        </button>
      </div>

      <FormError message={error} />

      {draft && (
        <form className="card form-grid" onSubmit={onSubmit} noValidate>
          <h2 className="full">{draft.id ? 'Edit department' : 'New department'}</h2>
          <Field label="Name" error={fieldErrors.name}>
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              autoFocus
            />
          </Field>
          <Field label="Code" error={fieldErrors.code} hint="Optional, e.g. ENG">
            <input
              value={draft.code}
              onChange={(e) => setDraft({ ...draft, code: e.target.value })}
            />
          </Field>
          <Field label="Head" error={fieldErrors.headId}>
            <select
              value={draft.headId}
              onChange={(e) => setDraft({ ...draft, headId: e.target.value })}
            >
              <option value="">No head</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
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
              <th>Department</th>
              <th>Code</th>
              <th>Head</th>
              <th>Active people</th>
              <th>Status</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {departments.map((d) => (
              <tr key={d.id}>
                <td>{d.name}</td>
                <td>{d.code ?? '—'}</td>
                <td>{d.head?.name ?? '—'}</td>
                <td>{d.activeMembers}</td>
                <td>
                  <span className={`pill ${d.status === 'active' ? 'up' : 'muted-pill'}`}>
                    {d.status === 'active' ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td>
                  <button
                    className="btn btn-link"
                    onClick={() =>
                      setDraft({
                        id: d.id,
                        name: d.name,
                        code: d.code ?? '',
                        headId: d.head?.id ?? '',
                        status: d.status,
                      })
                    }
                  >
                    Edit
                  </button>
                </td>
              </tr>
            ))}
            {departments.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No departments yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
