// MarkFlow — application coordinator.
import './style.css';
import 'katex/dist/katex.min.css';

import { EditorView, keymap } from '@codemirror/view';
import { Prec, StateEffect } from '@codemirror/state';
import { createEditor, setEditorText } from './editor';
import { createRenderer, postRender } from './core/renderer';
import {
  db, listDocs, createDoc, saveDoc, deleteDoc, duplicateDoc,
  addSnapshot, listSnapshots, type Doc,
} from './core/storage';
import { toast, openModal, formDialog, confirmDialog, popMenu, debounce, timeAgo, countWords } from './ui';
import { settings, saveSettings, type ViewMode, type ThemeName } from './state';
import { buildToolbar, toggleInline, insertLink, refreshToolbarContext } from './toolbar';
import { renderDocList } from './library';
import { installImageHandlers, attachmentIds } from './core/images';
import { installTablePaste } from './core/clipboard';
import { findAllTables } from './core/tables';
import { openTableEditorByIndex } from './tableEditor';
import {
  exportMarkdown, exportBackupZip, exportStandaloneHtml,
  importBackupZip, exportPdfViaPrint, printThemeLabels, slug,
  type PrintTheme,
} from './exporter';
import { WELCOME_MD } from './welcome';

// ---------------- state ----------------

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const app = $('#app');
const preview = $('#preview');
const saveStateEl = $('#saveState');
const titleInput = $('#docTitle') as HTMLInputElement;

const md = createRenderer();

let view: EditorView;
let currentDoc: Doc | null = null;
let currentText = '';
let lastSnapshotText: string | null = null;
let docs: Doc[] = [];

// ---------------- rendering ----------------

async function renderPreview(): Promise<void> {
  preview.innerHTML = md.render(currentText);
  await postRender(preview, settings.theme);
  decorateTables();
  updateStats();
}

const debouncedRender = debounce(() => { void renderPreview(); }, 120);

function updateStats(): void {
  const words = countWords(currentText);
  const mins = Math.max(1, Math.ceil(words / 200));
  $('#statusStats').textContent = `${words.toLocaleString()} words · ${currentText.length.toLocaleString()} chars · ~${mins} min read`;
}

