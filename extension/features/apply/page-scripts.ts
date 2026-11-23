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
  /** 'combobox' = a custom (JavaScript) dropdown, e.g. Greenhouse's; values are option labels. */
  widget: 'native' | 'combobox';
  /** Fallbacks for finding the field again if the page re-renders it. */
  locator: { domId: string | null; name: string | null };
}

export interface Detection {
  fields: DetectedField[];
  /** Questions Job Fellow can't fill, with the reason shown to the user. */
  unsupported: { label: string; reason: string }[];
  /** URL of an application form embedded from another site (e.g. Greenhouse), if any. */
  embeddedForm: string | null;
}

export interface FillInstruction {
  id: string;
  type: FieldType;
  widget: 'native' | 'combobox';
  locator: { domId: string | null; name: string | null };
  value: string | null;
  values: string[];
}

export type FillStatus = 'filled' | 'unchanged' | 'kept' | 'not_found' | 'no_option' | 'failed';

export interface FillOutcome {
  results: { id: string; status: FillStatus }[];
  /** Questions that appeared after filling (e.g. follow-up questions). */
  newFields: number;
}

/** How many of the previously detected fields are still on the page. A step change in a
 *  multi-step form (same address, different questions) makes most of them disappear. */
export function countPresent(items: { id: string; domId: string | null; name: string | null }[]): number {
  return items.filter(
    (i) =>
      document.querySelector(`[data-jobfellow-id="${CSS.escape(i.id)}"]`) ||
      (i.domId && document.getElementById(i.domId)) ||
      (i.name && document.querySelector(`[name="${CSS.escape(i.name)}"]`)),
  ).length;
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
  const text = (selector: string) => tidy(document.querySelector<HTMLElement>(selector)?.innerText ?? '');

  // Title: known job-board layouts (Greenhouse, Lever), then the page heading.
  let title =
    text('.job__title h1') || text('h1.app-title') || text('.posting-headline h2') || text('h1') ||
    meta('meta[property="og:title"]') || document.title;

  // Company: page metadata, then title patterns used by job boards, then the board's URL.
  let company = meta('meta[property="og:site_name"]') || meta('meta[name="application-name"]');
  const pageTitle = document.title.trim();
  const atMatch = pageTitle.match(/^(?:job application for )?(.+?) at (.+?)$/i);
  if (!company && atMatch) company = atMatch[2] ?? '';
  const dashMatch = pageTitle.match(/^(.+?) - (.+)$/);
  if (!company && dashMatch && location.hostname.endsWith('lever.co')) company = dashMatch[1] ?? '';
  if (!company) {
    const board = location.pathname.split('/').filter(Boolean)[0];
    if (board && /greenhouse\.io$|lever\.co$|ashbyhq\.com$/.test(location.hostname)) {
      company = board.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }
  if (company && title.toLowerCase().startsWith(`${company.toLowerCase()} - `)) title = title.slice(company.length + 3);

  // Description: known layouts first, then the block that reads most like a job description.
  const known = ['.job__description', '#content .content', '#content', '.posting-page .section-wrapper', '[data-qa="job-description"]'];
  let description = '';
  for (const selector of known) {
    const el = document.querySelector<HTMLElement>(selector);
    if (el && el.querySelectorAll('input, select, textarea').length < 3 && (el.innerText ?? '').length > 200) {
      description = el.innerText;
      break;
    }
  }
  if (!description) {
    const keywords = /responsibilit|requirement|qualification|about the role|what you('|’)ll do|experience|skills/i;
    let best: { el: HTMLElement; score: number } | null = null;
    for (const el of document.querySelectorAll<HTMLElement>('article, main, section, div')) {
      if (el.closest('nav, header, footer, aside, form')) continue;
      // Skip application forms: their text is questions, not the job description.
      if (el.querySelectorAll('input, select, textarea').length >= 3) continue;
      const body = el.innerText ?? '';
      if (body.length < 200 || body.length > 30000 || !keywords.test(body)) continue;
      const score = Math.min(body.length, 8000) - Math.max(0, body.length - 8000) * 0.5;
      if (!best || score > best.score) best = { el, score };
    }
    description = best?.el.innerText ?? '';
  }
  // Drop leading navigation lines such as "Back to jobs" / "Apply".
  description = tidy(description).replace(/^(back to jobs|apply( now)?|share)\n+/gim, '');
  return { title: tidy(title), company: tidy(company), description: description.slice(0, 20000), url: location.href, source: 'page' };
}

/**
 * Finds visible, fillable questions and tags them for filling later.
 * Waits for the page to settle first, so forms rendered by JavaScript are included.
 */
export async function detectFields(): Promise<Detection> {
  const ATTR = 'data-jobfellow-id';
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** Polls until `test()` is true (or the time is up): much faster than a fixed sleep. */
  const waitUntil = async (test: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (test()) return true;
      await sleep(30);
    }
    return test();
  };
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const firstLine = (s: string) => clean(s.split('\n').map((l) => l.trim()).find(Boolean) ?? '');
  const MARKER = /\s*[*✱]+\s*/g;
  const hasMarker = (s: string) => /[*✱]/.test(s);
  const tidyLabel = (s: string) => clean(s.replace(MARKER, ' ')).replace(/\s+([?:])/g, '$1').slice(0, 1000);

  // Wait until the DOM stops changing (max 4s), for dynamically loaded forms.
  await new Promise<void>((resolve) => {
    let timer = 0;
    const done = () => {
      observer.disconnect();
      resolve();
    };
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = window.setTimeout(done, 300);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    timer = window.setTimeout(done, 300);
    setTimeout(done, 3000);
  });

  const isVisible = (el: Element) => {
    if (el.closest('[aria-hidden="true"], [hidden]')) return false;
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return (
      style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.05 &&
      box.width >= 4 && box.height >= 4
    );
  };
  // Rendered text only (innerText skips hidden helper text), minus dropdown options.
  const visibleText = (el: HTMLElement) => {
    let t = el.innerText ?? el.textContent ?? '';
    el.querySelectorAll<HTMLElement>('select, textarea, [role="listbox"], [role="option"]').forEach((c) => {
      const inner = c.innerText;
      if (inner) t = t.replace(inner, ' ');
    });
    return t;
  };
  const byIds = (ids: string | null) =>
    clean((ids ?? '').split(/\s+/).map((id) => document.getElementById(id)?.innerText ?? '').join(' '));
  const rawLabel = (el: HTMLElement) => {
    const label = (el as HTMLInputElement).labels?.[0];
    if (label) return visibleText(label);
    return (
      byIds(el.getAttribute('aria-labelledby')) ||
      clean(el.getAttribute('aria-label')) ||
      clean(el.getAttribute('placeholder')) ||
      clean(el.getAttribute('title')) ||
      clean(el.getAttribute('name'))
    );
  };

  /** The question for a group of radios/checkboxes: explicit group label, or the
   *  nearest shared container's text minus the options' own labels. */
  const groupQuestion = (first: HTMLInputElement, inputs: HTMLInputElement[]) => {
    const group = first.closest<HTMLElement>('[role="radiogroup"], [role="group"], fieldset');
    if (group && inputs.every((i) => group.contains(i))) {
      const explicit =
        byIds(group.getAttribute('aria-labelledby')) || clean(group.getAttribute('aria-label')) ||
        (group.tagName === 'FIELDSET' ? clean(group.querySelector('legend')?.innerText) : '');
      if (explicit) return explicit;
    }
    let node: HTMLElement | null = first.parentElement;
    while (node && !inputs.every((i) => node!.contains(i))) node = node.parentElement;
    const optionLabels = new Set(inputs.map((i) => i.labels?.[0]).filter(Boolean));
    for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
      // A heading-like element for the question (e.g. Lever's ".application-label").
      // The nearest one *before* the options, so a neighbouring question's heading isn't used.
      const heading = [...node.querySelectorAll<HTMLElement>('legend, h2, h3, h4, [class*="label"], [class*="question"], [class*="title"]')]
        .filter(
          (h) =>
            h.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING &&
            !h.querySelector('input, select, textarea') &&
            ![...optionLabels].some((l) => l!.contains(h) || h.contains(l!)) &&
            clean(h.innerText).length >= 2,
        )
        .pop();
      if (heading) return clean(heading.innerText);
      // Remaining text once every option label (this group's or a neighbour's) is removed.
      let t = node.innerText ?? '';
      for (const label of node.querySelectorAll<HTMLElement>('label')) {
        if (label.querySelector('input, select, textarea')) t = t.replace(label.innerText, '\n');
      }
      for (const i of inputs) {
        const own = i.labels?.[0]?.innerText;
        if (own) t = t.replace(own, '\n');
      }
      const remaining = clean(t);
      if (remaining.length >= 2) return remaining.length > 300 ? firstLine(t) : remaining;
    }
    return rawLabel(first);
  };

  // Custom dropdowns open on a full pointer/mouse press, like a real click.
  const press = (target: Element) => {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      target.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, button: 0, view: window }));
    }
  };
  const closeMenu = (input: HTMLElement) => {
    if (input.getAttribute('aria-expanded') === 'true') {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    }
    input.blur();
  };

  const fields: DetectedField[] = [];
  const unsupported: { label: string; reason: string }[] = [];
  const seenGroups = new Set<string>();
  let counter = 0;
  const nextId = () => `jf-${++counter}`;
  const locatorOf = (el: Element) => ({ domId: el.id || null, name: el.getAttribute('name') });

  for (const el of document.querySelectorAll<HTMLElement>('input, select, textarea')) {
    if (fields.length >= 150) break;
    const input = el as HTMLInputElement;
    if (input.disabled || input.readOnly || input.type === 'hidden') continue;

    // Radio buttons and checkboxes, grouped by name.
    if (input.type === 'radio' || input.type === 'checkbox') {
      const scope = input.form ?? document;
      const group = input.name
        ? [...scope.querySelectorAll<HTMLInputElement>(`input[type="${input.type}"][name="${CSS.escape(input.name)}"]`)]
        : [input];
      const key = `${input.type}:${input.name || `#${counter}:${Math.random()}`}`;
      if (seenGroups.has(key)) continue;
      seenGroups.add(key);
      // Custom-styled inputs are often invisible themselves; their labels aren't.
      if (!group.some((i) => isVisible(i) || (i.labels?.[0] && isVisible(i.labels[0])))) continue;
      const id = nextId();
      group.forEach((i) => i.setAttribute(ATTR, id));
      const single = input.type === 'checkbox' && group.length === 1;
      const question = single ? rawLabel(input) : groupQuestion(input, group);
      fields.push({
        id,
        label: tidyLabel(question),
        type: input.type as 'radio' | 'checkbox',
        required: group.some((i) => i.required) || hasMarker(question),
        options: group.map((i) => ({
          value: i.value || 'on',
          label: tidyLabel(firstLine(i.labels?.[0] ? visibleText(i.labels[0]) : '') || i.value).slice(0, 200),
        })),
        widget: 'native',
        locator: { domId: null, name: input.name || null },
      });
      continue;
    }

    // A custom dropdown's text box can be ~2px wide; judge it by its visible box.
    const isCombo = el.getAttribute('role') === 'combobox';
    if (!isVisible(isCombo ? (el.closest('[class*="control"]') ?? el.parentElement ?? el) : el)) continue;
    const label = rawLabel(el);

    if (input.type === 'file') {
      unsupported.push({ label: tidyLabel(label) || 'File upload', reason: 'File upload: attach it yourself.' });
      continue;
    }

    // Custom dropdowns (e.g. Greenhouse): open the menu briefly to read the options.
    if (el.getAttribute('role') === 'combobox' && el instanceof HTMLInputElement) {
      const box = el.closest<HTMLElement>('[class*="control"]') ?? el.parentElement ?? el;
      el.removeAttribute(ATTR);
      // Only the list this dropdown controls: pages can contain other, unrelated option lists.
      const readOptions = () => {
        const listId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
        const list = listId ? document.getElementById(listId) : null;
        return list
          ? [...list.querySelectorAll<HTMLElement>('[role="option"]')].map((o) => firstLine(o.innerText ?? '')).filter(Boolean).slice(0, 200)
          : [];
      };
      press(box);
      await waitUntil(() => readOptions().length > 0, 700); // usually ready within a frame or two
      const options = readOptions();
      closeMenu(el);
      await waitUntil(() => el.getAttribute('aria-expanded') !== 'true', 150);
      if (!options.length) {
        unsupported.push({ label: tidyLabel(label) || 'Search field', reason: 'Search-as-you-type field: pick a suggestion yourself.' });
        continue;
      }
      const id = nextId();
      el.setAttribute(ATTR, id);
      fields.push({
        id,
        label: tidyLabel(label),
        type: 'select',
        required: el.getAttribute('aria-required') === 'true' || hasMarker(label),
        options: [...new Set(options)].map((o) => ({ value: o, label: o })),
        widget: 'combobox',
        locator: locatorOf(el),
      });
      continue;
    }

    let type: FieldType;
    if (el instanceof HTMLTextAreaElement) type = 'textarea';
    else if (el instanceof HTMLSelectElement) type = 'select';
    else if (['text', 'search', ''].includes(input.type)) type = 'text';
    else if (['email', 'tel', 'url', 'number', 'date'].includes(input.type)) type = input.type as FieldType;
    else continue; // password, range, color, buttons...: not questions

    const id = nextId();
    el.setAttribute(ATTR, id);
    fields.push({
      id,
      label: tidyLabel(label),
      type,
      required: input.required || el.getAttribute('aria-required') === 'true' || hasMarker(label),
      options:
        el instanceof HTMLSelectElement
          ? [...el.options]
              .filter((o) => o.value !== '' && !/^(select|choose|please select)\b/i.test(clean(o.textContent)))
              .map((o) => ({ value: o.value, label: clean(o.textContent).slice(0, 200) }))
          : [],
      widget: 'native',
      locator: locatorOf(el),
    });
  }

  // Application forms embedded from another site can't be read from this page.
  const frame = [...document.querySelectorAll<HTMLIFrameElement>('iframe[src]')].find(
    (f) => isVisible(f) && /greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|myworkdayjobs\.com/i.test(f.src),
  );
  return { fields, unsupported, embeddedForm: frame ? frame.src : null };
}

