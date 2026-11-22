import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '@/lib/api.ts';

import {
  clearActiveProfileId,
  loadActiveProfileId,
  saveActiveProfileId,
} from './active-profile.ts';
import { type Profile, type ProfileInput, profilesApi } from './api.ts';
import { ProfileDetails } from './ProfileDetails.tsx';
import { ProfileForm } from './ProfileForm.tsx';

type LoadState = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string };
type Mode = 'view' | 'create' | 'edit' | 'confirm-delete';

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    return error.kind === 'network' ? 'The backend is offline.' : error.message;
  }
  return 'Something went wrong.';
}

export function ProfilePanel() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('view');
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const active = profiles.find((p) => p.id === activeId) ?? null;

  /** Drops everything tied to the current view, so nothing carries over between profiles. */
  const resetTransientState = useCallback(() => {
    setMode('view');
    setNotice(null);
    setActionError(null);
    setDeleting(false);
  }, []);

  const loadProfiles = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoad({ kind: 'loading' });
    try {
      const [list, storedId] = await Promise.all([
        profilesApi.list(controller.signal),
        loadActiveProfileId(),
      ]);
      if (controller.signal.aborted) return;
      setProfiles(list);
      if (storedId && list.some((p) => p.id === storedId)) {
        setActiveId(storedId);
      } else {
        // The remembered profile no longer exists: forget it rather than guess another.
        setActiveId(null);
        if (storedId) await clearActiveProfileId();
      }
      setLoad({ kind: 'ready' });
    } catch (error) {
      if (!controller.signal.aborted) setLoad({ kind: 'error', message: describe(error) });
    }
  }, []);

  useEffect(() => {
    void loadProfiles();
    return () => controllerRef.current?.abort();
  }, [loadProfiles]);

  async function selectProfile(id: string) {
    resetTransientState();
    if (id) {
      setActiveId(id);
      await saveActiveProfileId(id);
    } else {
      setActiveId(null);
      await clearActiveProfileId();
    }
  }

  async function handleCreate(input: ProfileInput) {
    const created = await profilesApi.create(input);
    setProfiles((list) => [...list, created]);
    resetTransientState();
    setNotice(`"${created.full_name}" was created. Select it above to make it active.`);
  }

  async function handleUpdate(input: ProfileInput) {
    if (!active) return;
    const id = active.id;
    try {
      const updated = await profilesApi.update(id, input);
      setProfiles((list) => list.map((p) => (p.id === id ? updated : p)));
      resetTransientState();
      setNotice('Changes saved.');
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        resetTransientState();
        await loadProfiles(); // deleted elsewhere: refresh, which also clears the selection
        return;
      }
      throw error;
    }
  }

  async function handleDelete() {
    if (!active) return;
    const { id, full_name } = active;
    setDeleting(true);
    setActionError(null);
    try {
      await profilesApi.remove(id);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) {
        setActionError(`Couldn't delete the profile. ${describe(error)}`);
        setDeleting(false);
        return;
      }
      // 404: already gone, so finish removing it locally.
    }
    setProfiles((list) => list.filter((p) => p.id !== id));
    setActiveId(null);
    await clearActiveProfileId();
    resetTransientState();
    setNotice(`"${full_name}" was deleted.`);
  }

  return (
    <section className="profiles">
      <div className="profiles-head">
        <label htmlFor="profile-select">Application profile</label>
        {load.kind === 'ready' && mode !== 'create' && (
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              resetTransientState();
              setMode('create');
            }}
          >
            + New profile
          </button>
        )}
      </div>

      {load.kind === 'loading' && <p className="hint">Loading profiles…</p>}

      {load.kind === 'error' && (
        <div className="notice error" role="alert">
          <span>Couldn't load profiles. {load.message}</span>
          <button type="button" className="btn small" onClick={() => void loadProfiles()}>
            Retry
          </button>
        </div>
      )}

      {load.kind === 'ready' && profiles.length === 0 && mode !== 'create' && (
        <div className="empty">
          <p>No profiles yet. Create one to start using ApplyMate.</p>
          <button type="button" className="btn primary" onClick={() => setMode('create')}>
            Create your first profile
          </button>
        </div>
      )}

      {load.kind === 'ready' && profiles.length > 0 && (
        <select
          id="profile-select"
          value={activeId ?? ''}
          onChange={(e) => void selectProfile(e.target.value)}
        >
          <option value="">Select a profile…</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.full_name}
            </option>
          ))}
        </select>
      )}

      {notice && (
        <p className="notice success" role="status">
          {notice}
        </p>
      )}

      {mode === 'create' && (
        <ProfileForm onSubmit={handleCreate} onCancel={resetTransientState} />
      )}

      {/* key={active.id} remounts these per profile, discarding any unsaved
          edits or messages that belonged to the previously selected profile. */}
      {active && mode === 'edit' && (
        <ProfileForm
          key={active.id}
          initial={active}
          onSubmit={handleUpdate}
          onCancel={resetTransientState}
        />
      )}

      {active && mode === 'view' && (
        <ProfileDetails
          key={active.id}
          profile={active}
          onEdit={() => {
            setNotice(null);
            setMode('edit');
          }}
          onDelete={() => {
            setNotice(null);
            setMode('confirm-delete');
          }}
        />
      )}

      {active && mode === 'confirm-delete' && (
        <div className="confirm" role="alertdialog" aria-labelledby="confirm-delete-title">
          <p id="confirm-delete-title">
            Delete <strong>{active.full_name}</strong>? This permanently removes the profile and
            can't be undone.
          </p>
          {actionError && <p className="notice error">{actionError}</p>}
          <div className="actions">
            <button
              type="button"
              className="btn danger-solid"
              onClick={() => void handleDelete()}
              disabled={deleting}
            >
              {deleting ? 'Deleting…' : 'Delete profile'}
            </button>
            <button
              type="button"
              className="btn"
              onClick={resetTransientState}
              disabled={deleting}
              autoFocus
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {load.kind === 'ready' && profiles.length > 0 && !active && mode === 'view' && (
        <p className="hint">No profile selected. Choose one to use it for applications.</p>
      )}
    </section>
  );
}
