import { zipSync, strToU8 } from 'fflate';
import type { Ctx } from '../core/ctx.ts';
import type { AiRequest, StructuredAi } from '../core/gemini.ts';
import { MemoryStore } from '../core/store.ts';

/** An AI stand-in: replies are queued, and every request is recorded. */
export class FakeAi implements StructuredAi {
  requests: AiRequest<unknown>[] = [];
  replies: (unknown | Error)[] = [];
  async generate<T>(request: AiRequest<T>): Promise<{ data: T; model: string }> {
    this.requests.push(request as AiRequest<unknown>);
    const reply = this.replies.shift();
    if (reply instanceof Error) throw reply;
    return { data: request.parse(reply), model: 'fake-model' };
  }
}

export function makeCtx(): { ctx: Ctx; ai: FakeAi; store: MemoryStore } {
  const ai = new FakeAi();
  const store = new MemoryStore();
  const ctx: Ctx = {
    store,
    ai: async () => ai,
    pdf: async (bytes) => {
      const text = new TextDecoder('latin1').decode(bytes);
      if (text.includes('ENCRYPTED')) throw Object.assign(new Error('password'), { name: 'PasswordException' });
      if (text.includes('BROKEN')) throw new Error('broken');
      return [text.replace(/^%PDF-[\d.]+\n/, '')];
    },
  };
  return { ctx, ai, store };
}

export const pdfBytes = (text: string): Uint8Array => new TextEncoder().encode(`%PDF-1.4\n${text}`);

export function docxBytes(paragraphs: string[]): Uint8Array {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('');
  return zipSync({
    '[Content_Types].xml': strToU8(
      '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    'word/document.xml': strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    ),
  });
}

export const RESUME_TEXT = [
  'Ada Lovelace',
  'ada@example.com +44 20 7946 0958 https://www.linkedin.com/in/adalovelace',
  'London, UK',
  'Software Engineer at Analytical Engines Ltd, Jan 2020 - Present',
  'Built TypeScript and Python services.',
  'BSc Mathematics, University of London',
].join('\n');

export const AI_CV = {
  contact: { full_name: 'Ada Lovelace', email: 'ada@example.com', phone: '+44 20 7946 0958', location: 'London, UK', linkedin_url: 'linkedin.com/in/adalovelace' },
  summary: null,
  skills: ['Teamwork', null],
  technologies: ['TypeScript', 'Python'],
  work_experience: [
    { company: 'Analytical Engines Ltd', title: 'Software Engineer', start_date: 'Jan 2020', end_date: 'Present', is_current: true, responsibilities: ['Built TypeScript and Python services.'] },
  ],
  education: [{ institution: 'University of London', degree: 'BSc', field_of_study: 'Mathematics' }],
  projects: null,
  certifications: [],
};
