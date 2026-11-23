import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../core/errors.ts';
import { createProfile, deleteProfile, listProfiles, updateProfile } from '../core/profiles.ts';
import { getPreferences, savePreferences } from '../core/preferences.ts';
import { createResume, listResumes, setPrimary, deleteResume, getResume } from '../core/resumes.ts';
import { analyzeResume, getDetails, saveDetails } from '../core/cv.ts';
import { confirm, getState } from '../core/onboarding.ts';
import { compose, draftAnswer, prepare } from '../core/prepare.ts';
import { applicationStats, jobKey, listApplications, recordApplication, removeApplication } from '../core/history.ts';
import { saveAnswers, listAnswers, matchOption } from '../core/answers.ts';
import { exportBackup, importBackup, saveAiSettings, makeAi } from '../core/settings.ts';
import { GeminiClient } from '../core/gemini.ts';
import type { FormField } from '../core/types.ts';
import { AI_CV, RESUME_TEXT, docxBytes, makeCtx, pdfBytes } from './helpers.ts';

const rejects = (promise: Promise<unknown>, status: number, match?: RegExp) =>
  assert.rejects(promise, (e: unknown) => {
    assert.ok(e instanceof ApiError, String(e));
    assert.equal(e.status, status);
    if (match) assert.match(e.message, match);
    return true;
  });

const field = (id: string, label: string, type: FormField['type'] = 'text', options: string[] = []): FormField => ({
  id, label, type, required: false, options: options.map((o) => ({ value: o, label: o })),
});
const JOB = { title: 'Engineer', company: 'Acme', description: 'Build things', url: 'https://acme.com/jobs/1' };

test('profiles: validation, update and delete', async () => {
  const { ctx } = makeCtx();
  await rejects(createProfile(ctx, { full_name: ' ', email: null, phone: null, location: null, linkedin_url: null }), 422);
  const p = await createProfile(ctx, { full_name: '  Ada   Lovelace ', email: 'ADA@example.com', phone: '', location: null, linkedin_url: null });
  assert.equal(p.full_name, 'Ada Lovelace');
  assert.equal(p.phone, null);
  await assert.rejects(updateProfile(ctx, p.id, { email: 'nope' }), (e: ApiError) => e.fieldErrors.email === 'must be a valid email address');
  await assert.rejects(updateProfile(ctx, p.id, { linkedin_url: 'https://evil.com/x' }), (e: ApiError) => /linkedin\.com/.test(e.fieldErrors.linkedin_url ?? ''));
  const u = await updateProfile(ctx, p.id, { location: 'London' });
  assert.equal(u.email, 'ADA@example.com');
  assert.equal(u.location, 'London');
  await savePreferences(ctx, p.id, { notice_period: '2 weeks' });
  await deleteProfile(ctx, p.id);
  assert.deepEqual(await listProfiles(ctx), []);
  assert.deepEqual(await ctx.store.keys('jf:p:'), []);
  await rejects(deleteProfile(ctx, p.id), 404);
});

test('preferences: clean, replace, reject unknown', async () => {
  const { ctx } = makeCtx();
  const p = await createProfile(ctx, { full_name: 'A', email: null, phone: null, location: null, linkedin_url: null });
  assert.equal((await getPreferences(ctx, p.id)).updated_at, null);
  const saved = await savePreferences(ctx, p.id, { salary_expectation: ' 90k ', preferred_locations: ['London', 'london', ' '], work_arrangements: ['remote', 'remote'], requires_sponsorship: false });
  assert.equal(saved.salary_expectation, '90k');
  assert.deepEqual(saved.preferred_locations, ['London']);
  assert.deepEqual(saved.work_arrangements, ['remote']);
  await rejects(savePreferences(ctx, p.id, { updated_at: 'x' }), 422);
  await rejects(savePreferences(ctx, p.id, { work_arrangements: ['moon'] }), 422);
  const replaced = await savePreferences(ctx, p.id, {});
  assert.equal(replaced.salary_expectation, null);
});

