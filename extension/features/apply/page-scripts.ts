/**
 * Functions injected into the current tab with chrome.scripting.executeScript.
 *
 * Each one is serialized and run inside the page, so it must be self-contained:
 * no imports and no references to anything outside its own body.
 */

export interface DetectedJob {
  title: string;
  company: string;
  description: string;
  url: string;
  source: 'structured' | 'page';
}

export type FieldType =
  | 'text' | 'email' | 'tel' | 'url' | 'number' | 'date' | 'textarea' | 'select' | 'radio' | 'checkbox';

export interface DetectedField {
  id: string;
  label: string;
  type: FieldType;
  required: boolean;
  options: { value: string; label: string }[];
}

export interface FillInstruction {
  id: string;
  type: FieldType;
  value: string | null;
  values: string[];
}

export interface FillResult {
  id: string;
  status: 'filled' | 'unchanged' | 'not_found' | 'failed';
}

/** Reads the job posting: schema.org JobPosting data first, then the visible page. */
export function extractJob(): DetectedJob {
  const tidy = (s: string) =>
    s.replace(/\r/g, '').replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  // Parse HTML in an inert document (no scripts or event handlers run).
  const htmlToText = (html: string) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('li').forEach((li) => li.prepend('• '));
    doc.querySelectorAll('p, li, br, h1, h2, h3, h4, h5, div, tr').forEach((el) => el.append('\n'));
    return tidy(doc.body.textContent ?? '');
  };

  const findPosting = (node: unknown): Record<string, unknown> | null => {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = findPosting(item);
        if (found) return found;
      }
      return null;
    }
    const obj = node as Record<string, unknown>;
    const type = obj['@type'];
    if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) return obj;
    return findPosting(obj['@graph']);
  };

  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const posting = findPosting(JSON.parse(script.textContent ?? ''));
      if (posting) {
        const org = posting.hiringOrganization as { name?: string } | string | undefined;
        return {
          title: tidy(String(posting.title ?? '')),
          company: tidy(typeof org === 'string' ? org : (org?.name ?? '')),
          description: htmlToText(String(posting.description ?? '')).slice(0, 20000),
          url: location.href,
          source: 'structured',
        };
      }
    } catch {
      // Malformed JSON-LD: fall back to the page.
    }
  }

  const meta = (selector: string) => document.querySelector<HTMLMetaElement>(selector)?.content?.trim() ?? '';
  const title =
    document.querySelector('h1')?.textContent?.trim() || meta('meta[property="og:title"]') || document.title;
  const company = meta('meta[property="og:site_name"]') || meta('meta[name="author"]');

  // The description: the block with the most text that reads like a job description.
  const keywords = /responsibilit|requirement|qualification|about the role|what you('|’)ll do|experience|skills/i;
  let best: { el: HTMLElement; score: number } | null = null;
  for (const el of document.querySelectorAll<HTMLElement>('article, main, section, div')) {
    if (el.closest('nav, header, footer, aside, form')) continue;
    const text = el.innerText ?? '';
    if (text.length < 200 || text.length > 30000 || !keywords.test(text)) continue;
    // Prefer focused blocks: penalize huge containers that wrap the whole page.
    const score = Math.min(text.length, 8000) - Math.max(0, text.length - 8000) * 0.5;
    if (!best || score > best.score) best = { el, score };
  }
  const description = tidy(best?.el.innerText ?? document.querySelector('main')?.innerText ?? '').slice(0, 20000);
  return { title: tidy(title), company: tidy(company), description, url: location.href, source: 'page' };
}

