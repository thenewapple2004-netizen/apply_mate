import { type FormEvent, useState } from 'react';

import { ApiError } from '@/lib/api.ts';

import type { Profile, ProfileInput } from './api.ts';

interface Props {
  /** The profile being edited; omit to create a new one. */
  initial?: Profile;
  onSubmit: (input: ProfileInput) => Promise<void>;
  onCancel: () => void;
}

type Field = keyof ProfileInput;

const FIELDS: { name: Field; label: string; type: string; placeholder?: string; required?: boolean }[] = [
  { name: 'full_name', label: 'Full name', type: 'text', required: true },
  { name: 'email', label: 'Email', type: 'email', placeholder: 'name@example.com' },
  { name: 'phone', label: 'Phone', type: 'tel', placeholder: '+92 300 1234567' },
  { name: 'location', label: 'Location', type: 'text', placeholder: 'City, Country' },
  {
    name: 'linkedin_url',
    label: 'LinkedIn URL',
    type: 'url',
    placeholder: 'https://www.linkedin.com/in/…',
  },
];

function toDraft(profile?: Profile): Record<Field, string> {
  return {
    full_name: profile?.full_name ?? '',
    email: profile?.email ?? '',
    phone: profile?.phone ?? '',
    location: profile?.location ?? '',
    linkedin_url: profile?.linkedin_url ?? '',
  };
}

export function ProfileForm({ initial, onSubmit, onCancel }: Props) {
  const [draft, setDraft] = useState(() => toDraft(initial));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!draft.full_name.trim()) {
      setFieldErrors({ full_name: 'Full name is required' });
      return;
    }
    setSaving(true);
    setFieldErrors({});
    setFormError(null);
    try {
      // Blank optional fields are sent as "" and stored as null by the backend.
      await onSubmit({ ...draft });
    } catch (error) {
      if (error instanceof ApiError) {
        setFieldErrors(error.fieldErrors);
        setFormError(error.message);
      } else {
        setFormError('Something went wrong. Please try again.');
      }
      setSaving(false);
    }
  }

  return (
    <form className="profile-form" onSubmit={handleSubmit} noValidate>
      <h3>{initial ? 'Edit profile' : 'New profile'}</h3>

      {FIELDS.map(({ name, label, type, placeholder, required }) => (
        <div className="field" key={name}>
          <label htmlFor={`profile-${name}`}>
            {label}
            {required && <span aria-hidden="true"> *</span>}
          </label>
          <input
            id={`profile-${name}`}
            type={type}
            value={draft[name]}
            placeholder={placeholder}
            required={required}
            autoComplete="off"
            aria-invalid={Boolean(fieldErrors[name])}
            aria-describedby={fieldErrors[name] ? `profile-${name}-error` : undefined}
            onChange={(e) => setDraft((d) => ({ ...d, [name]: e.target.value }))}
            disabled={saving}
          />
          {fieldErrors[name] && (
            <p className="field-error" id={`profile-${name}-error`}>
              {fieldErrors[name]}
            </p>
          )}
        </div>
      ))}

      {formError && Object.keys(fieldErrors).length === 0 && (
        <p className="notice error" role="alert">
          {formError}
        </p>
      )}

      <div className="actions">
        <button type="submit" className="btn primary" disabled={saving}>
          {saving ? 'Saving…' : initial ? 'Save changes' : 'Create profile'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}
