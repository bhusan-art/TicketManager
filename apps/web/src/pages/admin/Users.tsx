import {
  ROLE_LABELS,
  ROLES,
  type DepartmentSummary,
  type Paginated,
  type Role,
  type UserSummary,
} from '@ticketmanager/shared';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { FormError } from '../../components/forms';
import { ApiError, apiGet } from '../../lib/api';

export function Users() {
  const [params, setParams] = useSearchParams();
  const [result, setResult] = useState<Paginated<UserSummary> | null>(null);
  const [departments, setDepartments] = useState<DepartmentSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState(params.get('search') ?? '');

  const query = params.toString();
  useEffect(() => {
    let active = true;
    apiGet<Paginated<UserSummary>>(`/admin/users?${query}`).then(
      (r) => active && setResult(r),
      (e: unknown) =>
        active && setError(e instanceof ApiError ? e.message : 'Could not load users'),
    );
    return () => {
      active = false;
    };
  }, [query]);

  useEffect(() => {
    apiGet<{ data: DepartmentSummary[] }>('/admin/departments').then(
      (r) => setDepartments(r.data),
      () => {},
    );
  }, []);

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete('page');
    setParams(next);
  }

  // Search as you type, after a short pause.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (search !== (params.get('search') ?? '')) setFilter('search', search.trim());
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const meta = result?.meta;
  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Users &amp; roles</h1>
          <p className="muted">Everyone who can sign in, their roles and who they report to.</p>
        </div>
        <Link to="/admin/users/new" className="btn btn-primary">
          + Add user
        </Link>
      </div>

      <div className="filters">
        <input
          type="search"
          placeholder="Search name, email or employee ID"
          aria-label="Search users"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          aria-label="Role"
          value={params.get('role') ?? ''}
          onChange={(e) => setFilter('role', e.target.value)}
        >
          <option value="">All roles</option>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
        <select
          aria-label="Department"
          value={params.get('departmentId') ?? ''}
          onChange={(e) => setFilter('departmentId', e.target.value)}
        >
          <option value="">All departments</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Status"
          value={params.get('status') ?? ''}
          onChange={(e) => setFilter('status', e.target.value)}
        >
          <option value="">Any status</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
      </div>

      <FormError message={error} />
      <div className="card table-card">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Department</th>
              <th>Reports to</th>
              <th>Roles</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {result?.data.map((u) => (
              <tr key={u.id}>
                <td>
                  <Link to={`/admin/users/${u.id}`}>{u.name}</Link>
                  {u.employeeCode && <div className="muted small">{u.employeeCode}</div>}
                </td>
                <td>{u.email}</td>
                <td>{u.department?.name ?? '—'}</td>
                <td>{u.manager?.name ?? '—'}</td>
                <td>
                  <RoleChips roles={u.roles} />
                </td>
                <td>
                  <span className={`pill ${u.status === 'active' ? 'up' : 'muted-pill'}`}>
                    {u.status === 'active' ? 'Active' : 'Inactive'}
                  </span>
                  {!u.hasPassword && !u.googleLinked && u.status === 'active' && (
                    <div className="muted small">Invite pending</div>
                  )}
                </td>
              </tr>
            ))}
            {result && result.data.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No users match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {meta && meta.totalPages > 1 && (
        <nav className="pager" aria-label="Pages">
          <button
            className="btn btn-secondary"
            disabled={meta.page <= 1}
            onClick={() => setFilter('page', String(meta.page - 1))}
          >
            Previous
          </button>
          <span>
            Page {meta.page} of {meta.totalPages} · {meta.total} users
          </span>
          <button
            className="btn btn-secondary"
            disabled={meta.page >= meta.totalPages}
            onClick={() => setFilter('page', String(meta.page + 1))}
          >
            Next
          </button>
        </nav>
      )}
    </section>
  );
}

export function RoleChips({ roles }: { roles: Role[] }) {
  return (
    <span className="chips">
      {roles.map((r) => (
        <span key={r} className={`chip chip-${r}`}>
          {ROLE_LABELS[r]}
        </span>
      ))}
    </span>
  );
}