/** Wrap preview tables in an edit affordance and wire them to the source tables. */
function decorateTables(): void {
  const tables = Array.from(preview.querySelectorAll('table'));
  if (!tables.length) return;
  const srcTables = findAllTables(currentText.split('\n'));
  // Pair preview↔source by index, but HEAL drift: verify the header signature —
  // an off-by-N pairing is how users end up editing the wrong table.
  const strip = (s: string) => s.replace(/[`*_~[\]()!#>]/g, '').trim().toLowerCase();
  tables.forEach((table, i) => {
    if (table.parentElement?.classList.contains('table-wrap')) return;
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    table.parentNode?.insertBefore(wrap, table);
    wrap.appendChild(table);
    const head0 = strip(table.querySelector('thead th, thead td, tr:first-child th, tr:first-child td')?.textContent ?? '');
    let idx = i < srcTables.length ? i : -1;
    if (idx >= 0 && head0 && strip(srcTables[idx].rows[0][0] ?? '') !== head0) {
      const exact = srcTables.findIndex((t) => strip(t.rows[0][0] ?? '') === head0);
      idx = exact >= 0 ? exact : -1;
    }
    if (idx >= 0) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'table-edit-btn';
      btn.textContent = '✎ Edit table';
      const sig = srcTables[idx].rows[0].slice(0, 3).map((s) => s.trim()).filter(Boolean).join(' · ');
      btn.title = sig ? `Edit table — ${sig}` : 'Open the visual table editor';
      const openIdx = idx;
      btn.addEventListener('click', () => openTableEditorByIndex(view, openIdx, srcTables));
      wrap.appendChild(btn);
    }
  });
}

// Preview interactions: in-preview anchor links + task list toggles.
let previewWired = false;
function wirePreviewInteractions(): void {
  if (previewWired) return;
  previewWired = true;

  preview.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest('a');
    if (a) {
      const href = a.getAttribute('href') || '';
      if (href.startsWith('#')) {
        e.preventDefault();
        const target = preview.querySelector(`[id="${CSS.escape(href.slice(1))}"]`);
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      return;
    }
    const cb = (e.target as HTMLElement).closest('input[type="checkbox"]') as HTMLInputElement | null;
    if (cb && cb.closest('.task-list-item')) {
      e.preventDefault();
      toggleTaskAtIndex(taskIndexOf(cb));
    }
  });
}

function taskIndexOf(cb: HTMLInputElement): number {
  const boxes = Array.from(preview.querySelectorAll('.task-list-item input[type="checkbox"]'));
  return boxes.indexOf(cb);
}

/** Flip the nth task-list checkbox in the source markdown. */
function toggleTaskAtIndex(n: number): void {
  if (n < 0) return;
  const doc = view.state.doc;
  let seen = -1;
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const m = /^(\s*[-*+]\s+\[)([ xX])(\]\s+)/.exec(line.text);
    if (!m) continue;
    seen++;
    if (seen === n) {
      const markAt = line.from + m[1].length;
      const next = m[2] === ' ' ? 'x' : ' ';
      view.dispatch({ changes: { from: markAt, to: markAt + 1, insert: String(next) } });
      return;
    }
  }
}

// ---------------- autosave & snapshots ----------------

const saveState = {
  set(msg: string, dirty = false) {
    saveStateEl.textContent = msg;
    saveStateEl.classList.toggle('dirty', dirty);
  },
};

const debouncedSave = debounce(async () => {
  if (!currentDoc) return;
  currentDoc.content = currentText;
  currentDoc.title = titleInput.value.trim() || 'Untitled';
  await saveDoc(currentDoc);
  saveState.set('Saved ✓');
  refreshDocList();
}, 650);

async function takeSnapshot(label: string): Promise<void> {
  if (!currentDoc) return;
  if (currentText === lastSnapshotText) { toast('Nothing new to snapshot.', 'info'); return; }
  await addSnapshot(currentDoc.id, label, currentText, countWords(currentText));
  lastSnapshotText = currentText;
  toast(`Snapshot “${label}” pinned to history.`, 'ok');
}

// every 3 minutes: quiet auto-snapshot when content changed
setInterval(() => {
  if (currentDoc && currentText !== lastSnapshotText && currentText.trim()) {
    void addSnapshot(currentDoc.id, 'auto', currentText, countWords(currentText));
    lastSnapshotText = currentText;
  }
}, 3 * 60 * 1000);

// ---------------- document switching ----------------

async function loadDoc(doc: Doc): Promise<void> {
  currentDoc = doc;
  currentText = doc.content;
  lastSnapshotText = null;
  titleInput.value = doc.title;
  setEditorText(view, currentText);
  saveState.set('Saved ✓');
  refreshDocList();
  await renderPreview();
  view.focus();
}

async function createAndLoad(): Promise<void> {
  const doc = await createDoc('Untitled', '# Untitled\n\nStart writing…\n');
  docs = await listDocs();
  await loadDoc(doc);
  titleInput.focus();
  titleInput.select();
}

function refreshDocList(): void {
  renderDocList($('#docList'), docs, currentDoc?.id ?? '', ($('#docSearch') as HTMLInputElement).value, {
    onSelect: (doc) => { if (doc.id !== currentDoc?.id) void loadDoc(doc); },
    onRename: (doc) => {
      formDialog({
        title: 'Rename document',
        submitLabel: 'Rename',
        fields: [{ key: 'title', label: 'Title', value: doc.title }],
        onSubmit: async ({ title }) => {
          doc.title = title.trim() || 'Untitled';
          await saveDoc(doc);
          if (doc.id === currentDoc?.id) titleInput.value = doc.title;
          refreshDocList();
        },
      });
    },
    onDuplicate: async (doc) => {
      await duplicateDoc(doc);
      docs = await listDocs();
      refreshDocList();
      toast('Document duplicated.', 'ok');
    },
    onDelete: async (doc) => {
      const ok = await confirmDialog('Delete document', `Delete “${doc.title}” and its snapshots? This cannot be undone.`, 'Delete');
      if (!ok) return;
      await deleteDoc(doc.id);
      docs = await listDocs();
      if (doc.id === currentDoc?.id) {
        if (docs.length) await loadDoc(docs[0]);
        else await createAndLoad();
      } else {
        refreshDocList();
      }
      toast('Document deleted.', 'info');
    },
  });
}

// ---------------- history ----------------

function openHistory(): void {
  if (!currentDoc) return;
  void listSnapshots(currentDoc.id).then((snaps) => {
    const wrap = document.createElement('div');
    if (!snaps.length) {
      wrap.innerHTML = '<p class="muted-note">No snapshots yet. Press <b>Ctrl+S</b> to pin the current version, or let auto-snapshots accumulate as you write.</p>';
    }
    for (const snap of snaps) {
      const item = document.createElement('div');
      item.className = 'history-item';
      const meta = document.createElement('div');
      meta.className = 'hi-meta';
      const when = new Date(snap.ts);
      meta.innerHTML = `<div class="hi-label">${snap.label === 'auto' ? '⏱ Auto-snapshot' : '📌 ' + escapeHtml(snap.label)}</div>
        <div class="hi-time">${when.toLocaleString()} · ${snap.words.toLocaleString()} words · ${timeAgo(snap.ts)}</div>`;
      const restore = document.createElement('button');
      restore.className = 'btn small primary';
      restore.textContent = 'Restore';
      restore.addEventListener('click', async () => {
        await addSnapshot(currentDoc!.id, 'pre-restore', currentText, countWords(currentText));
        handle.close();
        await loadDoc({ ...currentDoc!, content: snap.content });
        toast(`Restored version from ${when.toLocaleTimeString()}.`, 'ok');
      });
      const dl = document.createElement('button');
      dl.className = 'btn small ghost';
      dl.textContent = '.md';
      dl.title = 'Download this version';
      dl.addEventListener('click', () => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([snap.content], { type: 'text/markdown' }));
        a.download = `${slug(currentDoc!.title)}-${when.toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md`;
        a.click();
      });
      item.append(meta, dl, restore);
      wrap.appendChild(item);
    }
    const handle = openModal({ title: `History — ${currentDoc!.title}`, body: wrap });
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

// ---------------- settings & shortcuts modals ----------------

function openSettings(): void {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <label class="field-check"><input type="checkbox" id="setHtml" ${settings.renderHtml ? 'checked' : ''}>
      Render inline HTML in preview <span class="muted-note">(off = portable &amp; safe — recommended)</span></label>
    <label class="field-check"><input type="checkbox" id="setBreaks" ${settings.lineBreaks ? 'checked' : ''}>
      Render single newlines as line breaks <span class="muted-note">(turn OFF for exact GitHub parity)</span></label>
    <p class="muted-note">These change only how <i>your preview</i> renders — your Markdown source is never altered.</p>`;
  openModal({ title: 'Preview & portability', body: wrap });
  wrap.querySelector('#setHtml')!.addEventListener('change', (e) => {
    settings.renderHtml = (e.target as HTMLInputElement).checked;
    md.options.html = settings.renderHtml;
    saveSettings();
    void renderPreview();
  });
  wrap.querySelector('#setBreaks')!.addEventListener('change', (e) => {
    settings.lineBreaks = (e.target as HTMLInputElement).checked;
    md.options.breaks = settings.lineBreaks;
    saveSettings();
    void renderPreview();
  });
}

function openShortcuts(): void {
  const rows: [string, string][] = [
    ['Ctrl / Cmd + B', 'Bold'], ['Ctrl / Cmd + I', 'Italic'], ['Ctrl / Cmd + E', 'Inline code'],
    ['Ctrl / Cmd + K', 'Insert link'], ['Ctrl / Cmd + S', 'Pin snapshot to history'],
    ['Ctrl / Cmd + F', 'Find & replace'], ['Ctrl / Cmd + Z', 'Undo'], ['Ctrl / Cmd + Shift + Z', 'Redo'],
    ['Ctrl / Cmd + /', 'This shortcut list'],
  ];
  const wrap = document.createElement('div');
  wrap.className = 'kbd-list';
  for (const [k, desc] of rows) {
    const kd = document.createElement('kbd'); kd.textContent = k;
    const d = document.createElement('span'); d.textContent = desc;
    wrap.append(kd, d);
  }
  const note = document.createElement('p');
  note.className = 'muted-note';
  note.textContent = 'Paste or drop images directly into the editor. Paste Excel/Sheets ranges into the table editor.';
  const box = document.createElement('div');
  box.append(wrap, note);
  openModal({ title: 'Keyboard shortcuts', body: box });
}

// ---------------- top bar wiring ----------------

function setMode(mode: ViewMode): void {
  settings.mode = mode;
  app.dataset.mode = mode;
  document.querySelectorAll('.mode-switch button').forEach((b) => {
    b.classList.toggle('active', (b as HTMLElement).dataset.mode === mode);
  });
  saveSettings();
  if (mode !== 'source') void renderPreview();
}

function setTheme(theme: ThemeName): void {
  settings.theme = theme;
  document.documentElement.dataset.theme = theme;
  saveSettings();
}

function wireTopBar(): void {
  document.querySelectorAll('.mode-switch button').forEach((b) => {
    b.addEventListener('click', () => setMode((b as HTMLElement).dataset.mode as ViewMode));
  });
  $('#themeToggle').addEventListener('click', () => setTheme(settings.theme === 'dark' ? 'light' : 'dark'));
  $('#sidebarToggle').addEventListener('click', () => {
    settings.sidebarOpen = !settings.sidebarOpen;
    $('#sidebar').classList.toggle('hidden', !settings.sidebarOpen);
    saveSettings();
  });
  titleInput.addEventListener('input', () => { saveState.set('Editing…', true); debouncedSave(); });
  $('#newDocBtn').addEventListener('click', () => { void createAndLoad(); });
  $('#docSearch').addEventListener('input', refreshDocList);
  $('#historyBtn').addEventListener('click', openHistory);
  $('#downloadAllBtn').addEventListener('click', async () => {
    await exportBackupZip(await listDocs());
  });
  const backupInput = $('#backupFileInput') as HTMLInputElement;
  $('#importBackupBtn').addEventListener('click', () => backupInput.click());
  backupInput.addEventListener('change', async () => {
    const file = backupInput.files?.[0];
    backupInput.value = '';
    if (!file) return;
    try {
      const result = await importBackupZip(file);
      docs = await listDocs();
      refreshDocList();
      toast(`Imported ${result.documents} document(s), ${result.snapshots} snapshot(s), and ${result.assets} attachment(s).${result.missingAssets ? ` ${result.missingAssets} attachment reference(s) were missing.` : ''}`, result.missingAssets ? 'info' : 'ok', 5200);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not import this backup.', 'err', 5200);
    }
  });
  $('#shortcutsBtn').addEventListener('click', openShortcuts);

  $('#exportBtn').addEventListener('click', (e) => {
    const btn = e.currentTarget as HTMLElement;
    const hasAssets = attachmentIds(currentText).length > 0;
    popMenu(btn, [
      {
        label: hasAssets ? 'Markdown (.zip with images)' : 'Markdown (.md)',
        onClick: () => void exportMarkdown({ ...currentDoc!, content: currentText }),
      },
      { label: 'Standalone HTML (images embedded)', onClick: () => void exportStandaloneHtml(currentDoc?.title || 'document', preview.innerHTML) },
      ...printThemeLabels().map((t) => ({
        label: `PDF — ${t.label}`,
        onClick: () => void exportPdfViaPrint(preview.innerHTML, { title: currentDoc?.title || 'document', theme: t.key as PrintTheme, toc: false }),
      })),
    ], 'PDF = browser print → Save as PDF');
  });
}

// ---------------- boot ----------------

async function boot(): Promise<void> {
  document.documentElement.dataset.theme = settings.theme;
  app.dataset.mode = settings.mode;
  $('#sidebar').classList.toggle('hidden', !settings.sidebarOpen);
  document.querySelectorAll('.mode-switch button').forEach((b) => {
    b.classList.toggle('active', (b as HTMLElement).dataset.mode === settings.mode);
  });

  docs = await listDocs();
  if (!docs.length) {
    const welcome = await createDoc('Welcome to MarkFlow', WELCOME_MD);
    docs = [welcome];
  }

  view = createEditor($('#editorPane'), docs[0].content, {
    onChange: (text) => {
      currentText = text;
      saveState.set('Editing…', true);
      debouncedSave();
      if (settings.mode !== 'source') debouncedRender();
    },
    onCursor: (line, col) => {
      $('#statusCursor').textContent = `Ln ${line}, Col ${col}`;
      refreshToolbarContext(view); // ctx rules + active-formatting highlight, per selection change
    },
    onSave: () => { void takeSnapshot(new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })); },
    onScroll: (fraction) => {
      if (settings.mode !== 'split') return;
      const el = $('#previewPane');
      el.scrollTop = fraction * (el.scrollHeight - el.clientHeight);
    },
  });

  // formatting keyboard shortcuts (registered post-construction)
  view.dispatch({
    effects: StateEffect.appendConfig.of(Prec.high(keymap.of([
      { key: 'Mod-b', run: () => { toggleInline(view, '**'); return true; } },
      { key: 'Mod-i', run: () => { toggleInline(view, '*'); return true; } },
      { key: 'Mod-e', run: () => { toggleInline(view, '`'); return true; } },
      { key: 'Mod-k', run: () => { insertLink(view); return true; } },
    ]))),
  });

  installImageHandlers(view.dom, (text) => {
    const { from, to } = view.state.selection.main;
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
    view.focus();
  });
  installTablePaste(view.dom, view);

  buildToolbar(view, openSettings);
  refreshToolbarContext(view);
  wireTopBar();
  wirePreviewInteractions();

  currentDoc = docs[0];
  currentText = docs[0].content;
  titleInput.value = docs[0].title;
  refreshDocList();
  await renderPreview();

  // global shortcuts not tied to editor focus
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    if (e.key === '/') { e.preventDefault(); openShortcuts(); }
    if (e.key.toLowerCase() === 's' && document.activeElement !== view.contentDOM) {
      e.preventDefault(); void takeSnapshot(new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }));
    }
  });
}

void boot();