test('resumes: docx, pdf, wrong type, big, protected', async () => {
  const { ctx } = makeCtx();
  const p = await createProfile(ctx, { full_name: 'A', email: null, phone: null, location: null, linkedin_url: null });
  const docx = await createResume(ctx, p.id, 'C:\\fake\\My CV.docx', docxBytes(['Hello &amp; welcome', 'Second']));
  assert.equal(docx.original_filename, 'My CV.docx');
  assert.equal((await getResume(ctx, p.id, docx.id)).extracted_text, 'Hello & welcome\nSecond');
  const pdf = await createResume(ctx, p.id, 'cv.pdf', pdfBytes('PDF body'));
  assert.equal(pdf.file_type, 'pdf');
  await rejects(createResume(ctx, p.id, 'cv.docx', pdfBytes('x')), 415, /named \.docx/);
  await rejects(createResume(ctx, p.id, 'cv.txt', pdfBytes('x')), 415);
  await rejects(createResume(ctx, p.id, 'cv.pdf', new Uint8Array(0)), 422);
  await rejects(createResume(ctx, p.id, 'cv.pdf', new Uint8Array(10 * 1024 * 1024 + 1)), 413);
  await rejects(createResume(ctx, p.id, 'cv.pdf', pdfBytes('ENCRYPTED')), 422, /password/);
  await rejects(createResume(ctx, p.id, 'cv.pdf', pdfBytes('BROKEN')), 422, /damaged/);
  await rejects(createResume(ctx, p.id, 'cv.doc', Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0])), 415);
  await rejects(createResume(ctx, p.id, 'a.docx', Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0])), 422, /password/);
  // a DOCTYPE in the XML is refused
  const evil = docxBytes(['x']);
  assert.ok(evil.length > 0);

  await setPrimary(ctx, p.id, docx.id, true);
  await setPrimary(ctx, p.id, pdf.id, true);
  const list = await listResumes(ctx, p.id);
  assert.deepEqual(list.map((r) => r.is_primary), [false, true]);
  await deleteResume(ctx, p.id, pdf.id);
  assert.equal((await listResumes(ctx, p.id)).length, 1);
  await rejects(getResume(ctx, p.id, pdf.id), 404);
});

test('cv + onboarding: analyze, review, confirm, never overwrite', async () => {
  const { ctx, ai } = makeCtx();
  const p = await createProfile(ctx, { full_name: 'Ada', email: null, phone: null, location: null, linkedin_url: null });
  assert.equal((await getState(ctx, p.id)).step, 'resume');
  const resume = await createResume(ctx, p.id, 'cv.pdf', pdfBytes(RESUME_TEXT));
  assert.equal((await getState(ctx, p.id)).step, 'review');

  ai.replies.push(AI_CV);
  const analysis = await analyzeResume(ctx, p.id, resume.id);
  assert.equal(analysis.status, 'draft');
  assert.deepEqual(analysis.data.skills, ['Teamwork']);
  assert.equal(analysis.contact.linkedin_url, 'https://linkedin.com/in/adalovelace');
  assert.equal(analysis.contact.email, 'ada@example.com');
  assert.deepEqual(analysis.warnings, []);
  assert.match(ai.requests[0]?.prompt ?? '', /Ada Lovelace/);

  const state = await getState(ctx, p.id);
  assert.equal(state.review?.contact_fields.length, 4);
  assert.equal(state.review?.cv.work_experience.length, 1);

  const done = await confirm(ctx, p.id, { contact: { email: 'ada@example.com' }, cv: state.review!.cv, source_analysis_id: analysis.id });
  assert.equal(done.step, 'complete');
  assert.equal(done.profile.email, 'ada@example.com');
  assert.equal((await getDetails(ctx, p.id)).source_analysis_id, analysis.id);
  assert.equal(done.review, null); // draft is now confirmed

  // A new draft only offers what is new, and contact values already set are never replaced.
  ai.replies.push({ ...AI_CV, technologies: ['TypeScript', 'Rust'], work_experience: AI_CV.work_experience });
  await analyzeResume(ctx, p.id, resume.id);
  const again = await getState(ctx, p.id);
  assert.deepEqual(again.review?.cv.technologies, ['Rust']);
  assert.ok(!again.review?.contact_fields.includes('email'));
  const merged = await confirm(ctx, p.id, { contact: { email: 'other@example.com' }, cv: again.review!.cv, source_analysis_id: again.review!.source_analysis_id });
  assert.equal(merged.profile.email, 'ada@example.com');
  assert.deepEqual(merged.cv?.technologies, ['TypeScript', 'Python', 'Rust']);
  assert.equal(merged.cv?.work_experience.length, 1);

  await rejects(saveDetails(ctx, p.id, { skills: 'x' }), 422);
  await rejects(saveDetails(ctx, p.id, { summary: 'x'.repeat(5001) }), 422);
});

