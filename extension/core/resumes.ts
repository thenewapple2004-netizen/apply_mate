import { unzipSync } from 'fflate';
import type { Ctx } from './ctx.ts';
import { ApiError, notFound } from './errors.ts';
import { requireProfile } from './profiles.ts';
import { profileKey } from './store.ts';
import { nowIso, sha256Hex, uuid } from './text.ts';
import type { Resume, ResumeDetail, StoredResume } from './types.ts';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_CHARS = 500_000;
const MAX_DOCX_XML_BYTES = 50 * 1024 * 1024; // refuse zip bombs

const DOCX_MAIN_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]; // legacy .doc and encrypted Office files

type FileType = 'pdf' | 'docx';

const unsupported = (message: string): ApiError => new ApiError('http', message, 415);
const unreadable = (message: string): ApiError => new ApiError('http', message, 422);
const damaged = (): ApiError =>
  unreadable("The file appears to be damaged and couldn't be read. Try exporting it again.");

const key = (profileId: string): string => profileKey(profileId, 'resumes');

const startsWith = (data: Uint8Array, bytes: number[]): boolean => bytes.every((b, i) => data[i] === b);

/** Reads only the named members of a DOCX (a zip), skipping oversized ones. */
function readDocxMembers(data: Uint8Array, names: string[]): Record<string, string> {
  const files = unzipSync(data, { filter: (f) => names.includes(f.name) && f.originalSize <= MAX_DOCX_XML_BYTES });
  const out: Record<string, string> = {};
  for (const name of names) if (files[name]) out[name] = new TextDecoder('utf-8').decode(files[name]);
  return out;
}

function looksLikeDocx(data: Uint8Array): boolean {
  try {
    const m = readDocxMembers(data, ['[Content_Types].xml', 'word/document.xml']);
    return Boolean(m['word/document.xml']) && (m['[Content_Types].xml'] ?? '').includes(DOCX_MAIN_TYPE);
  } catch {
    return false;
  }
}

/** Identify the file by its bytes, and require the extension to agree. */
export function detectFileType(data: Uint8Array, filename: string): FileType {
  const extension = filename.includes('.') ? (filename.split('.').pop() ?? '').toLowerCase() : '';
  if (extension !== 'pdf' && extension !== 'docx') throw unsupported('Only PDF and DOCX files are supported.');

  if (startsWith(data, OLE_MAGIC)) {
    throw unreadable(
      'This file is password-protected or an old .doc file. ' +
        'Remove the password or save it as .docx or PDF, then upload it again.',
    );
  }
  const head = new TextDecoder('latin1').decode(data.subarray(0, 1024));
  let detected: FileType;
  if (head.includes('%PDF-')) detected = 'pdf';
  else if (startsWith(data, [0x50, 0x4b, 0x03, 0x04]) && looksLikeDocx(data)) detected = 'docx';
  else throw unsupported(`This file isn't a valid ${extension.toUpperCase()} document.`);

  if (detected !== extension) {
    throw unsupported(
      `The file is named .${extension} but its contents are ${detected.toUpperCase()}. ` +
        'Rename it to match, or export it again.',
    );
  }
  return detected;
}

/** Make text safe to store and pleasant to read. */
export function normalizeText(text: string): string {
  let t = text.replace(/\x00/g, '').replace(/\r\n?/g, '\n');
  t = t.split('\n').map((l) => l.replace(/\s+$/, '')).join('\n');
  t = t.replace(/\n{3,}/g, '\n\n').trim();
  return t.slice(0, MAX_TEXT_CHARS);
}

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    const lower = e.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    const code = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
    try {
      return String.fromCodePoint(code);
    } catch {
      return '';
    }
  });
}

function extractDocx(data: Uint8Array): string {
  let xml: string;
  try {
    xml = readDocxMembers(data, ['word/document.xml'])['word/document.xml'] ?? '';
  } catch {
    throw damaged();
  }
  // Documents never need a DOCTYPE/entities; refuse them (entity-expansion attacks).
  if (!xml || /<!DOCTYPE|<!ENTITY/i.test(xml) || !/<w:body[\s>]/.test(xml)) throw damaged();

  const paragraphs: string[] = [];
  for (const p of xml.matchAll(/<w:p(?=[\s>/])[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g)) {
    const inner = p[1] ?? '';
    let text = '';
    for (const token of inner.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:(?:br|cr)\b[^>]*\/>/g)) {
      if (token[1] !== undefined) text += decodeXml(token[1]);
      else if (token[0].startsWith('<w:tab')) text += '\t';
      else text += '\n';
    }
    paragraphs.push(text);
  }
  return normalizeText(paragraphs.join('\n'));
}

