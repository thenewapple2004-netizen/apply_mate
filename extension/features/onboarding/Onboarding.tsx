import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, describeError } from '../../lib/api.ts';
import { clearActiveProfileId, loadActiveProfileId, saveActiveProfileId } from '../profiles/active-profile.ts';
import { type Profile, profilesApi } from '../profiles/api.ts';

import { ApplyPanel } from '../apply/ApplyPanel.tsx';
import { forgetProfile } from '../apply/storage.ts';

import { type OnboardingState, onboardingApi } from './api.ts';
import { EditDetails } from './EditDetails.tsx';
import { ResumeUpload } from './ResumeUpload.tsx';
import { ReviewStep } from './ReviewStep.tsx';
import { Summary } from './Summary.tsx';

type Load<T> = { kind: 'loading' } | { kind: 'ready'; value: T } | { kind: 'error'; message: string };
/** Secondary views for a profile that has finished onboarding. */
type Extra = 'none' | 'edit' | 'replace' | 'review';

export function Onboarding() {
  const [profiles, setProfiles] = useState<Load<Profile[]>>({ kind: 'loading' });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadProfiles = useCallback(async (signal?: AbortSignal) => {
    setProfiles({ kind: 'loading' });
    try {
      const [list, storedId] = await Promise.all([profilesApi.list(signal), loadActiveProfileId()]);
      if (signal?.aborted) return;
      setProfiles({ kind: 'ready', value: list });
      if (storedId && list.some((p) => p.id === storedId)) {
        setActiveId(storedId);
      } else {
        // Remembered profile is gone: don't guess another one.
        setActiveId(null);
        if (storedId) await clearActiveProfileId();
        setCreating(list.length === 0);
      }
    } catch (error) {
      if (signal?.aborted) return;
      if (!(error instanceof ApiError)) console.error('Loading profiles failed:', error);
      setProfiles({ kind: 'error', message: describeError(error) });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadProfiles(controller.signal);
    return () => controller.abort();
  }, [loadProfiles]);

  async function select(id: string | null) {
    setNotice(null);
    setCreating(false);
    setActiveId(id);
    if (id) await saveActiveProfileId(id);
    else await clearActiveProfileId();
  }

  async function create(name: string) {
    const profile = await profilesApi.create({ full_name: name, email: null, phone: null, location: null, linkedin_url: null });
    setProfiles((p) => (p.kind === 'ready' ? { kind: 'ready', value: [...p.value, profile] } : p));
    await select(profile.id);
  }

  async function removeActive() {
    if (!activeId) return;
    const removed = profiles.kind === 'ready' ? profiles.value.find((p) => p.id === activeId) : undefined;
    await profilesApi.remove(activeId).catch((error) => {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    });
    await forgetProfile(activeId); // its job and prepared answers stored in this browser
    setProfiles((p) => (p.kind === 'ready' ? { kind: 'ready', value: p.value.filter((x) => x.id !== activeId) } : p));
    await select(null);
    setNotice(`"${removed?.full_name ?? 'Profile'}" was deleted.`);
  }

  if (profiles.kind === 'loading') return <p className="hint">Loading…</p>;
  if (profiles.kind === 'error') {
    return (
      <div className="notice error" role="alert">
        <span>Couldn't load profiles. {profiles.message}</span>
        <button type="button" className="btn small" onClick={() => void loadProfiles()}>
          Retry
        </button>
      </div>
    );
  }

  const list = profiles.value;
  return (
    <div className="onboarding">
      <section className="profiles">
        <div className="profiles-head">
          <label htmlFor="profile-select">Applicant profile</label>
          {!creating && (
            <button type="button" className="link-btn" onClick={() => setCreating(true)}>
              + New profile
            </button>
          )}
        </div>
        {creating ? (
          <NewProfile onCreate={create} onCancel={list.length > 0 ? () => setCreating(false) : undefined} />
        ) : (
          <select id="profile-select" value={activeId ?? ''} onChange={(e) => void select(e.target.value || null)}>
            <option value="">Select a profile…</option>
            {list.map((p) => (
              <option key={p.id} value={p.id}>
                {p.full_name}
              </option>
            ))}
          </select>
        )}
      </section>

      {notice && (
        <p className="notice success" role="status">
          {notice}
        </p>
      )}

      {!activeId && !creating && (
        <>
          <Steps current={1} />
          <p className="hint">Choose a profile above, or create one to get started.</p>
        </>
      )}

      {/* Keyed by profile: switching profiles discards everything shown for the previous one. */}
      {activeId && <ProfileFlow key={activeId} profileId={activeId} onDelete={removeActive} />}
    </div>
  );
}

function ProfileFlow({ profileId, onDelete }: { profileId: string; onDelete: () => Promise<void> }) {
  const [state, setState] = useState<Load<OnboardingState>>({ kind: 'loading' });
  const [extra, setExtra] = useState<Extra>('none');
  const [message, setMessage] = useState<string | null>(null);
  const lifetime = useRef(new AbortController());

  const refresh = useCallback(async () => {
    const { signal } = lifetime.current;
    try {
      const next = await onboardingApi.get(profileId, signal);
      if (!signal.aborted) setState({ kind: 'ready', value: next });
    } catch (error) {
      if (!signal.aborted) setState({ kind: 'error', message: describeError(error) });
    }
  }, [profileId]);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    void refresh();
    return () => controller.abort();
  }, [refresh]);

  if (state.kind === 'loading') return <p className="hint">Loading profile…</p>;
  if (state.kind === 'error') {
    return (
      <div className="notice error" role="alert">
        <span>Couldn't load this profile. {state.message}</span>
        <button type="button" className="btn small" onClick={() => { setState({ kind: 'loading' }); void refresh(); }}>
          Retry
        </button>
      </div>
    );
  }

  const s = state.value;
  const done = (next: OnboardingState, text?: string) => {
    setState({ kind: 'ready', value: next });
    setExtra('none');
    setMessage(text ?? null);
  };

  if (s.step === 'resume') {
    return (
      <>
        <Steps current={2} />
        <ResumeUpload
          profileId={profileId}
          title="Add your resume"
          hint="Upload a PDF or DOCX file (up to 10 MB)."
          onUploaded={() => void refresh()}
        />
      </>
    );
  }

  if (s.step === 'review' && s.review) {
    return (
      <>
        <Steps current={3} />
        <ReviewStep state={{ ...s, review: s.review }} onSaved={(next) => done(next, "You're all set. Your details are saved.")} />
      </>
    );
  }

  // Onboarding complete: summary plus secondary actions.
  if (extra === 'edit') {
    return <EditDetails state={s} onSaved={(next) => done(next, 'Changes saved.')} onCancel={() => setExtra('none')} />;
  }
  if (extra === 'replace') {
    return (
      <ResumeUpload
        profileId={profileId}
        title="Replace resume"
        hint="The new file becomes the resume Job Fellow uses. Your saved details stay as they are."
        onUploaded={() => {
          setExtra('none');
          setMessage('Resume replaced. Use "Update from resume" to add any new details from it.');
          void refresh();
        }}
        onCancel={() => setExtra('none')}
      />
    );
  }
  if (extra === 'review') {
    const review = s.review ?? {
      contact_fields: [], contact: {}, sections: [], cv: s.cv!, source_analysis_id: null, warnings: [],
    };
    return (
      <ReviewStep
        state={{ ...s, review }}
        onSaved={(next) => done(next, 'Details updated.')}
        onCancel={() => setExtra('none')}
      />
    );
  }

  return (
    <>
      {message && (
        <p className="notice success" role="status">
          {message}
        </p>
      )}
      <ApplyPanel profileId={profileId} />
      <details className="profile-details" open={Boolean(message) || s.analysis?.status === 'draft'}>
        <summary>Profile &amp; resume</summary>
        <Summary
          state={s}
          onEdit={() => { setMessage(null); setExtra('edit'); }}
          onReplace={() => { setMessage(null); setExtra('replace'); }}
          onReview={() => { setMessage(null); setExtra('review'); }}
          onDeleteProfile={onDelete}
        />
      </details>
    </>
  );
}

function NewProfile({ onCreate, onCancel }: { onCreate: (name: string) => Promise<void>; onCancel?: () => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setError('Enter the applicant’s full name.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCreate(name.trim());
    } catch (err) {
      setError(err instanceof ApiError && err.fieldErrors.full_name ? err.fieldErrors.full_name : describeError(err));
      setBusy(false);
    }
  }

  return (
    <form className="new-profile" onSubmit={submit} noValidate>
      <input
        id="new-profile-name"
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Full name"
        aria-label="Full name"
        aria-invalid={Boolean(error)}
        autoFocus
        disabled={busy}
      />
      <div className="actions">
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? 'Creating…' : 'Create profile'}
        </button>
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
      </div>
      {error && <p className="field-error">{error}</p>}
    </form>
  );
}

function Steps({ current }: { current: 1 | 2 | 3 }) {
  const steps = ['Profile', 'Resume', 'Details'];
  return (
    <ol className="steps" aria-label="Setup progress">
      {steps.map((label, i) => (
        <li key={label} className={i + 1 < current ? 'done' : i + 1 === current ? 'current' : undefined} aria-current={i + 1 === current ? 'step' : undefined}>
          {label}
        </li>
      ))}
    </ol>
  );
}
