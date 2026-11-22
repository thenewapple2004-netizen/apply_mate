import type { Store } from '../core/store.ts';

/** The extension's storage: chrome.storage.local, which stays on this computer. */
export class ChromeStore implements Store {
  private queue: Promise<unknown> = Promise.resolve();

  async get<T>(key: string): Promise<T | undefined> {
    const found = await browser.storage.local.get(key);
    return found[key] as T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    await browser.storage.local.set({ [key]: value });
  }

  async remove(keys: string[]): Promise<void> {
    if (keys.length) await browser.storage.local.remove(keys);
  }

  async keys(prefix = ''): Promise<string[]> {
    const all = await browser.storage.local.get(null);
    return Object.keys(all).filter((k) => k.startsWith(prefix));
  }

  /** Changes made through this method never interleave, so two quick saves can't overwrite each other. */
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
