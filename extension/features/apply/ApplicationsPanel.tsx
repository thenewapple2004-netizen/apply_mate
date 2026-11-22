import { useCallback, useEffect, useRef, useState } from 'react';

import { describeError } from '../../lib/api.ts';

import { type ApplicationStats, applyApi, type JobApplication } from './api.ts';

interface Props {
  profileId: string;
  /** Changes when something was recorded or removed, to reload the numbers. */
  version: number;
}

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** Jobs applied to: a one-line summary that opens into the recent history. */
export function ApplicationsPanel({ profileId, version }: Props) {
  const [stats, setStats] = useState<ApplicationStats | null>(null);
  const [items, setItems] = useState<JobApplication[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const alive = useRef(new AbortController());

  const load = useCallback(async () => {
    const { signal } = alive.current;
    try {
      const [s, list] = await Promise.all([
        applyApi.applicationStats(profileId, signal),
        applyApi.listApplications(profileId, signal),
      ]);
      if (signal.aborted) return;
      setStats(s);
      setItems(list);
      setError(null);
    } catch (e) {
      if (!signal.aborted) setError(describeError(e));
    }
  }, [profileId]);

  useEffect(() => {
    const controller = new AbortController();
    alive.current = controller;
    void load();
    return () => controller.abort();
  }, [load, version]);

  async function remove(item: JobApplication) {
    try {
      await applyApi.removeApplication(profileId, item.id);
      setConfirmId(null);
      await load();
    } catch (e) {
      setError(`Couldn't remove it. ${describeError(e)}`);
    }
  }

  if (error && !stats) return <p className="hint">Couldn't load your applications. {error}</p>;
  if (!stats) return null;

  return (
    <details className="applications">
      <summary>
        <span className="stat-total">
          <strong>{stats.total}</strong> {stats.total === 1 ? 'job' : 'jobs'} applied
        </span>
        <span className="stat-detail">
          {stats.today} today · {stats.last_7_days} in 7 days
        </span>
      </summary>

      {error && <p className="notice error">{error}</p>}
      {items.length === 0 ? (
        <p className="hint">Nothing yet. After you submit an application, click “Mark as applied” to track it here.</p>
      ) : (
        <ul className="history">
          {items.map((item) => (
            <li key={item.id}>
              <span className="tick" aria-hidden="true">✓</span>
              <div className="history-text">
                <span className="history-title">{item.title || 'Untitled job'}</span>
                <span className="meta">
                  {[item.company, day(item.applied_at)].filter(Boolean).join(' · ')}
                  {item.url && /^https?:\/\//.test(item.url) && (
                    <>
                      {' · '}
                      <a href={item.url} target="_blank" rel="noopener noreferrer">
                        Open
                      </a>
                    </>
                  )}
                </span>
              </div>
              {confirmId === item.id ? (
                <span className="history-confirm">
                  <button type="button" className="link-btn danger-link" onClick={() => void remove(item)}>
                    Remove
                  </button>
                  <button type="button" className="link-btn" onClick={() => setConfirmId(null)}>
                    Keep
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="link-btn history-x"
                  onClick={() => setConfirmId(item.id)}
                  aria-label={`Remove ${item.title || 'this job'} from the list`}
                  title="Remove from the list"
                >
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {stats.total > items.length && <p className="hint">Showing the latest {items.length} of {stats.total}.</p>}
    </details>
  );
}
