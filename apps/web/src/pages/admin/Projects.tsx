import type { Project } from '@ticketmanager/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Field, FormError } from '../../components/forms';
import { ApiError, apiGet, apiPatch, apiPost } from '../../lib/api';

interface Draft {
  id?: string;
  name: string;
  code: string;
  description: string;
  status: Project['status'];
}

const blank: Draft = { name: '', code: '', description: '', status: 'active' };

/** Company projects that vouchers are booked to. Admin only. */
export function Projects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    apiGet<{ data: Project[] }>('/projects?all=true').then(
      (r) => setProjects(r.data),
      (e: unknown) => setError(e instanceof ApiError ? e.message : 'Could not load projects'),
    );
  }, []);
  useEffect(load, [load]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!draft) return;
    setError(null);
    setFieldErrors({});
    const body = {
      name: draft.name,
      code: draft.code,
      description: draft.description,
      status: draft.status,
    };
    try {
      if (draft.id) await apiPatch(`/projects/${draft.id}`, body);
      else await apiPost('/projects', body);
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
          <h1>Projects</h1>
          <p className="muted">
            Employees book each voucher to a project, so Accounts can see the spend per project
            under Reports. Close a finished project instead of deleting it: old vouchers keep it,
            and new ones can&apos;t use it.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setDraft({ ...blank })}>
          + Add project
        </button>
      </div>

      <FormError message={error} />

      {draft && (
        <form className="card form-grid" onSubmit={onSubmit} noValidate>
          <h2 className="full">{draft.id ? 'Edit project' : 'New project'}</h2>
          <Field label="Name" error={fieldErrors.name}>
            <input
              value={draft.name}
              maxLength={100}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              autoFocus
            />
          </Field>
          <Field label="Code" error={fieldErrors.code} hint="Optional, e.g. PRJ-104">
            <input
              value={draft.code}
              maxLength={30}
              onChange={(e) => setDraft({ ...draft, code: e.target.value })}
            />
          </Field>
          <Field label="Status">
            <select
              value={draft.status}
              onChange={(e) => setDraft({ ...draft, status: e.target.value as Draft['status'] })}
            >
              <option value="active">Active</option>
              <option value="inactive">Closed</option>
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
              <th>Project</th>
              <th>Code</th>
              <th>Description</th>
              <th>Status</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {projects.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>{c.code ?? '—'}</td>
                <td>{c.description ?? '—'}</td>
                <td>
                  <span className={`pill ${c.status === 'active' ? 'up' : 'muted-pill'}`}>
                    {c.status === 'active' ? 'Active' : 'Closed'}
                  </span>
                </td>
                <td>
                  <button
                    className="btn btn-link"
                    onClick={() =>
                      setDraft({
                        id: c.id,
                        name: c.name,
                        code: c.code ?? '',
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
            {projects.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No projects yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