async function extractPdf(ctx: Ctx, data: Uint8Array): Promise<string> {
  if (!ctx.pdf) throw damaged();
  try {
    return normalizeText((await ctx.pdf(data)).join('\n\n'));
  } catch (error) {
    if ((error as { name?: string })?.name === 'PasswordException') {
      throw unreadable('This PDF is password-protected. Remove the password and upload it again.');
    }
    throw damaged();
  }
}

/** A display-safe version of the uploaded filename (it is never used as a path). */
export function cleanFilename(filename: string | null | undefined): string {
  let name = (filename ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
  name = name.normalize('NFC').replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim();
  if (name.length > 255) {
    const dot = name.lastIndexOf('.');
    const ext = dot >= 0 ? name.slice(dot) : '';
    const keep = 255 - ext.length;
    name = dot >= 0 && keep > 0 ? name.slice(0, keep) + ext : name.slice(0, 255);
  }
  return name || 'resume';
}

const toResume = (r: StoredResume): Resume => ({
  id: r.id,
  profile_id: r.profile_id,
  original_filename: r.original_filename,
  file_type: r.file_type,
  size_bytes: r.size_bytes,
  is_primary: r.is_primary,
  text_length: r.extracted_text.length,
  has_text: r.extracted_text.trim().length > 0,
  created_at: r.created_at,
  updated_at: r.updated_at,
});
const toDetail = (r: StoredResume): ResumeDetail => ({ ...toResume(r), extracted_text: r.extracted_text });

export async function storedResumes(ctx: Ctx, profileId: string): Promise<StoredResume[]> {
  await requireProfile(ctx, profileId);
  return (await ctx.store.get<StoredResume[]>(key(profileId))) ?? [];
}

export async function listResumes(ctx: Ctx, profileId: string): Promise<Resume[]> {
  return (await storedResumes(ctx, profileId)).map(toResume);
}

export async function getStoredResume(ctx: Ctx, profileId: string, resumeId: string): Promise<StoredResume> {
  const found = (await storedResumes(ctx, profileId)).find((r) => r.id === resumeId);
  if (!found) throw notFound('Resume');
  return found;
}

export async function getResume(ctx: Ctx, profileId: string, resumeId: string): Promise<ResumeDetail> {
  return toDetail(await getStoredResume(ctx, profileId, resumeId));
}

/** Validate, read and store a resume's text. Only the text is kept, not the file. */
export async function createResume(ctx: Ctx, profileId: string, filename: string, data: Uint8Array): Promise<Resume> {
  await requireProfile(ctx, profileId);
  if (data.length === 0) throw unreadable('The file is empty.');
  if (data.length > MAX_UPLOAD_BYTES) {
    throw new ApiError('http', 'That file is larger than 10 MB. Please choose a smaller one.', 413);
  }
  const name = cleanFilename(filename);
  const fileType = detectFileType(data, name);
  const text = fileType === 'pdf' ? await extractPdf(ctx, data) : extractDocx(data);

  const now = nowIso();
  const resume: StoredResume = {
    id: uuid(),
    profile_id: profileId,
    original_filename: name,
    file_type: fileType,
    size_bytes: data.length,
    sha256: await sha256Hex(data),
    extracted_text: text,
    is_primary: false,
    created_at: now,
    updated_at: now,
  };
  await ctx.store.update<StoredResume[]>(key(profileId), (all) => [...(all ?? []), resume]);
  return toResume(resume);
}

export async function setPrimary(ctx: Ctx, profileId: string, resumeId: string, primary: boolean): Promise<Resume> {
  await getStoredResume(ctx, profileId, resumeId);
  let result: StoredResume | undefined;
  await ctx.store.update<StoredResume[]>(key(profileId), (all) =>
    (all ?? []).map((r) => {
      if (r.id === resumeId) {
        result = { ...r, is_primary: primary, updated_at: nowIso() };
        return result;
      }
      return primary && r.is_primary ? { ...r, is_primary: false } : r;
    }),
  );
  if (!result) throw notFound('Resume');
  return toResume(result);
}

export async function deleteResume(ctx: Ctx, profileId: string, resumeId: string): Promise<void> {
  await getStoredResume(ctx, profileId, resumeId);
  await ctx.store.update<StoredResume[]>(key(profileId), (all) => (all ?? []).filter((r) => r.id !== resumeId));
}
