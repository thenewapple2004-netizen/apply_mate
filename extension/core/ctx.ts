import type { StructuredAi } from './gemini.ts';
import type { Store } from './store.ts';

/** Reads the text of a PDF (implemented in the browser with pdf.js; see lib/pdf.ts). */
export type PdfTextExtractor = (bytes: Uint8Array) => Promise<string[]>;

/** Everything the logic in core/ needs from its surroundings. */
export interface Ctx {
  store: Store;
  /** The AI provider, or a clear error if no key is set up. */
  ai: () => Promise<StructuredAi>;
  pdf?: PdfTextExtractor;
}
