import type { ReactNode } from 'react';

import type { Certification, CVData, Education, Project, WorkExperience } from './api.ts';

interface Props {
  value: CVData;
  onChange: (next: CVData) => void;
  /** Validation messages keyed by field path, e.g. "work_experience.0.company". */
  errors: Record<string, string>;
  disabled?: boolean;
}

const lines = (items: string[]) => items.join('\n');
const fromLines = (text: string) => text.split('\n');
// Keep exactly what the user typed (including empty lines while typing);
// the backend trims and drops blank entries on save.
const text = (v: string) => (v === '' ? null : v);

export function CVEditor({ value, onChange, errors, disabled }: Props) {
  const set = <K extends keyof CVData>(key: K, v: CVData[K]) => onChange({ ...value, [key]: v });

  return (
    <div className="cv-editor">
      <Section title="Professional summary">
        <Field label="Summary" error={errors.summary}>
          <textarea
            rows={4}
            value={value.summary ?? ''}
            onChange={(e) => set('summary', text(e.target.value))}
            disabled={disabled}
            placeholder="Not in the resume"
          />
        </Field>
      </Section>

      <Section title="Skills and technologies">
        <div className="grid-2">
          <Field label="Skills (one per line)" error={errors.skills}>
            <textarea
              rows={6}
              value={lines(value.skills)}
              onChange={(e) => set('skills', fromLines(e.target.value))}
              disabled={disabled}
            />
          </Field>
          <Field label="Technologies (one per line)" error={errors.technologies}>
            <textarea
              rows={6}
              value={lines(value.technologies)}
              onChange={(e) => set('technologies', fromLines(e.target.value))}
              disabled={disabled}
            />
          </Field>
        </div>
      </Section>

      <EntryList<WorkExperience>
        title="Work experience"
        noun="position"
        items={value.work_experience}
        onChange={(items) => set('work_experience', items)}
        empty={{ company: null, title: null, location: null, start_date: null, end_date: null, is_current: null, responsibilities: [] }}
        disabled={disabled}
        render={(item, update, path) => (
          <>
            <div className="grid-2">
              <TextInput label="Job title" value={item.title} onChange={(v) => update({ title: v })} error={errors[`${path}.title`]} disabled={disabled} />
              <TextInput label="Company" value={item.company} onChange={(v) => update({ company: v })} error={errors[`${path}.company`]} disabled={disabled} />
              <TextInput label="Location" value={item.location} onChange={(v) => update({ location: v })} error={errors[`${path}.location`]} disabled={disabled} />
              <div className="grid-2">
                <TextInput label="Start" value={item.start_date} onChange={(v) => update({ start_date: v })} error={errors[`${path}.start_date`]} disabled={disabled} />
                <TextInput label="End" value={item.end_date} onChange={(v) => update({ end_date: v })} error={errors[`${path}.end_date`]} disabled={disabled} />
              </div>
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={item.is_current === true}
                onChange={(e) => update({ is_current: e.target.checked ? true : null })}
                disabled={disabled}
              />
              I currently work here
            </label>
            <Field label="Responsibilities (one per line)" error={errors[`${path}.responsibilities`]}>
              <textarea
                rows={4}
                value={lines(item.responsibilities)}
                onChange={(e) => update({ responsibilities: fromLines(e.target.value) })}
                disabled={disabled}
              />
            </Field>
          </>
        )}
        pathPrefix="work_experience"
      />

      <EntryList<Education>
        title="Education"
        noun="education"
        items={value.education}
        onChange={(items) => set('education', items)}
        empty={{ institution: null, degree: null, field_of_study: null, start_date: null, end_date: null, details: [] }}
        disabled={disabled}
        pathPrefix="education"
        render={(item, update, path) => (
          <>
            <div className="grid-2">
              <TextInput label="Institution" value={item.institution} onChange={(v) => update({ institution: v })} error={errors[`${path}.institution`]} disabled={disabled} />
              <TextInput label="Degree" value={item.degree} onChange={(v) => update({ degree: v })} error={errors[`${path}.degree`]} disabled={disabled} />
              <TextInput label="Field of study" value={item.field_of_study} onChange={(v) => update({ field_of_study: v })} error={errors[`${path}.field_of_study`]} disabled={disabled} />
              <div className="grid-2">
                <TextInput label="Start" value={item.start_date} onChange={(v) => update({ start_date: v })} error={errors[`${path}.start_date`]} disabled={disabled} />
                <TextInput label="End" value={item.end_date} onChange={(v) => update({ end_date: v })} error={errors[`${path}.end_date`]} disabled={disabled} />
              </div>
            </div>
            <Field label="Details (one per line)" error={errors[`${path}.details`]}>
              <textarea rows={2} value={lines(item.details)} onChange={(e) => update({ details: fromLines(e.target.value) })} disabled={disabled} />
            </Field>
          </>
        )}
      />

      <EntryList<Project>
        title="Projects"
        noun="project"
        items={value.projects}
        onChange={(items) => set('projects', items)}
        empty={{ name: null, role: null, description: null, technologies: [], url: null }}
        disabled={disabled}
        pathPrefix="projects"
        render={(item, update, path) => (
          <>
            <div className="grid-2">
              <TextInput label="Name" value={item.name} onChange={(v) => update({ name: v })} error={errors[`${path}.name`]} disabled={disabled} />
              <TextInput label="Role" value={item.role} onChange={(v) => update({ role: v })} error={errors[`${path}.role`]} disabled={disabled} />
            </div>
            <TextInput label="Link" value={item.url} onChange={(v) => update({ url: v })} error={errors[`${path}.url`]} disabled={disabled} />
            <Field label="Description" error={errors[`${path}.description`]}>
              <textarea rows={3} value={item.description ?? ''} onChange={(e) => update({ description: text(e.target.value) })} disabled={disabled} />
            </Field>
            <Field label="Technologies (one per line)" error={errors[`${path}.technologies`]}>
              <textarea rows={2} value={lines(item.technologies)} onChange={(e) => update({ technologies: fromLines(e.target.value) })} disabled={disabled} />
            </Field>
          </>
        )}
      />

      <EntryList<Certification>
        title="Certifications"
        noun="certification"
        items={value.certifications}
        onChange={(items) => set('certifications', items)}
        empty={{ name: null, issuer: null, date: null }}
        disabled={disabled}
        pathPrefix="certifications"
        render={(item, update, path) => (
          <div className="grid-3">
            <TextInput label="Name" value={item.name} onChange={(v) => update({ name: v })} error={errors[`${path}.name`]} disabled={disabled} />
            <TextInput label="Issuer" value={item.issuer} onChange={(v) => update({ issuer: v })} error={errors[`${path}.issuer`]} disabled={disabled} />
            <TextInput label="Date" value={item.date} onChange={(v) => update({ date: v })} error={errors[`${path}.date`]} disabled={disabled} />
          </div>
        )}
      />
    </div>
  );
}

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="cv-section">
      <div className="cv-section-head">
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <label className={error ? 'cv-field invalid' : 'cv-field'}>
      <span>{label}</span>
      {children}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