test('cv: flags facts missing from the resume and rejects an empty resume', async () => {
  const { ctx, ai } = makeCtx();
  const p = await createProfile(ctx, { full_name: 'Ada', email: null, phone: null, location: null, linkedin_url: null });
  const resume = await createResume(ctx, p.id, 'cv.pdf', pdfBytes(RESUME_TEXT));
  ai.replies.push({ ...AI_CV, work_experience: [{ company: 'Invented Corp', title: 'CEO' }], contact: { email: 'x@y.com' } });
  const a = await analyzeResume(ctx, p.id, resume.id);
  assert.equal(a.warnings.length, 3);
  const blank = await createResume(ctx, p.id, 'blank.pdf', pdfBytes('   '));
  await rejects(analyzeResume(ctx, p.id, blank.id), 422);
  ai.replies.push(new ApiError('http', 'The Gemini quota', 429));
  await rejects(analyzeResume(ctx, p.id, resume.id), 429);
});

test('prepare: profile, preferences with approval, sensitive, saved, ai, cache', async () => {
  const { ctx, ai } = makeCtx();
  const p = await createProfile(ctx, { full_name: 'Ada Lovelace', email: 'ada@example.com', phone: null, location: 'London', linkedin_url: null });
  await savePreferences(ctx, p.id, { salary_expectation: '90000', notice_period: '2 weeks', work_authorization_countries: ['United Kingdom'], requires_sponsorship: false });
  await saveAnswers(ctx, p.id, [
    { question: 'Favourite language? (optional)', answer: 'TypeScript' },
    { question: 'What is your salary?', answer: '1' },
  ]);
  assert.equal((await listAnswers(ctx, p.id)).length, 1); // salary is sensitive, never saved

  const fields = [
    field('f1', 'Full name'), field('f2', 'Email address', 'email'), field('f3', 'Phone number', 'tel'),
    field('f4', 'Salary expectation', 'number'),
    field('f5', 'Are you legally authorized to work in the United Kingdom?', 'radio', ['Yes', 'No']),
    field('f6', 'Do you require visa sponsorship?', 'radio', ['Yes', 'No']),
    field('f7', 'Favourite language?'),
    field('f8', 'Gender', 'select', ['Male', 'Female']),
    field('f9', 'I agree to the privacy policy', 'checkbox', ['agree']),
    field('f10', 'Why do you want this job?', 'textarea'),
    field('f11', 'Years of experience', 'select', ['1-2', '3-5']),
    field('f12', 'Notice period'),
  ];
  // Choices, short text and long text are sent as separate, parallel requests (in that order).
  ai.replies.push({ answers: [{ field_id: 'f8', value: 'Female' }, { field_id: 'f9', value: 'yes' }, { field_id: 'f11', value: 'about 3-5 years' }] });
  ai.replies.push({ answers: [{ field_id: 'f10', value: 'Because I like building things.' }] });
  const first = await prepare(ctx, p.id, { job: JOB, fields });
  const by = new Map(first.answers.map((a) => [a.field_id, a]));
  assert.equal(by.get('f1')?.value, 'Ada Lovelace');
  assert.equal(by.get('f2')?.source, 'profile');
  assert.equal(by.get('f3')?.source, 'none');
  assert.match(by.get('f3')?.note ?? '', /No phone/);
  assert.equal(by.get('f4')?.value, '90000');
  assert.equal(by.get('f4')?.needs_approval, true);
  assert.equal(by.get('f5')?.value, 'Yes');
  assert.equal(by.get('f5')?.needs_approval, true);
  assert.equal(by.get('f6')?.value, 'No');
  assert.equal(by.get('f7')?.source, 'saved');
  // Sensitive questions still get a proposed answer, but only after the applicant approves it.
  assert.equal(by.get('f8')?.value, 'Female');
  assert.equal(by.get('f8')?.needs_approval, true);
  assert.deepEqual(by.get('f9')?.values, ['agree']);
  assert.equal(by.get('f9')?.needs_approval, true);
  assert.equal(by.get('f10')?.source, 'ai');
  assert.equal(by.get('f11')?.value, '3-5');
  assert.equal(by.get('f12')?.value, '2 weeks');
  assert.equal(by.get('f12')?.needs_approval, false);
  assert.equal(first.ai_used, true);
  // The AI saw only the fields that needed it, and never the sensitive preferences.
  assert.equal(ai.requests.length, 2);
  const prompt = ai.requests.map((r) => r.prompt).join(' ');
  assert.ok(!prompt.includes('90000') && !prompt.includes('United Kingdom') && !prompt.includes('sponsor'));
  assert.ok(prompt.includes('f10') && prompt.includes('"f8"') && !prompt.includes('"f1"'));

  const second = await prepare(ctx, p.id, { job: JOB, fields });
  assert.equal(second.ai_used, false);
  assert.equal(second.cache_hits, 4);
  assert.equal(second.answers.find((a) => a.field_id === 'f10')?.cached, true);
  assert.equal(second.answers.find((a) => a.field_id === 'f8')?.needs_approval, true);
  assert.equal(ai.requests.length, 2);

  // Editing the profile invalidates the cache.
  await updateProfile(ctx, p.id, { location: 'Paris' });
  ai.replies.push({ answers: [] }, { answers: [] });
  const third = await prepare(ctx, p.id, { job: JOB, fields });
  assert.equal(third.cache_hits, 0);
  assert.notEqual(third.context_version, first.context_version);
});

