import { useEffect, useRef, useState } from 'react';

import { ApiError, describeError } from '../../lib/api.ts';
import { type CVData, cvApi } from '../cv/api.ts';

import { type OnboardingState, onboardingApi, type ReviewForm } from './api.ts';
import { type DetailValues, DetailsForm, formErrors } from './DetailsForm.tsx';

interface Props {
  state: OnboardingState & { review: ReviewForm };
  /** Called with the new state after the details are saved. */
  onSaved: (next: OnboardingState) => void;
  /** Present when reviewing updates for an already-onboarded profile. */
  onCancel?: () => void;
}

type Phase = 'choose' | 'analyzing' | 'form';

export function ReviewStep({ state, onSaved, onCancel }: Props) {
  const [review, setReview] = useState<ReviewForm>(state.review);
  const [phase, setPhase] = useState<Phase>(state.review.source_analysis_id ? 'form' : 'choose');
  const [values, setValues] = useState<DetailValues>(state.review.contact);
  const [cv, setCv] = useState<CVData>(state.review.cv);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const lifetime = useRef(new AbortController());
  const profileId = state.profile.id;
  const resume = state.resume;
  const isUpdate = state.step === 'complete';

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  function load(next: ReviewForm) {
    setReview(next);
    setValues(next.contact);
    setCv(next.cv);
  }

  async function suggestWithAI() {
    if (!resume) return;
    const { signal } = lifetime.current;
    setMessage(null);
    setPhase('analyzing');
    try {
      await cvApi.analyze(profileId, resume.id, signal);
      const fresh = await onboardingApi.get(profileId, signal);
      if (signal.aborted) return;
      if (fresh.review) load(fresh.review);
    } catch (error) {
      if (signal.aborted) return;
      const reason = `AI suggestions aren't available right now. ${describeError(error)}`;
      if (isUpdate) {
        // Nothing is missing on a finished profile, so a manual form would be empty.
        setMessage(reason);
        setPhase('choose');
        return;
      }
      // First-time setup: fall back to filling the details in by hand.
      setMessage(`${reason} You can fill in the details yourself.`);
    }
    setPhase('form');
  }

  async function save() {
    setSaving(true);
    setErrors({});
    setMessage(null);
    const contact = Object.fromEntries(
      Object.entries(values).filter(([, v]) => typeof v === 'string' && v.trim() !== ''),
    );
    try {
      const next = await onboardingApi.confirm(profileId, {
        contact,
        cv,
        source_analysis_id: review.source_analysis_id,
      });
      onSaved(next);
    } catch (error) {
      if (error instanceof ApiError && Object.keys(error.fieldErrors).length > 0) {
        setErrors(formErrors(error.fieldErrors));
        setMessage('Some details need attention. Check the highlighted fields.');
      } else {
        setMessage(`Couldn't save. ${describeError(error)}`);
      }
      setSaving(false);
    }
  }

  const nothingToReview = review.contact_fields.length === 0 && review.sections.length === 0;

  if (phase === 'choose') {
    return (
      <section className="step-card">
        <h3>{isUpdate ? 'Update your details from this resume?' : 'Fill in your details'}</h3>
        {message && (
          <p className="notice error" role="alert">
            {message}
          </p>
        )}
        {resume?.has_text ? (
          <>
            <p className="hint">
              Job Fellow can suggest your details from <strong>{resume.original_filename}</strong>. Its text (not
              the file) is sent to <strong>Google Gemini</strong>, an external AI service. You review every
              suggestion before anything is saved.
            </p>
            <div className="actions">
              <button type="button" className="btn primary" onClick={() => void suggestWithAI()}>
                Suggest with AI
              </button>
              <button type="button" className="btn" onClick={() => setPhase('form')}>
                Fill in manually
              </button>
              {onCancel && (
                <button type="button" className="btn" onClick={onCancel}>
                  Not now
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <p className="hint">This resume has no readable text (it may be scanned), so please fill in your details yourself.</p>
            <div className="actions">
              <button type="button" className="btn primary" onClick={() => setPhase('form')}>
                Fill in details
              </button>
            </div>
          </>
        )}
      </section>
    );
  }

  if (phase === 'analyzing') {
    return (
      <div className="step-card analyzing" role="status">
        <span className="spinner" aria-hidden="true" />
        <span>Reading your resume with AI… this can take up to a minute. Keep this popup open.</span>
      </div>
    );
  }

  return (
    <section className="step-card review">
      <h3>{isUpdate ? 'New details from your resume' : 'Review your details'}</h3>
      <p className="hint">
        {review.source_analysis_id
          ? "AI suggestions aren't saved until you confirm. Correct anything that's wrong and remove anything that isn't yours."
          : "Add what's missing. You can change any of it later."}{' '}
        Only missing or unconfirmed details are shown.
      </p>
      {message && (
        <p className="notice error" role="alert">
          {message}
        </p>
      )}
      {review.warnings.length > 0 && (
        <div className="notice warn" role="note">
          <div>
            <strong>Please double-check:</strong>
            <ul>
              {review.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {nothingToReview ? (
        <p className="hint">Everything in this resume is already in your details.</p>
      ) : (
        <DetailsForm
          fields={review.contact_fields}
          values={values}
          onValuesChange={setValues}
          sections={review.sections}
          cv={cv}
          onCvChange={setCv}
          errors={errors}
          disabled={saving}
        />
      )}
      <div className="form-footer">
        <button type="button" className="btn primary" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : nothingToReview ? 'Done' : 'Save details'}
        </button>
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel} disabled={saving}>
            Not now
          </button>
        )}
      </div>
    </section>
  );
}