function TextInput(props: {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
  error?: string;
  disabled?: boolean;
}) {
  return (
    <Field label={props.label} error={props.error}>
      <input
        type="text"
        value={props.value ?? ''}
        onChange={(e) => props.onChange(text(e.target.value))}
        disabled={props.disabled}
        placeholder="Not in the resume"
      />
    </Field>
  );
}

function EntryList<T>(props: {
  title: string;
  noun: string;
  items: T[];
  onChange: (items: T[]) => void;
  empty: T;
  render: (item: T, update: (patch: Partial<T>) => void, path: string) => ReactNode;
  pathPrefix: string;
  disabled?: boolean;
}) {
  const { items, onChange } = props;
  return (
    <Section
      title={props.title}
      action={
        <button type="button" className="link-btn" onClick={() => onChange([...items, { ...props.empty }])} disabled={props.disabled}>
          + Add {props.noun}
        </button>
      }
    >
      {items.length === 0 && <p className="hint">None found in the resume. Add one if it's missing.</p>}
      {items.map((item, index) => (
        <fieldset className="cv-entry" key={index}>
          <legend className="sr-only">
            {props.title} {index + 1}
          </legend>
          {props.render(
            item,
            (patch) => onChange(items.map((it, i) => (i === index ? { ...it, ...patch } : it))),
            `${props.pathPrefix}.${index}`,
          )}
          <div className="cv-entry-actions">
            <button
              type="button"
              className="btn small danger"
              onClick={() => onChange(items.filter((_, i) => i !== index))}
              disabled={props.disabled}
            >
              Remove {props.noun}
            </button>
          </div>
        </fieldset>
      ))}
    </Section>
  );
}