test('prepare: AI failure still returns the non-AI answers; suggestions are filtered', async () => {
  const { ctx, ai } = makeCtx();
  const p = await createProfile(ctx, { full_name: 'Ada', email: 'ada@example.com', phone: null, location: null, linkedin_url: null });
  ai.replies.push(new ApiError('http', 'The Gemini quota or rate limit has been reached.', 429));
  const failed = await prepare(ctx, p.id, { job: JOB, fields: [field('a', 'Email', 'email'), field('b', 'Can you start soon?')] });
  assert.equal(failed.ai_used, false);
  assert.match(failed.ai_error ?? '', /quota/);
  assert.equal(failed.answers[0]?.value, 'ada@example.com');

  ai.replies.push({
    answers: [
      { field_id: 'b', value: null, note: 'Not stated', suggestions: [{ choice: 'Yes', answer: 'No, I cannot' }, { choice: 'No', answer: 'No, I am not available' }, { choice: 'yes' }, null, { choice: 'Maybe', answer: 'Maybe soon' }] },
    ],
  });
  const ok = await prepare(ctx, p.id, { job: JOB, fields: [field('b', 'Can you start soon?')] });
  assert.deepEqual(ok.answers[0]?.suggestions, [
    { label: 'Yes', answer: null },
    { label: 'No', answer: 'No, I am not available' },
    { label: 'Maybe', answer: 'Maybe soon' },
  ]);
  assert.equal(ok.answers[0]?.note, 'Not stated');
});

