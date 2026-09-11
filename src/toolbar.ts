// Toolbar + formatting commands operating on the CodeMirror document.
import { EditorView } from '@codemirror/view';
import { undo, redo } from '@codemirror/commands';
import type { ChangeSpec } from '@codemirror/state';
import { formDialog, toast } from './ui';
import { findAllTables, serializeTable, newTable, findTableAtLine, fenceMask } from './core/tables';
import { getInlineMarkState, toggleInlineMarkup, type InlineMarker } from './core/inlineFormatting';
import { openTableEditorAtCursor } from './tableEditor';
import { insertAtCursor, openSearch } from './editor';
import { ingestImageFile } from './core/images';

// ---------------- inline & line command helpers ----------------

/** Toggle a semantic inline mark without disturbing other marks in the range. */
export function toggleInline(view: EditorView, marker: string): void {
  const { from, to } = view.state.selection.main;
  const source = view.state.doc.toString();

  if (from === to) {
    const insert = `${marker}text${marker}`;
    view.dispatch({
      changes: { from, insert },
      selection: { anchor: from + marker.length, head: from + marker.length + 4 },
      scrollIntoView: true,
    });
    view.focus();
    return;
  }

  const result = toggleInlineMarkup(source, from, to, marker as InlineMarker, { scope: 'selection' });
  if (!result.changed) return;
  view.dispatch({
    changes: { from: 0, to: source.length, insert: result.next },
    selection: { anchor: result.selectionStart, head: result.selectionEnd },
  });
  view.focus();
}

function forEachSelectedLine(view: EditorView, transform: (lineText: string, lineIndex: number) => string): void {
  const { from, to } = view.state.selection.main;
  const doc = view.state.doc;
  const startLine = doc.lineAt(from);
  const endLine = doc.lineAt(to);
  const changes: ChangeSpec[] = [];
  let idx = 0;
  for (let pos = startLine.from; pos <= endLine.to;) {
    const line = doc.lineAt(pos);
    const next = transform(line.text, idx++);
    if (next !== line.text) changes.push({ from: line.from, to: line.to, insert: next });
    pos = line.to + 1;
  }
  if (changes.length) view.dispatch({ changes });
  view.focus();
}

