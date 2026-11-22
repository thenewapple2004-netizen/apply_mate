import { useCallback, useEffect, useRef, useState } from 'react';

import { MODEL_CHOICES } from '../core/gemini.ts';
import {
  type AiSettings as Settings, deleteAllData, exportBackup, getAiSettings, importBackup, saveAiSettings, testAi,
} from '../core/settings.ts';
import { describeError } from '@/lib/api.ts';
import { ctx, store } from '@/lib/runtime.ts';

type Message = { kind: 'success' | 'error'; text: string } | null;

const KEY_URL = 'https://aistudio.google.com/apikey';

/** Where the user pastes their own free Gemini key, and manages the data kept in this browser. */
export function AiSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [open, setOpen] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const s = await getAiSettings(store);
    setSettings(s);
    setOpen((was) => was || !s.apiKey);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (work: () => Promise<string | void>) => {
    setBusy(true);
    setMessage(null);
    try {
      const text = await work();
      if (text) setMessage({ kind: 'success', text });
    } catch (error) {
      setMessage({ kind: 'error', text: describeError(error) });
    } finally {
      setBusy(false);
    }
  };

  const hasKey = Boolean(settings?.apiKey);

  const saveKey = () =>
    run(async () => {
      setSettings(await saveAiSettings(store, { apiKey: key }));
      setKey('');
      return 'Key saved. Use “Test” to check it works.';
    });

  const test = () =>
    run(async () => {
      const { model } = await testAi(ctx);
      return `AI is working (${model}).`;
    });

  const changeModel = (model: string) =>
    run(async () => {
      setSettings(await saveAiSettings(store, { model }));
    });

  const removeKey = () =>
    run(async () => {
      setSettings(await saveAiSettings(store, { apiKey: '' }));
      return 'Key removed.';
    });

  const download = () =>
    run(async () => {
      const backup = await exportBackup(store);
      const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `job-fellow-backup-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      return 'Backup saved. It does not include your API key.';
    });

  const restore = (file: File | undefined) =>
    run(async () => {
      if (!file) return;
      const { profiles } = await importBackup(store, JSON.parse(await file.text()));
      return `Backup restored (${profiles} profile${profiles === 1 ? '' : 's'}). Reopen Job Fellow to see it.`;
    }).finally(() => {
      if (importRef.current) importRef.current.value = '';
    });

  const wipe = () => {
    if (!window.confirm('Delete all profiles, resumes and answers from this browser? This cannot be undone.')) return;
    void run(async () => {
      await deleteAllData(store);
      return 'All data deleted. Reopen Job Fellow to start again.';
    });
  };

  return (
    <section className="connection" aria-live="polite">
      <div className="connection-row">
        <span className={`connection-dot ${hasKey ? 'connected' : 'offline'}`} aria-hidden="true" />
        <span className="connection-label">{hasKey ? 'AI ready' : 'Add your free Gemini key'}</span>
        <button type="button" className="retry" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'AI & data'}
        </button>
      </div>

      {open && settings && (
        <div className="ai-settings">
          <div className="field">
            <label htmlFor="gemini-key">Gemini API key {hasKey && <span className="hint">(saved)</span>}</label>
            <input
              id="gemini-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={hasKey ? '•••••••• (paste a new key to replace)' : 'Paste your key'}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <p className="hint">
              It’s free:{' '}
              <a href={KEY_URL} target="_blank" rel="noreferrer">
                get a key from Google AI Studio
              </a>
              . The key stays on this computer and is sent only to Google. The text of your resume and the job you’re
              applying to are sent to Gemini when you use AI.
            </p>
          </div>
          <div className="secondary-actions">
            <button type="button" className="btn primary small" disabled={busy || !key.trim()} onClick={() => void saveKey()}>
              Save key
            </button>
            <button type="button" className="btn small" disabled={busy || !hasKey} onClick={() => void test()}>
              Test
            </button>
            {hasKey && (
              <button type="button" className="link-btn" disabled={busy} onClick={() => void removeKey()}>
                Remove key
              </button>
            )}
          </div>

          <div className="field">
            <label htmlFor="gemini-model">Model</label>
            <select id="gemini-model" value={settings.model} disabled={busy} onChange={(e) => void changeModel(e.target.value)}>
              {[...new Set([settings.model, ...MODEL_CHOICES])].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <p className="hint">If a model’s free daily limit is used up, pick another one.</p>
          </div>

          <div className="secondary-actions">
            <button type="button" className="btn small" disabled={busy} onClick={() => void download()}>
              Export backup
            </button>
            <button type="button" className="btn small" disabled={busy} onClick={() => importRef.current?.click()}>
              Import backup
            </button>
            <button type="button" className="danger-link" disabled={busy} onClick={wipe}>
              Delete all my data
            </button>
            <input
              ref={importRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => void restore(e.target.files?.[0])}
            />
          </div>
        </div>
      )}

      {message && <p className={`notice ${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>{message.text}</p>}
    </section>
  );
}