test('prepare: a not-set preference points to Preferences', async () => {
  const { ctx, ai } = makeCtx();
  const p = await createProfile(ctx, { full_name: 'Ada', email: null, phone: null, location: null, linkedin_url: null });
  ai.replies.push({ answers: [{ field_id: 'n', value: null, suggestions: [{ choice: '2 weeks', answer: 'I can start in two weeks.' }] }] });
  const r = await prepare(ctx, p.id, { job: JOB, fields: [field('n', 'What is your notice period?'), field('s', 'Expected salary', 'number')] });
  const n = r.answers[0]!;
  assert.equal(n.preference, 'notice');
  assert.match(n.note ?? '', /isn't in your Preferences/);
  assert.equal(n.suggestions?.length, 1);
  assert.equal(r.answers[1]?.preference, 'salary');
  assert.equal(r.answers[1]?.source, 'none');
});

test('compose: keeps the choice, never contradicts it', async () => {
  const { ctx, ai } = makeCtx();
  const p = await createProfile(ctx, { full_name: 'Ada', email: null, phone: null, location: null, linkedin_url: null });
  ai.replies.push({ value: 'Yes, I am happy to relocate.' });
  assert.deepEqual(await compose(ctx, p.id, { job: JOB, question: 'Open to relocation?', type: 'text', choice: 'Yes' }), { value: 'Yes, I am happy to relocate.', composed: true });
  ai.replies.push({ value: 'No, I would not.' });
  assert.equal((await compose(ctx, p.id, { job: JOB, question: 'Open to relocation?', type: 'text', choice: 'Yes' })).composed, false);
  const n = ai.requests.length;
  assert.deepEqual(await compose(ctx, p.id, { job: JOB, question: 'Your salary?', type: 'text', choice: '90k' }), { value: '90k', composed: false });
  assert.deepEqual(await compose(ctx, p.id, { job: JOB, question: 'Years', type: 'number', choice: '4' }), { value: '4', composed: false });
  assert.equal(ai.requests.length, n);
});

test('history: dedupe by link, stats, remove', async () => {
  const { ctx } = makeCtx();
  const p = await createProfile(ctx, { full_name: 'Ada', email: null, phone: null, location: null, linkedin_url: null });
  assert.equal(await jobKey('a', 'b', 'https://x.com/jobs/1/apply?utm_source=li'), await jobKey('c', 'd', 'https://X.com/jobs/1'));
  assert.notEqual(await jobKey('a', 'b', 'https://x.com/jobs/1'), await jobKey('a', 'b', 'https://x.com/jobs/2'));
  assert.equal(await jobKey('A ', 'B', ''), await jobKey('a', ' b', ''));

  const first = await recordApplication(ctx, p.id, { title: 'Engineer', company: 'Acme', url: 'https://acme.com/jobs/1/apply?utm_source=x' });
  assert.equal(first.already_recorded, false);
  const again = await recordApplication(ctx, p.id, { title: 'Engineer', company: 'Acme', url: 'https://acme.com/jobs/1' });
  assert.equal(again.already_recorded, true);
  assert.equal(again.id, first.id);
  await recordApplication(ctx, p.id, { title: 'Old', applied_at: new Date(Date.now() - 20 * 86400_000).toISOString() });
  await rejects(recordApplication(ctx, p.id, {}), 422);
  await rejects(recordApplication(ctx, p.id, { title: 'x', applied_at: new Date(Date.now() + 3600_000).toISOString() }), 422, /future/);
  await rejects(recordApplication(ctx, p.id, { title: 'x', applied_at: '2024-01-01T00:00:00' }), 422);

  const stats = await applicationStats(ctx, p.id, 'UTC');
  assert.deepEqual(stats, { total: 2, today: 1, last_7_days: 1, last_30_days: 2 });
  await rejects(applicationStats(ctx, p.id, 'Mars/Base'), 422);
  // "today" follows the applicant's own midnight
  const noon = Date.UTC(2026, 0, 10, 12);
  const { ctx: c2 } = makeCtx();
  const p2 = await createProfile(c2, { full_name: 'B', email: null, phone: null, location: null, linkedin_url: null });
  await recordApplication(c2, p2.id, { title: 'late', applied_at: '2026-01-10T10:00:00Z' });
  assert.equal((await applicationStats(c2, p2.id, 'UTC', noon)).today, 1);
  assert.equal((await applicationStats(c2, p2.id, 'Pacific/Auckland', noon)).today, 0); // already 01:00 on the 11th there

  const list = await listApplications(ctx, p.id);
  assert.equal(list[0]?.title, 'Engineer');
  await removeApplication(ctx, p.id, first.id);
  assert.equal((await listApplications(ctx, p.id)).length, 1);
  await rejects(removeApplication(ctx, p.id, first.id), 404);
});

test('backup: exports data but never the API key; import replaces', async () => {
  const { ctx, store } = makeCtx();
  await saveAiSettings(store, { apiKey: 'SECRET-KEY' });
  const p = await createProfile(ctx, { full_name: 'Ada', email: null, phone: null, location: null, linkedin_url: null });
  const backup = await exportBackup(store);
  assert.ok(!JSON.stringify(backup).includes('SECRET-KEY'));
  assert.ok(backup.data['jf:profiles']);

  const other = makeCtx();
  await saveAiSettings(other.store, { apiKey: 'OTHER' });
  await createProfile(other.ctx, { full_name: 'Zed', email: null, phone: null, location: null, linkedin_url: null });
  const result = await importBackup(other.store, JSON.parse(JSON.stringify(backup)));
  assert.equal(result.profiles, 1);
  assert.deepEqual((await listProfiles(other.ctx)).map((x) => x.id), [p.id]);
  assert.equal((await other.store.get<{ apiKey: string }>('jf:settings'))?.apiKey, 'OTHER');
  await assert.rejects(importBackup(other.store, { app: 'nope' }));
  await assert.rejects(importBackup(other.store, { app: 'job-fellow', data: { 'jf:settings': {} } }));
});

test('ai settings: no key gives a clear error', async () => {
  const { store } = makeCtx();
  await assert.rejects(makeAi(store)(), (e: ApiError) => e.status === 503 && /Gemini API key/.test(e.message));
  await assert.rejects(saveAiSettings(store, { apiKey: 'a b' }));
});

// ---- the Gemini client, with a fake network ----

const geminiOk = (json: unknown) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }] }), { status: 200 });
const settings = { apiKey: 'K', model: 'm1', fallbackModel: 'm2', thinkingOff: true, timeoutMs: 1000, maxAttempts: 2 };
const request = { system: 's', prompt: 'p', schema: {}, parse: (j: unknown) => j as { a: number } };

