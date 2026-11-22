/** AI settings (the user's own Gemini key) and backup of the user's data. */
import type { Ctx } from './ctx.ts';
import { aiNotConfigured, invalid } from './errors.ts';
import { DEFAULT_GEMINI, GeminiClient, type Fetch, type StructuredAi } from './gemini.ts';
import { PROFILES_KEY, SETTINGS_KEY, type Store } from './store.ts';
import { isObject } from './validation.ts';

export interface AiSettings {
  apiKey: string;
  model: string;
  fallbackModel: string;
}

export async function getAiSettings(store: Store): Promise<AiSettings> {
  const saved = await store.get<Partial<AiSettings>>(SETTINGS_KEY);
  return {
    apiKey: typeof saved?.apiKey === 'string' ? saved.apiKey : '',
    model: saved?.model || DEFAULT_GEMINI.model,
    fallbackModel: saved?.fallbackModel ?? DEFAULT_GEMINI.fallbackModel,
  };
}

export async function saveAiSettings(store: Store, change: Partial<AiSettings>): Promise<AiSettings> {
  const next = { ...(await getAiSettings(store)), ...change };
  next.apiKey = next.apiKey.trim();
  if (/\s/.test(next.apiKey)) throw invalid('That doesn’t look like an API key: it contains spaces.');
  await store.set(SETTINGS_KEY, next);
  return next;
}

/** A provider that reads the key at call time, so a newly pasted key works immediately. */
export function makeAi(store: Store, fetchImpl?: Fetch): () => Promise<StructuredAi> {
  return async () => {
    const settings = await getAiSettings(store);
    if (!settings.apiKey) throw aiNotConfigured();
    return new GeminiClient({ ...DEFAULT_GEMINI, ...settings }, { fetch: fetchImpl });
  };
}

/** A tiny request to check the key works. */
export async function testAi(ctx: Ctx): Promise<{ model: string }> {
  const ai = await ctx.ai();
  const result = await ai.generate({
    system: 'Reply with the JSON {"ok": true}.',
    prompt: 'ping',
    schema: { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } } },
    parse: (json) => json,
  });
  return { model: result.model };
}

// ---- backup ----

const BACKUP_VERSION = 1;
const isDataKey = (key: string): boolean => key.startsWith('jf:') && key !== SETTINGS_KEY;

export interface Backup {
  app: 'job-fellow';
  version: number;
  exported_at: string;
  data: Record<string, unknown>;
}

/** Everything the user saved, except the API key. */
export async function exportBackup(store: Store): Promise<Backup> {
  const data: Record<string, unknown> = {};
  for (const key of await store.keys('jf:')) if (isDataKey(key)) data[key] = await store.get(key);
  return { app: 'job-fellow', version: BACKUP_VERSION, exported_at: new Date().toISOString(), data };
}

/** Replaces the saved data with a backup. The API key is left alone. */
export async function importBackup(store: Store, backup: unknown): Promise<{ profiles: number }> {
  if (!isObject(backup) || backup.app !== 'job-fellow' || !isObject(backup.data)) {
    throw invalid('That file isn’t a Job Fellow backup.');
  }
  const entries = Object.entries(backup.data);
  if (entries.some(([key]) => !isDataKey(key))) throw invalid('That backup contains unexpected data.');
  await deleteAllData(store);
  for (const [key, value] of entries) await store.set(key, value);
  const profiles = backup.data[PROFILES_KEY];
  return { profiles: Array.isArray(profiles) ? profiles.length : 0 };
}

/** Removes everything the user saved (profiles, resumes, answers...). The API key stays. */
export async function deleteAllData(store: Store): Promise<void> {
  await store.remove((await store.keys('jf:')).filter(isDataKey));
}