function setHeading(view: EditorView, level: number): void {
  forEachSelectedLine(view, (text) => {
    const stripped = text.replace(/^\s*#{1,6}\s+/, '');
    const current = /^\s*(#{1,6})\s+/.exec(text)?.[1].length ?? 0;
    if (current === level) return stripped; // toggle off
    return '#'.repeat(level) + ' ' + stripped;
  });
}

function togglePrefix(view: EditorView, kind: 'quote' | 'ul' | 'ol' | 'task'): void {
  const stripRe = /^\s*(?:>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/;
  forEachSelectedLine(view, (text, i) => {
    if (!text.trim()) return text;
    const stripped = text.replace(stripRe, '');
    switch (kind) {
      case 'quote':
        return /^\s*>/.test(text) ? stripped : `> ${stripped}`;
      case 'ul':
        return /^\s*[-*+]\s+(?!\[)/.test(text) ? stripped : `- ${stripped}`;
      case 'task':
        return /^\s*[-*+]\s+\[/.test(text) ? stripped : `- [ ] ${stripped}`;
      case 'ol':
        return /^\s*\d+[.)]\s+/.test(text) ? stripped : `${i + 1}. ${stripped}`;
    }
  });
}

function insertCodeBlock(view: EditorView): void {
  const { from, to } = view.state.selection.main;
  const sel = view.state.sliceDoc(from, to) || 'code';
  const needsNLBefore = from > 0 && view.state.sliceDoc(from - 1, from) !== '\n';
  const insert = `${needsNLBefore ? '\n' : ''}\`\`\`\n${sel}\n\`\`\`\n`;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length },
    scrollIntoView: true,
  });
  view.focus();
}

function insertRule(view: EditorView): void {
  insertAtCursor(view, '\n---\n');
}

export function insertLink(view: EditorView): void {
  const { from, to } = view.state.selection.main;
  const sel = view.state.sliceDoc(from, to);
  formDialog({
    title: 'Insert link',
    submitLabel: 'Insert link',
    fields: [
      { key: 'text', label: 'Link text', placeholder: 'Read the docs', value: sel },
      { key: 'url', label: 'URL', type: 'url', placeholder: 'https://example.com' },
    ],
    onSubmit: ({ text, url }) => {
      if (!url) return;
      const safe = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      insertAtCursor(view, `[${text || safe}](${safe})`);
    },
  });
}

function insertImageUrl(view: EditorView): void {
  formDialog({
    title: 'Insert image from URL',
    submitLabel: 'Insert image',
    fields: [
      { key: 'alt', label: 'Alt text', placeholder: 'Architecture diagram' },
      { key: 'url', label: 'Image URL', type: 'url', placeholder: 'https://example.com/diagram.png' },
    ],
    onSubmit: ({ alt, url }) => {
      if (!url) return;
      const safe = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      insertAtCursor(view, `![${alt || 'image'}](${safe})`);
    },
  });
}

function insertImageUpload(view: EditorView): void {
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'image/*';
  picker.multiple = true;
  picker.addEventListener('change', async () => {
    for (const file of Array.from(picker.files || [])) {
      const md = await ingestImageFile(file);
      if (md) insertAtCursor(view, md + '\n');
    }
  });
  picker.click();
}

function alignAllTables(view: EditorView): void {
  const text = view.state.doc.toString();
  const lines = text.split('\n');
  const tables = findAllTables(lines);
  if (!tables.length) { toast('No tables found in this document.', 'info'); return; }
  const changes: ChangeSpec[] = [];
  for (const t of tables) {
    const fromLine = view.state.doc.line(t.startLine + 1);
    const toLine = view.state.doc.line(t.endLine + 1);
    changes.push({ from: fromLine.from, to: toLine.to, insert: serializeTable(t.rows, t.aligns) });
  }
  view.dispatch({ changes });
  toast(`Aligned ${tables.length} table${tables.length > 1 ? 's' : ''} — markdown is now diff-friendly.`, 'ok');
}

// ---------------- toolbar DOM ----------------

interface TBtn {
  label: string;
  title: string;
  html?: string;
  run: (view: EditorView, el: HTMLElement) => void;
  sourceOnly?: boolean;
  /** Context rule: where this action makes sense. tableOnly = only inside tables. */
  when?: { table?: boolean; code?: boolean; tableOnly?: boolean };
}

function btn(label: string, title: string, run: (v: EditorView, el: HTMLElement) => void, html?: string, sourceOnly = true, when?: TBtn['when']): TBtn {
  return { label, title, run, html, sourceOnly, when };
}

// ---------------- context awareness (#5) ----------------

export type EditorContext = 'text' | 'table' | 'code';

/** What syntactic construct contains the cursor? Drives toolbar enable/disable. */
export function detectContext(view: EditorView): EditorContext {
  const doc = view.state.doc;
  const lineNo = doc.lineAt(view.state.selection.main.head).number - 1;
  const lines = doc.toString().split('\n');
  const fenced = fenceMask(lines);
  if (fenced[lineNo]) return 'code';
  if (findTableAtLine(lines, lineNo)) return 'table';
  return 'text';
}

/**
 * Dim + explain buttons that don't apply at the cursor, AND highlight the
 * formatting that's currently active around the selection (#3) — so users can
 * see "this text is already bold" instead of blindly stacking markers.
 */
export function refreshToolbarContext(view: EditorView): void {
  const doc = view.state.doc;
  const ctx = detectContext(view);
  document.querySelectorAll<HTMLButtonElement>('#toolbar .tbtn[data-when]').forEach((el) => {
    const allowTable = el.dataset.whenTable !== '0';
    const allowCode = el.dataset.whenCode !== '0';
    const tableOnly = el.dataset.tableOnly === '1';
    let enabled = true;
    let reason = '';
    if (ctx === 'code' && !allowCode) { enabled = false; reason = 'not available inside a code block'; }
    else if (ctx === 'table' && !allowTable) { enabled = false; reason = 'not valid in a Markdown table cell'; }
    else if (ctx !== 'table' && tableOnly) { enabled = false; reason = 'place the cursor inside a table first'; }
    el.disabled = !enabled;
    el.classList.toggle('ctx-disabled', !enabled);
    el.title = enabled ? (el.dataset.titleBase || '') : `${el.dataset.titleBase} — ${reason}`;
  });

  // --- active formatting states (#3) ---
  const { from, to } = view.state.selection.main;
  const ds = doc.toString();
  const markActive = (titlePrefix: string, marker: InlineMarker) => {
    const el = [...document.querySelectorAll<HTMLButtonElement>('#toolbar .tbtn')].find((x) => (x.dataset.titleBase || '').startsWith(titlePrefix));
    if (!el) return;
    const state = getInlineMarkState(ds, from, to, 'selection', marker);
    el.classList.toggle('active', state === 'active');
    el.classList.toggle('mixed', state === 'mixed');
  };
  markActive('Bold', '**');
  markActive('Italic', '*');
  markActive('Strikethrough', '~~');
  markActive('Inline code', '`');

  const lineText = doc.lineAt(view.state.selection.main.head).text;
  const trimmed = lineText.trimStart();
  const heading = /^(#{1,6})\s+/.exec(trimmed)?.[1].length ?? 0;
  const markLineActive = (titlePrefix: string, on: boolean) => {
    const el = [...document.querySelectorAll<HTMLButtonElement>('#toolbar .tbtn')].find((x) => (x.dataset.titleBase || '').startsWith(titlePrefix));
    if (el) { el.classList.toggle('active', on); el.classList.remove('mixed'); }
  };
  markLineActive('Heading 1', heading === 1);
  markLineActive('Heading 2', heading === 2);
  markLineActive('Heading 3', heading === 3);
  markLineActive('Blockquote', trimmed.startsWith('>'));
  markLineActive('Bulleted list', /^[-*+]\s+(?!\[)/.test(trimmed));
  markLineActive('Numbered list', /^\d+[.)]\s+/.test(trimmed));
  markLineActive('Task list', /^[-*+]\s+\[/.test(trimmed));
}

export function buildToolbar(view: EditorView, onOpenSettings: () => void): void {
  const bar = document.getElementById('toolbar')!;
  bar.innerHTML = '';

  const groups: (TBtn | 'sep')[] = [
    btn('B', 'Bold — Ctrl+B', (v) => toggleInline(v, '**'), '<b>B</b>', true, { code: false }),
    btn('I', 'Italic — Ctrl+I', (v) => toggleInline(v, '*'), '<i>I</i>', true, { code: false }),
    btn('S', 'Strikethrough', (v) => toggleInline(v, '~~'), '<s>S</s>', true, { code: false }),
    btn('Code', 'Inline code — Ctrl+E', (v) => toggleInline(v, '`'), '<span style="font-family:var(--font-mono)">&lt;/&gt;</span>', true, { code: false }),
    'sep',
    btn('H1', 'Heading 1', (v) => setHeading(v, 1), 'H1', true, { table: false, code: false }),
    btn('H2', 'Heading 2', (v) => setHeading(v, 2), 'H2', true, { table: false, code: false }),
    btn('H3', 'Heading 3', (v) => setHeading(v, 3), 'H3', true, { table: false, code: false }),
    'sep',
    btn('Link', 'Insert link — Ctrl+K', insertLink, '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M6.5 9.5a3 3 0 0 0 4.2.3l2-2a3 3 0 0 0-4.2-4.2l-.8.8M9.5 6.5a3 3 0 0 0-4.2-.3l-2 2a3 3 0 0 0 4.2 4.2l.8-.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/></svg>', true, { code: false }),
    btn('Image URL', 'Insert image from link', insertImageUrl, '<svg viewBox="0 0 16 16" width="14" height="14"><rect x="1.6" y="2.6" width="12.8" height="10.8" rx="2" stroke="currentColor" stroke-width="1.3" fill="none"/><circle cx="5.4" cy="6.4" r="1.4" fill="currentColor"/><path d="m3 12.6 3.4-3.4 2.2 2.2 2-2 2.4 2.4" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" fill="none"/></svg>', true, { code: false }),
    btn('Upload', 'Upload image (stored locally in your browser)', insertImageUpload, '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M8 10.5V3m0 0L5.2 5.8M8 3l2.8 2.8M2.5 11v1.5A1.5 1.5 0 0 0 4 14h8a1.5 1.5 0 0 0 1.5-1.5V11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>', true, { code: false }),
    'sep',
    btn('Quote', 'Blockquote', (v) => togglePrefix(v, 'quote'), '❝', true, { table: false, code: false }),
    btn('• List', 'Bulleted list', (v) => togglePrefix(v, 'ul'), '•', true, { table: false, code: false }),
    btn('1. List', 'Numbered list', (v) => togglePrefix(v, 'ol'), '1.', true, { table: false, code: false }),
    btn('☑ Task', 'Task list (checkboxes)', (v) => togglePrefix(v, 'task'), '☑', true, { table: false, code: false }),
    btn('Code block', 'Fenced code block', insertCodeBlock, '{ }', true, { table: false, code: false }),
    btn('HR', 'Horizontal rule', insertRule, '―', true, { table: false, code: false }),
    'sep',
    btn('＋Table', 'Insert table — pick a size', (v, el) => { void import('./tableEditor').then((m) => m.showTableSizePicker(el, (cols, rows) => m.openTableEditorFresh(v, cols, rows))); }, '⊞', true, { table: false, code: false }),
    btn('✎ Table', 'Edit the table under the cursor', (v) => { if (!openTableEditorAtCursor(v)) toast('Place the cursor inside a Markdown table first.', 'info'); }, undefined, true, { tableOnly: true, code: false }),
    btn('Align', 'Re-format every table with aligned pipes (diff-friendly)', alignAllTables, '≡'),
    'sep',
    btn('Undo', 'Undo — Ctrl+Z', (v) => { undo(v); }, '↩'),
    btn('Redo', 'Redo — Ctrl+Shift+Z', (v) => { redo(v); }, '↪'),
  ];

  for (const item of groups) {
    if (item === 'sep') {
      const s = document.createElement('span');
      s.className = 'tsep';
      bar.appendChild(s);
      continue;
    }
    const b = document.createElement('button');
    b.className = 'tbtn' + (item.sourceOnly ? ' source-only' : '');
    b.type = 'button';
    b.title = item.title;
    b.setAttribute('aria-label', item.title);
    b.dataset.titleBase = item.title;
    if (item.when) {
      b.dataset.when = '1';
      if (item.when.table === false) b.dataset.whenTable = '0';
      if (item.when.code === false) b.dataset.whenCode = '0';
      if (item.when.tableOnly) b.dataset.tableOnly = '1';
    }
    if (item.html) b.innerHTML = item.html; else b.textContent = item.label;
    b.addEventListener('mousedown', (e) => e.preventDefault()); // keep editor focus
    b.addEventListener('click', () => item.run(view, b));
    bar.appendChild(b);
  }

  // right side: search + preview settings
  const grow = document.createElement('span');
  grow.className = 'tgrow';
  bar.appendChild(grow);

  const search = document.createElement('button');
  search.className = 'tbtn source-only';
  search.type = 'button';
  search.title = 'Find / replace — Ctrl+F';
  search.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="7" cy="7" r="4.4" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="m10.4 10.4 3.1 3.1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  search.addEventListener('mousedown', (e) => e.preventDefault());
  search.addEventListener('click', () => openSearch(view));
  bar.appendChild(search);

  const settingsBtn = document.createElement('button');
  settingsBtn.className = 'tbtn';
  settingsBtn.type = 'button';
  settingsBtn.title = 'Preview & portability settings';
  settingsBtn.innerHTML = '<svg viewBox="0 0 16 16" width="15" height="15"><circle cx="8" cy="8" r="2.1" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
  settingsBtn.addEventListener('click', onOpenSettings);
  bar.appendChild(settingsBtn);
}
