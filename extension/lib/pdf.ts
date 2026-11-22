import type { PdfTextExtractor } from '../core/ctx.ts';

/**
 * Reads the text of a PDF in the browser (no server). pdf.js is loaded only when a PDF is
 * actually uploaded, so the popup opens fast.
 */
export const extractPdfText: PdfTextExtractor = async (bytes) => {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;

  const task = pdfjs.getDocument({
    data: bytes.slice(), // pdf.js takes ownership of the buffer
    useSystemFonts: true,
    disableFontFace: true,
  });
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if ('str' in item) text += item.str + (item.hasEOL ? '\n' : item.str.endsWith(' ') ? '' : ' ');
      }
      pages.push(text);
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
};