/**
 * Fills tagged fields. Only changes field values (and picks options in dropdowns);
 * never clicks buttons or submits. Values the user entered themselves are kept.
 */
export async function fillFields(instructions: FillInstruction[]): Promise<FillOutcome> {
  const ATTR = 'data-jobfellow-id';
  const FILLED = 'data-jobfellow-filled'; // what Job Fellow last put in the field
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** Polls until `test()` is true (or the time is up): much faster than a fixed sleep. */
  const waitUntil = async (test: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (test()) return true;
      await sleep(30);
    }
    return test();
  };
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const firstLine = (s: string) => (s.split('\n').map((l) => l.trim()).find(Boolean) ?? '').replace(/\s+/g, ' ');

  const press = (target: Element) => {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      target.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, button: 0, view: window }));
    }
  };
  const closeMenu = (input: HTMLElement) => {
    if (input.getAttribute('aria-expanded') === 'true') {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    }
    input.blur();
  };
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
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    setter ? setter.call(el, value) : (el.value = value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const find = (i: FillInstruction): HTMLElement[] => {
    const tagged = [...document.querySelectorAll<HTMLElement>(`[${ATTR}="${CSS.escape(i.id)}"]`)];
    if (tagged.length) return tagged;
    // The page may have re-rendered the field: fall back to its id or name.
    if (i.locator.domId) {
      const byId = document.getElementById(i.locator.domId);
      if (byId) return [byId];
    }
    if (i.locator.name) return [...document.querySelectorAll<HTMLElement>(`[name="${CSS.escape(i.locator.name)}"]`)];
    return [];
  };
  /** True when the user has put their own value here (not one Job Fellow filled). */
  const userValue = (el: HTMLElement, current: string) => current.trim() !== '' && el.getAttribute(FILLED) !== current;

  const results: FillOutcome['results'] = [];
  for (const i of instructions) {
    const els = find(i);
    if (!els.length) {
      results.push({ id: i.id, status: 'not_found' });
      continue;
    }
    try {
      if (i.type === 'radio') {
        const inputs = els as HTMLInputElement[];
        const checked = inputs.find((e) => e.checked);
        // By value (as detected), then by the option's visible text, in case the page re-rendered it.
        const target =
          inputs.find((e) => (e.value || 'on') === i.value) ??
          inputs.find((e) => norm(e.labels?.[0]?.innerText ?? '') === norm(i.value ?? ''));
        if (!target) results.push({ id: i.id, status: 'no_option' });
        else if (checked && checked !== target && checked.getAttribute(FILLED) !== checked.value) results.push({ id: i.id, status: 'kept' });
        else if (target.checked) results.push({ id: i.id, status: 'unchanged' });
        else {
          target.click(); // selects it and fires the page's own handlers
          inputs.forEach((e) => e.removeAttribute(FILLED));
          target.setAttribute(FILLED, target.value);
          mark(target.closest('label') ?? target);
          results.push({ id: i.id, status: 'filled' });
        }
        continue;
      }

      if (i.type === 'checkbox') {
        const inputs = els as HTMLInputElement[];
        // Boxes the user ticked themselves mean they've answered: leave the group alone.
        if (inputs.some((e) => e.checked && !e.hasAttribute(FILLED))) {
          results.push({ id: i.id, status: 'kept' });
          continue;
        }
        let changed = false;
        for (const e of inputs) {
          const wanted = i.values.includes(e.value || 'on');
          if (e.checked !== wanted) {
            e.click();
            changed = true;
            mark(e.closest('label') ?? e);
          }
          wanted ? e.setAttribute(FILLED, e.value || 'on') : e.removeAttribute(FILLED);
        }
        results.push({ id: i.id, status: changed ? 'filled' : 'unchanged' });
        continue;
      }

      if (i.value === null) {
        results.push({ id: i.id, status: 'unchanged' });
        continue;
      }

      if (i.widget === 'combobox') {
        const input = els[0] as HTMLInputElement;
        const control = (input.closest('[class*="control"]') ?? input.parentElement ?? input) as HTMLElement;
        const container = (control.parentElement ?? control) as HTMLElement;
        const shownValue = () =>
          firstLine(container.querySelector<HTMLElement>('[class*="singleValue"], [class*="single-value"]')?.innerText ?? '');
        const shown = shownValue();
        if (shown && norm(shown) === norm(i.value)) {
          results.push({ id: i.id, status: 'unchanged' });
          continue;
        }
        if (shown && input.getAttribute(FILLED) !== norm(shown)) {
          results.push({ id: i.id, status: 'kept' });
          continue;
        }
        const findOption = () => {
          // Only this dropdown's own list (pages can contain unrelated option lists).
          const listId = input.getAttribute('aria-controls') || input.getAttribute('aria-owns');
          const list = listId ? document.getElementById(listId) : null;
          return [...(list?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])].find(
            (o) => norm(firstLine(o.innerText ?? '')) === norm(i.value!),
          );
        };
        press(control);
        await waitUntil(() => Boolean(findOption()), 600);
        let option = findOption();
        if (!option) {
          // Long lists may only show the match after typing.
          setValue(input, i.value);
          await waitUntil(() => Boolean(findOption()), 800);
          option = findOption();
        }
        if (!option) {
          setValue(input, '');
          closeMenu(input);
          results.push({ id: i.id, status: 'no_option' });
          continue;
        }
        press(option);
        await waitUntil(() => shownValue() !== '', 500);
        closeMenu(input);
        // Some dropdowns show a short form of the choice (e.g. "+1" for "United States +1").
        const after = norm(shownValue());
        if (!after || !(after === norm(i.value) || norm(i.value).includes(after) || after.includes(norm(i.value)))) {
          results.push({ id: i.id, status: 'failed' });
          continue;
        }
        input.setAttribute(FILLED, norm(i.value));
        mark(control);
        results.push({ id: i.id, status: 'filled' });
        continue;
      }

      const el = els[0] as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      if (el instanceof HTMLSelectElement) {
        const option =
          [...el.options].find((o) => o.value === i.value) ??
          [...el.options].find((o) => norm(o.textContent ?? '') === norm(i.value ?? ''));
        if (!option) {
          results.push({ id: i.id, status: 'no_option' });
          continue;
        }
        const wanted = option.value;
        // Index 0 is the page's default (often "Select…"); anything else was chosen.
        const userChose = el.selectedIndex > 0 && el.value !== '' && el.getAttribute(FILLED) !== el.value;
        if (el.value === wanted) results.push({ id: i.id, status: 'unchanged' });
        else if (userChose) results.push({ id: i.id, status: 'kept' });
        else {
          setValue(el, wanted);
          el.setAttribute(FILLED, wanted);
          mark(el);
          results.push({ id: i.id, status: 'filled' });
        }
        continue;
      }

      if (el.value === i.value) results.push({ id: i.id, status: 'unchanged' });
      else if (userValue(el, el.value)) results.push({ id: i.id, status: 'kept' });
      else {
        setValue(el, i.value);
        el.setAttribute(FILLED, i.value);
        mark(el);
        results.push({ id: i.id, status: 'filled' });
      }
    } catch {
      results.push({ id: i.id, status: 'failed' });
    }
  }

  // Follow-up questions that appeared because of the answers just filled.
  await sleep(300);
  const newFields = [...document.querySelectorAll<HTMLElement>('input, select, textarea')].filter((e) => {
    const t = (e as HTMLInputElement).type;
    if (e.hasAttribute(ATTR) || t === 'hidden' || t === 'file' || t === 'submit' || t === 'button') return false;
    if ((e as HTMLInputElement).disabled || e.closest('[aria-hidden="true"], [hidden]')) return false;
    const style = getComputedStyle(e);
    const box = e.getBoundingClientRect();
    return box.width >= 4 && box.height >= 4 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
  }).length;

  return { results, newFields };
}