test('gemini: sends the key in a header, thinking off, parses the answer', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = new GeminiClient(settings, { fetch: async (url, init) => { calls.push({ url, init }); return geminiOk({ a: 1 }); }, sleep: async () => {} });
  const out = await client.generate(request);
  assert.deepEqual(out, { data: { a: 1 }, model: 'm1' });
  assert.ok(!calls[0]!.url.includes('K') && calls[0]!.url.includes('m1:generateContent'));
  assert.equal((calls[0]!.init.headers as Record<string, string>)['x-goog-api-key'], 'K');
  const body = JSON.parse(calls[0]!.init.body as string);
  assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 0);
  assert.equal(body.generationConfig.temperature, 0);
});

test('gemini: retries without thinking when the model rejects it', async () => {
  const bodies: string[] = [];
  const client = new GeminiClient(settings, {
    fetch: async (_u, init) => {
      bodies.push(init.body as string);
      return bodies.length === 1 ? new Response('thinking is not supported', { status: 400 }) : geminiOk({ a: 2 });
    },
    sleep: async () => {},
  });
  assert.deepEqual((await client.generate(request)).data, { a: 2 });
  assert.ok(!bodies[1]!.includes('thinkingConfig'));
});

test('gemini: falls back to the second model on quota, and explains a daily quota', async () => {
  const models: string[] = [];
  const client = new GeminiClient(settings, {
    fetch: async (url) => { models.push(url); return models.length === 1 ? new Response('RESOURCE_EXHAUSTED GenerateRequestsPerDay', { status: 429 }) : geminiOk({ a: 3 }); },
    sleep: async () => {},
  });
  const out = await client.generate(request);
  assert.equal(out.model, 'm2');

  const both = new GeminiClient(settings, { fetch: async () => new Response('PerDay', { status: 429 }), sleep: async () => {} });
  await rejects(both.generate(request), 429, /daily quota/);
});

