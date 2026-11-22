/**
 * Access to the page the user is looking at. Uses `activeTab` (granted when the
 * user opens the Job Fellow popup on a tab) plus `scripting`, so the extension
 * never needs access to all websites.
 */

export interface CurrentTab {
  id: number;
  url: string;
}

export class PageAccessError extends Error {}

export async function getCurrentTab(): Promise<CurrentTab> {
  // `?tab=<id>` lets automated tests point the popup at a specific tab.
  const forced = Number(new URLSearchParams(location.search).get('tab'));
  const tab = forced
    ? await browser.tabs.get(forced)
    : (await browser.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab?.id) throw new PageAccessError('No open page found.');
  return { id: tab.id, url: tab.url ?? '' };
}

/** Runs one of the functions from page-scripts.ts in the tab and returns its result. */
export async function runInPage<Args extends unknown[], Result>(
  tabId: number,
  func: (...args: Args) => Result,
  ...args: Args
): Promise<Result> {
  if (!browser.scripting?.executeScript) {
    // The popup files are newer than the manifest Chrome has loaded.
    throw new PageAccessError(
      'Job Fellow needs to be reloaded to get page access. Open chrome://extensions and click the reload icon on Job Fellow.',
    );
  }
  try {
    const [injection] = await browser.scripting.executeScript({ target: { tabId }, func, args });
    if (!injection) throw new Error('The page returned no result.');
    return injection.result as Result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/cannot access|cannot be scripted|extensions gallery|chrome:\/\//i.test(message)) {
      throw new PageAccessError("Job Fellow can't read this page (browser and store pages are protected).");
    }
    if (/permission|host/i.test(message)) {
      throw new PageAccessError('Job Fellow needs to be opened on this page first. Click the Job Fellow icon while viewing it.');
    }
    throw new PageAccessError(`Couldn't read this page. ${message}`);
  }
}
