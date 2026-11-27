import { projectLabel, type Project } from '@ticketmanager/shared';
import { useEffect, useState } from 'react';
import { apiGet } from '../lib/api';

/** Every project (closed ones too), for filters. Loaded once per screen. */
export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([]);
  useEffect(() => {
    let active = true;
    apiGet<{ data: Project[] }>('/projects?all=true').then(
      (r) => active && setProjects(r.data),
      () => {},
    );
    return () => {
      active = false;
    };
  }, []);
  return projects;
}

/** A project filter: all, one project, or vouchers with no project ("none"). */
export function ProjectSelect({
  value,
  onChange,
  projects,
  id,
  'aria-label': ariaLabel,
  'aria-describedby': describedBy,
}: {
  value: string;
  onChange: (value: string) => void;
  projects: Project[];
  id?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
}) {
  return (
    <select
      id={id}
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">All projects</option>
      <option value="none">No project</option>
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {projectLabel(p)}
          {p.status === 'inactive' ? ' (closed)' : ''}
        </option>
      ))}
    </select>
  );
}