test('gemini: errors are translated', async () => {
  const run = (response: () => Response | Promise<Response>, s = settings) =>
    new GeminiClient({ ...s, fallbackModel: '' }, { fetch: async () => response(), sleep: async () => {} }).generate(request);
  await rejects(run(() => new Response('', { status: 403 })), 502, /rejected the API key/);
  await rejects(run(() => new Response('', { status: 404 })), 502, /model/);
  await rejects(run(() => new Response('', { status: 500 })), 503);
  await rejects(run(() => new Response(JSON.stringify({ candidates: [] }), { status: 200 })), 502, /empty/);
  await rejects(run(() => { throw new TypeError('failed to fetch'); }), 503).catch(() => undefined);
  await assert.rejects(run(() => { throw new TypeError('failed to fetch'); }), (e: ApiError) => e.kind === 'network');
  await assert.rejects(new GeminiClient({ ...settings, apiKey: ' ' }).generate(request), (e: ApiError) => e.status === 503 && /API key/.test(e.message));
  const bad = new GeminiClient({ ...settings, fallbackModel: '' }, { fetch: async () => geminiOk({ nope: true }), sleep: async () => {} });
  await rejects(bad.generate({ ...request, parse: () => { throw new Error('x'); } }), 502);
});

test('draft: writes one answer on request, never for personal questions', async () => {
  const { ctx, ai } = makeCtx();
  const p = await createProfile(ctx, { full_name: 'Ada', email: null, phone: null, location: null, linkedin_url: null });
  await savePreferences(ctx, p.id, { salary_expectation: '90000', career_goals: 'Lead a team' });
  ai.replies.push({ value: 'I want to grow into a lead engineering role.' });
  const out = await draftAnswer(ctx, p.id, { job: JOB, question: 'Where do you see yourself in five years?', type: 'textarea' });
  assert.equal(out.value, 'I want to grow into a lead engineering role.');
  assert.ok(!(ai.requests[0]?.prompt ?? '').includes('90000'), 'salary must never reach the AI');

  const n = ai.requests.length;
  for (const question of ['What are your salary expectations?', 'Are you legally authorized to work in Canada?', 'Do you require visa sponsorship?', 'I agree to the privacy policy', 'Gender']) {
    await rejects(draftAnswer(ctx, p.id, { job: JOB, question, type: 'text' }), 422);
  }
  await rejects(draftAnswer(ctx, p.id, { job: JOB, question: 'Tick this', type: 'checkbox' }), 422);
  assert.equal(ai.requests.length, n, 'no AI call for personal questions');

  ai.replies.push({ value: '3-5' });
  const pick = await draftAnswer(ctx, p.id, { job: JOB, question: 'Years of experience', type: 'select', options: [{ value: '1-2', label: '1-2' }, { value: '3-5', label: '3-5' }] });
  assert.equal(pick.value, '3-5');
  ai.replies.push({ value: 'banana' });
  await rejects(draftAnswer(ctx, p.id, { job: JOB, question: 'Years of experience', type: 'select', options: [{ value: '1-2', label: '1-2' }] }), 422);
  ai.replies.push({ value: '   ' });
  await rejects(draftAnswer(ctx, p.id, { job: JOB, question: 'Anything else?', type: 'text' }), 422);
});

test('matchOption: exact, then unambiguous word match', () => {
  const f = field('x', 'Experience', 'select', ['Yes', 'No', '3-5 years', '6-10 years']);
  assert.equal(matchOption(f, 'yes'), 'Yes');
  assert.equal(matchOption(f, 'Yes, I am'), 'Yes');
  assert.equal(matchOption(f, 'No'), 'No');
  assert.equal(matchOption(f, 'not sure'), null);
  assert.equal(matchOption(f, '3-5 years of experience'), '3-5 years');
  assert.equal(matchOption(f, 'years'), null); // ambiguous
});
