import { useEffect, useRef, useState } from 'react';

import { ApiError, describeError } from '../../lib/api.ts';
import { forgetPrepared } from '../apply/storage.ts';
import { Field, Section, TextInput } from '../cv/CVEditor.tsx';

import { type Arrangement, ARRANGEMENTS, EMPTY_PREFERENCES, type Preferences, preferencesApi } from './api.ts';

interface Props {
  profileId: string;
  onSaved: () => void;
  onCancel: () => void;
}

const lines = (items: string[]) => items.join('\n');
const fromLines = (text: string) => text.split('\n');

/** One small form for the applicant's preferences. Everything is optional. */
export function PreferencesForm({ profileId, onSaved, onCancel }: Props) {
  const [prefs, setPrefs] = useState<Preferences>(EMPTY_PREFERENCES);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const alive = useRef(new AbortController());

  useEffect(() => {
    const controller = new AbortController();
    alive.current = controller;
    preferencesApi
      .get(profileId, controller.signal)
      .then((loaded) => {
        if (controller.signal.aborted) return;
        setPrefs(loaded);
        setState('ready');
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        setError(describeError(e));
        setState('error');
      });
    return () => controller.abort();
  }, [profileId]);

  const set = <K extends keyof Preferences>(key: K, value: Preferences[K]) => setPrefs((p) => ({ ...p, [key]: value }));

  function toggleArrangement(value: Arrangement, on: boolean) {
    set('work_arrangements', on ? [...prefs.work_arrangements, value] : prefs.work_arrangements.filter((a) => a !== value));
  }

  async function save() {
    setSaving(true);
    setError(null);
    setFieldErrors({});
    try {
      await preferencesApi.save(profileId, prefs);
      // Answers prepared before this change may now be wrong: discard them.
      await forgetPrepared(profileId);
      onSaved();
    } catch (e) {
      if (e instanceof ApiError && Object.keys(e.fieldErrors).length > 0) {
        setFieldErrors(e.fieldErrors);
        setError('Some preferences need attention. Check the highlighted fields.');
      } else {
        setError(`Couldn't save. ${describeError(e)}`);
      }
      setSaving(false);
    }
  }

  if (state === 'loading') return <p className="hint">Loading preferences…</p>;
  if (state === 'error') {
    return (
      <div className="notice error" role="alert">
        <span>Couldn't load preferences. {error}</span>
        <button type="button" className="btn small" onClick={onCancel}>
          Close
        </button>
      </div>
    );
  }

  return (
    <section className="step-card review">
      <h3>Preferences</h3>
      <p className="hint">
        All optional. Used to answer application questions. Salary, work authorization and sponsorship answers are
        always shown for your approval before anything is filled.
      </p>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <div className="details-form">
        <Section title="Job search">
          <TextInput
            label="Salary expectation"
            value={prefs.salary_expectation}
            onChange={(v) => set('salary_expectation', v)}
            error={fieldErrors.salary_expectation}
            placeholder="e.g. PKR 400,000 per month"
            disabled={saving}
          />
          <TextInput
            label="Notice period"
            value={prefs.notice_period}
            onChange={(v) => set('notice_period', v)}
            error={fieldErrors.notice_period}
            placeholder="e.g. 30 days"
            disabled={saving}
          />
          <Field label="Preferred locations (one per line)" error={fieldErrors.preferred_locations}>
            <textarea rows={2} value={lines(prefs.preferred_locations)} onChange={(e) => set('preferred_locations', fromLines(e.target.value))} disabled={saving} />
          </Field>
          <fieldset className="cv-entry pref-group">
            <legend>Work arrangement</legend>
            {ARRANGEMENTS.map((a) => (
              <label key={a.value} className="check">
                <input type="checkbox" checked={prefs.work_arrangements.includes(a.value)} onChange={(e) => toggleArrangement(a.value, e.target.checked)} disabled={saving} />
                {a.label}
              </label>
            ))}
          </fieldset>
          <Field label="Reason for changing jobs" error={fieldErrors.change_reason}>
            <textarea rows={3} value={prefs.change_reason ?? ''} onChange={(e) => set('change_reason', e.target.value || null)} disabled={saving} />
          </Field>
          <Field label="Career goals" error={fieldErrors.career_goals}>
            <textarea rows={3} value={prefs.career_goals ?? ''} onChange={(e) => set('career_goals', e.target.value || null)} disabled={saving} />
          </Field>
        </Section>

        <Section title="Work authorization">
          <Field label="Authorized to work in (one country per line)" error={fieldErrors.work_authorization_countries}>
            <textarea rows={2} value={lines(prefs.work_authorization_countries)} onChange={(e) => set('work_authorization_countries', fromLines(e.target.value))} placeholder="e.g. Pakistan" disabled={saving} />
          </Field>
          <Field label="Will you need visa sponsorship?">
            <select
              value={prefs.requires_sponsorship === null ? '' : prefs.requires_sponsorship ? 'yes' : 'no'}
              onChange={(e) => set('requires_sponsorship', e.target.value === '' ? null : e.target.value === 'yes')}
              disabled={saving}
            >
              <option value="">Not set</option>
              <option value="no">No, I don't need sponsorship</option>
              <option value="yes">Yes, I need sponsorship</option>
            </select>
          </Field>
        </Section>
      </div>
      <div className="form-footer">
        <button type="button" className="btn primary" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save preferences'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </section>
  );
}
