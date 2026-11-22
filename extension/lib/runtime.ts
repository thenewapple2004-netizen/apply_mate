import type { Ctx } from '../core/ctx.ts';
import { makeAi } from '../core/settings.ts';
import { ChromeStore } from './chrome-store.ts';
import { extractPdfText } from './pdf.ts';

/** The one set of services the popup uses: local storage, the user's own Gemini key, and PDF reading. */
export const store = new ChromeStore();

export const ctx: Ctx = {
  store,
  ai: makeAi(store),
  pdf: extractPdfText,
};