/** Finds visible, fillable questions on the page and tags them for filling later. */
export function detectFields(): DetectedField[] {
  const ATTR = 'data-jobfellow-id';
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 1000);
  const isVisible = (el: Element) => {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
  };
  const textWithoutControls = (el: Element) => {
    const copy = el.cloneNode(true) as Element;
    copy.querySelectorAll('input, select, textarea, button').forEach((c) => c.remove());
    return clean(copy.textContent);
  };
  const byIds = (ids: string | null) =>
    clean((ids ?? '').split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' '));

  const ownLabel = (el: HTMLElement) => {
    const labels = (el as HTMLInputElement).labels;
    const first = labels?.[0];
    if (first) return textWithoutControls(first);
    return (
      byIds(el.getAttribute('aria-labelledby')) ||
      clean(el.getAttribute('aria-label')) ||
      clean(el.getAttribute('placeholder')) ||
      clean(el.getAttribute('title')) ||
      clean(el.getAttribute('name'))
    );
  };

  const groupLabel = (first: HTMLElement) => {
    const group = first.closest('[role="radiogroup"], [role="group"], fieldset');
    if (group) {
      const fromAria = byIds(group.getAttribute('aria-labelledby')) || clean(group.getAttribute('aria-label'));
      if (fromAria) return fromAria;
      const legend = group.querySelector('legend');
      if (legend && group.tagName === 'FIELDSET') return clean(legend.textContent);
      const before = group.previousElementSibling;
      if (before) return clean(before.textContent);
    }
    return ownLabel(first);
  };

  const fields: DetectedField[] = [];
  const seenGroups = new Set<string>();
  let counter = 0;
  const nextId = () => `jf-${++counter}`;

  const controls = document.querySelectorAll<HTMLElement>('input, select, textarea');
  for (const el of controls) {
    if (fields.length >= 150) break;
    if ((el as HTMLInputElement).disabled || (el as HTMLInputElement).readOnly) continue;

    if (el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox')) {
      const form = el.form ?? document;
      const group = el.name
        ? [...form.querySelectorAll<HTMLInputElement>(`input[type="${el.type}"][name="${CSS.escape(el.name)}"]`)]
        : [el];
      const key = `${el.type}:${el.name || Math.random()}`;
      if (seenGroups.has(key)) continue;
      seenGroups.add(key);
      // Custom-styled inputs are often invisible themselves; their labels aren't.
      if (!group.some((i) => isVisible(i) || (i.labels?.[0] && isVisible(i.labels[0])))) continue;
      const id = nextId();
      group.forEach((i) => i.setAttribute(ATTR, id));
      const single = el.type === 'checkbox' && group.length === 1;
      fields.push({
        id,
        label: single ? ownLabel(el) : groupLabel(el),
        type: el.type as 'radio' | 'checkbox',
        required: group.some((i) => i.required) || /\*\s*$/.test(groupLabel(el)),
        options: group.map((i) => ({ value: i.value || 'on', label: ownLabel(i) || i.value })),
      });
      continue;
    }

    if (!isVisible(el)) continue;
    let type: FieldType;
    if (el instanceof HTMLTextAreaElement) type = 'textarea';
    else if (el instanceof HTMLSelectElement) type = 'select';
    else {
      const t = (el as HTMLInputElement).type;
      if (t === 'text' || t === 'search' || t === '') type = 'text';
      else if (t === 'email' || t === 'tel' || t === 'url' || t === 'number' || t === 'date') type = t;
      else continue; // password, file, hidden, buttons, range, color, ...: not supported
    }
    const id = nextId();
    el.setAttribute(ATTR, id);
    const label = ownLabel(el);
    fields.push({
      id,
      label,
      type,
      required: (el as HTMLInputElement).required || /\*\s*$/.test(label),
      options:
        el instanceof HTMLSelectElement
          ? [...el.options].filter((o) => o.value !== '').map((o) => ({ value: o.value, label: clean(o.textContent) }))
          : [],
    });
  }
  return fields;
}

/** Fills tagged fields. Only changes field values; never clicks buttons or submits. */
export function fillFields(instructions: FillInstruction[]): FillResult[] {
  const ATTR = 'data-jobfellow-id';
  const mark = (el: HTMLElement) => {
    el.style.outline = '2px solid #7b9bff';
    el.style.outlineOffset = '2px';
    setTimeout(() => {
      el.style.outline = '';
      el.style.outlineOffset = '';
    }, 6000);
  };
  const setValue = (el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) => {
    // Use the native setter so frameworks like React notice the change.
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter ? setter.call(el, value) : (el.value = value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  return instructions.map(({ id, type, value, values }): FillResult => {
    const els = [...document.querySelectorAll<HTMLElement>(`[${ATTR}="${CSS.escape(id)}"]`)];
    if (!els.length) return { id, status: 'not_found' };
    try {
      if (type === 'radio') {
        const target = els.find((e) => (e as HTMLInputElement).value === value) as HTMLInputElement | undefined;
        if (!target) return { id, status: 'not_found' };
        if (target.checked) return { id, status: 'unchanged' };
        target.click(); // selects the option and fires the page's own change handlers
        mark(target.closest('label') ?? target);
        return { id, status: 'filled' };
      }
      if (type === 'checkbox') {
        let changed = false;
        for (const e of els as HTMLInputElement[]) {
          const wanted = values.includes(e.value || 'on');
          if (e.checked !== wanted) {
            e.click();
            changed = true;
            mark(e.closest('label') ?? e);
          }
        }
        return { id, status: changed ? 'filled' : 'unchanged' };
      }
      const el = els[0] as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      if (value === null) return { id, status: 'unchanged' };
      if (el instanceof HTMLSelectElement && ![...el.options].some((o) => o.value === value)) {
        return { id, status: 'not_found' };
      }
      if (el.value === value) return { id, status: 'unchanged' };
      setValue(el, value);
      mark(el);
      return { id, status: 'filled' };
    } catch {
      return { id, status: 'failed' };
    }
  });
}
