/**
 * The active profile is stored as its ID only, in chrome.storage.local, so it
 * survives the popup closing. No personal details are stored in the browser.
 */
const KEY = 'activeProfileId';

export async function loadActiveProfileId(): Promise<string | null> {
  const stored = await browser.storage.local.get(KEY);
  const value = stored[KEY];
  return typeof value === 'string' ? value : null;
}

export async function saveActiveProfileId(id: string): Promise<void> {
  await browser.storage.local.set({ [KEY]: id });
}

export async function clearActiveProfileId(): Promise<void> {
  await browser.storage.local.remove(KEY);
}
