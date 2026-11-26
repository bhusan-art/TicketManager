import {
  ROLE_LABELS,
  ROLES,
  formatWhatsApp,
  type DepartmentSummary,
  type Paginated,
  type Role,
  type UserSummary,
} from '@ticketmanager/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Field, FormError } from '../../components/forms';
import { ApiError, apiGet, apiPatch, apiPost } from '../../lib/api';

interface FormState {
  name: string;
  email: string;
  employeeCode: string;
  designation: string;
  whatsappNumber: string;
  departmentId: string;
  managerId: string;
  roles: Role[];
  status: 'active' | 'inactive';
  sendInvite: boolean;
}

const empty: FormState = {
  name: '',
  email: '',
  employeeCode: '',
  designation: '',
  whatsappNumber: '',
  departmentId: '',
  managerId: '',
  roles: ['employee'],
  status: 'active',
  sendInvite: true,
};

const ROLE_HELP: Record<Role, string> = {
  employee: 'Submits own expense claims and advances',
  manager: 'Approves claims from people who report to them',
  accounts: 'Verifies approved claims and records payments',
  director: 'Gives final approval on claims from Accounts staff',
  admin: 'Manages users, departments and settings',
};

export function UserForm() {
  const { id } = useParams();
  const editing = Boolean(id);
  const navigate = useNavigate();
  const [form, setForm] = useState<FormState>(empty);
  const [original, setOriginal] = useState<UserSummary | null>(null);
  const [departments, setDepartments] = useState<DepartmentSummary[]>([]);
  const [managers, setManagers] = useState<UserSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ data: DepartmentSummary[] }>('/admin/departments').then((r) => setDepartments(r.data));
    apiGet<Paginated<UserSummary>>('/admin/users?role=manager&status=active&pageSize=100').then(
      (r) => setManagers(r.data),
    );
  }, []);

  useEffect(() => {
    if (!id) return;
    apiGet<UserSummary>(`/admin/users/${id}`).then(
      (u) => {
        setOriginal(u);
        setForm({
          name: u.name,
          email: u.email,
          employeeCode: u.employeeCode ?? '',
          designation: u.designation ?? '',
          whatsappNumber: u.whatsappNumber ? formatWhatsApp(u.whatsappNumber) : '',
          departmentId: u.department?.id ?? '',
          managerId: u.manager?.id ?? '',
          roles: u.roles,
          status: u.status,
          sendInvite: false,
        });
      },
      (e: unknown) => setError(e instanceof ApiError ? e.message : 'Could not load the user'),
    );
  }, [id]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  function toggleRole(role: Role) {
    set(
      'roles',
      form.roles.includes(role) ? form.roles.filter((r) => r !== role) : [...form.roles, role],
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});
    const body = {
      name: form.name,
      email: form.email,
      employeeCode: form.employeeCode,
      designation: form.designation,
      whatsappNumber: form.whatsappNumber.trim() || null,
      departmentId: form.departmentId || null,
      managerId: form.managerId || null,
      roles: ROLES.filter((r) => form.roles.includes(r)),
      ...(editing ? { status: form.status } : { sendInvite: form.sendInvite }),
    };
    try {
      if (editing) await apiPatch(`/admin/users/${id}`, body);
      else await apiPost('/admin/users', body);
      navigate('/admin/users');
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors);
        setError(err.message);
      } else setError('Could not reach the server. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function resendInvite() {
    setNotice(null);
    try {
      await apiPost(`/admin/users/${id}/invite`);
      setNotice(`Sent ${form.email} a link to set their password.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send the email');
    }
  }

  const managerOptions = managers.filter((m) => m.id !== id);

  return (
    <section>
      <Link to="/admin/users" className="back-link">
        ← Users
      </Link>
      <h1>{editing ? `Edit ${original?.name ?? 'user'}` : 'Add user'}</h1>
      <form onSubmit={onSubmit} noValidate className="card form-grid">
        <FormError message={error} />
        {notice && <p className="notice">{notice}</p>}
        <Field label="Full name" error={fieldErrors.name}>
          <input value={form.name} onChange={(e) => set('name', e.target.value)} required />
        </Field>
        <Field label="Email" error={fieldErrors.email}>
          <input
            type="email"
            value={form.email}
            onChange={(e) => set('email', e.target.value)}
            required
          />
        </Field>
        <Field label="Employee ID" error={fieldErrors.employeeCode}>
          <input value={form.employeeCode} onChange={(e) => set('employeeCode', e.target.value)} />
        </Field>
        <Field label="Designation" error={fieldErrors.designation}>
          <input value={form.designation} onChange={(e) => set('designation', e.target.value)} />
        </Field>
        <Field
          label="WhatsApp number"
          error={fieldErrors.whatsappNumber}
          hint="Optional. A 10-digit Indian mobile, or with the country code (+44…). Used for “Send on WhatsApp”."
        >
          <input
            type="tel"
            inputMode="tel"
            autoComplete="off"
            placeholder="98765 43210"
            value={form.whatsappNumber}
            onChange={(e) => set('whatsappNumber', e.target.value)}
          />
        </Field>
        <Field label="Department" error={fieldErrors.departmentId}>
          <select value={form.departmentId} onChange={(e) => set('departmentId', e.target.value)}>
            <option value="">No department</option>
            {departments
              .filter((d) => d.status === 'active' || d.id === form.departmentId)
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
          </select>
        </Field>
        <Field
          label="Reporting manager"
          error={fieldErrors.managerId}
          hint="Their claims go to this person first. Only users with the Manager role are listed."
        >
          <select value={form.managerId} onChange={(e) => set('managerId', e.target.value)}>
            <option value="">No manager</option>
            {managerOptions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.department ? ` (${m.department.name})` : ''}
              </option>
            ))}
          </select>
        </Field>

        <fieldset className="roles full">
          <legend>Roles</legend>
          {fieldErrors.roles && <span className="field-error">{fieldErrors.roles}</span>}
          {ROLES.map((role) => (
            <label key={role} className="check">
              <input
                type="checkbox"
                checked={form.roles.includes(role)}
                onChange={() => toggleRole(role)}
              />
              <span>
                <strong>{ROLE_LABELS[role]}</strong>
                <span className="muted small"> · {ROLE_HELP[role]}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {editing ? (
          <label className="check full">
            <input
              type="checkbox"
              checked={form.status === 'active'}
              onChange={(e) => set('status', e.target.checked ? 'active' : 'inactive')}
            />
            <span>Active (inactive users cannot sign in and are signed out at once)</span>
          </label>
        ) : (
          <label className="check full">
            <input
              type="checkbox"
              checked={form.sendInvite}
              onChange={(e) => set('sendInvite', e.target.checked)}
            />
            <span>Email them a link to set their password</span>
          </label>
        )}

        <div className="actions full">
          {editing && original?.status === 'active' && (
            <button type="button" className="btn btn-secondary" onClick={resendInvite}>
              {original.hasPassword ? 'Send password reset link' : 'Resend invite'}
            </button>
          )}
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || form.roles.length === 0}
          >
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Create user'}
          </button>
        </div>
      </form>
    </section>
  );
}
