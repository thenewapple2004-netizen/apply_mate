import { useState } from 'react';

import { ApiError, describeError } from '../../lib/api.ts';
import { type CVData, cvApi, EMPTY_CV, toCVData } from '../cv/api.ts';
import { profilesApi } from '../profiles/api.ts';

import { type OnboardingState, onboardingApi, type Section } from './api.ts';
import { type DetailField, type DetailValues, DetailsForm } from './DetailsForm.tsx';

const FIELDS: DetailField[] = ['full_name', 'email', 'phone', 'location', 'linkedin_url'];
const SECTIONS: Section[] = [
  'summary', 'skills', 'technologies', 'work_experience', 'education', 'projects', 'certifications',
];

interface Props {
  state: OnboardingState;
  onSaved: (next: OnboardingState) => void;
  onCancel: () => void;
}

/** Secondary action: edit all saved details, using the same form as onboarding. */
export function EditDetails({ state, onSaved, onCancel }: Props) {
  const { profile } = state;
  const [values, setValues] = useState<DetailValues>({
    full_name: profile.full_name,
    email: profile.email,
    phone: profile.phone,
    location: profile.location,
    linkedin_url: profile.linkedin_url,
  });
  const [cv, setCv] = useState<CVData>(state.cv ? toCVData(state.cv) : EMPTY_CV);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!values.full_name?.trim()) {
      setErrors({ full_name: 'Full name is required' });
      return;
    }
    setSaving(true);
    setErrors({});
    setMessage(null);
    try {
      await profilesApi.update(profile.id, {
        full_name: values.full_name ?? '',
        email: values.email ?? null,
        phone: values.phone ?? null,
        location: values.location ?? null,
        linkedin_url: values.linkedin_url ?? null,
      });
      await cvApi.saveDetails(profile.id, cv, null);
      onSaved(await onboardingApi.get(profile.id));
    } catch (error) {
      if (error instanceof ApiError && Object.keys(error.fieldErrors).length > 0) {
        setErrors(error.fieldErrors);
        setMessage('Some details need attention. Check the highlighted fields.');
      } else {
        setMessage(`Couldn't save. ${describeError(error)}`);
      }
      setSaving(false);
    }
  }

  return (
    <section className="step-card review">
      <h3>Edit details</h3>
      {message && (
        <p className="notice error" role="alert">
          {message}
        </p>
      )}
      <DetailsForm
        fields={FIELDS}
        values={values}
        onValuesChange={setValues}
        sections={SECTIONS}
        cv={cv}
        onCvChange={setCv}
        errors={errors}
        disabled={saving}
      />
      <div className="form-footer">
        <button type="button" className="btn primary" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </section>
  );
}
