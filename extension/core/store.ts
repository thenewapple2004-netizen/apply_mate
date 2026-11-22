/**
 * Where everything is kept. In the extension this is chrome.storage.local (see
 * lib/chrome-store.ts); tests use MemoryStore. Values must be JSON-serializable.
 *
 * Key layout (all prefixed "jf:"):
 *   jf:profiles                  every profile
 *   jf:settings                  AI settings (including the Gemini key)
 *   jf:p:<profileId>:<name>      one profile's resumes, cv, analysis, prefs, answers, cache, apps
 */
export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(keys: string[]): Promise<void>;
  keys(prefix?: string): Promise<string[]>;
  /** Read-modify-write that can't interleave with another update. */
  update<T>(key: string, change: (current: T | undefined) => T): Promise<T>;
}

export const profileKey = (profileId: string, name: string): string => `jf:p:${profileId}:${name}`;
export const PROFILES_KEY = 'jf:profiles';
export const SETTINGS_KEY = 'jf:settings';

export class MemoryStore implements Store {
  private data = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();

  async get<T>(key: string): Promise<T | undefined> {
    const raw = this.data.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, JSON.stringify(value));
  }

  async remove(keys: string[]): Promise<void> {
    for (const key of keys) this.data.delete(key);
  }

  async keys(prefix = ''): Promise<string[]> {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix));
  }

  update<T>(key: string, change: (current: T | undefined) => T): Promise<T> {
    const run = async (): Promise<T> => {
      const next = change(await this.get<T>(key));
      await this.set(key, next);
      return next;
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
