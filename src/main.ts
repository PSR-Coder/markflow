// MarkFlow — application coordinator.
import './style.css';
import 'katex/dist/katex.min.css';

import { EditorView, keymap } from '@codemirror/view';
import { Prec, StateEffect } from '@codemirror/state';
import { createEditor, setEditorText } from './editor';
import { createRenderer, postRender } from './core/renderer';
import {
  listDocs, createDoc, saveDoc, deleteDoc, duplicateDoc, deleteAssets, listOrphanAssets,
  addSnapshot, listSnapshots, getStorageHealth, requestPersistentStorage, getAsset, type Doc,
} from './core/storage';
import { toast, openModal, formDialog, confirmDialog, popMenu, debounce, timeAgo, countWords } from './ui';
import { settings, saveSettings, type ViewMode, type ThemeName } from './state';
import { buildToolbar, toggleInline, insertLink, refreshToolbarContext } from './toolbar';
import { renderDocList } from './library';
import { installImageHandlers, attachmentIds, releaseAssetUrls } from './core/images';
import { installTablePaste } from './core/clipboard';
import { findAllTables } from './core/tables';
import { analyzeMarkdown, type MarkdownDiagnostic } from './core/diagnostics';
import { openTableEditorByIndex } from './tableEditor';
import {
  exportMarkdown, exportBackupZip, exportStandaloneHtml,
  importBackupZip, exportPdfViaPrint, printThemeLabels, slug,
  type PrintTheme,
} from './exporter';
import { WELCOME_MD } from './welcome';
import { parsePendingSaves, removePendingSave, serializePendingSaves, upsertPendingSave, type PendingSaveDraft } from './core/saveRecovery';
import { installPwaLifecycle } from './core/pwa';

// ---------------- state ----------------

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const app = $('#app');
const preview = $('#preview');
const saveStateEl = $('#saveState');
const titleInput = $('#docTitle') as HTMLInputElement;
const saveRetryBtn = $('#saveRetryBtn') as HTMLButtonElement;
const connectivityStatus = $('#connectivityStatus');
const pwaStatus = $('#pwaStatus');

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

let saveRetryPending = false;
let snapshotFailureNotified = false;
const PENDING_SAVE_KEY = 'mf-pending-saves';

function readPendingSaves(): PendingSaveDraft[] {
  try {
    return parsePendingSaves(localStorage.getItem(PENDING_SAVE_KEY));
  } catch {
    return [];
  }
}

function writePendingSave(): void {
  if (!currentDoc) return;
  try {
    const draft: PendingSaveDraft = {
      docId: currentDoc.id,
      title: titleInput.value.trim() || 'Untitled',
      content: currentText,
      savedAt: Date.now(),
    };
    localStorage.setItem(PENDING_SAVE_KEY, serializePendingSaves(upsertPendingSave(readPendingSaves(), draft)));
  } catch {
    // The visible save error still protects the current editor session when
    // localStorage is unavailable or full.
  }
}

function clearPendingSave(docId = currentDoc?.id): void {
  if (!docId) return;
  try {
    const next = removePendingSave(readPendingSaves(), docId);
    if (next.length) localStorage.setItem(PENDING_SAVE_KEY, serializePendingSaves(next));
    else localStorage.removeItem(PENDING_SAVE_KEY);
  } catch { /* storage may be unavailable */ }
}

function describeSaveError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /quota|storage|space|full/i.test(message) || (error instanceof DOMException && error.name === 'QuotaExceededError')
    ? 'Storage full — free browser space, then retry'
    : 'Save failed — retry';
}

async function persistCurrentDoc(): Promise<void> {
  if (!currentDoc) return;
  currentDoc.content = currentText;
  currentDoc.title = titleInput.value.trim() || 'Untitled';
  try {
    await saveDoc(currentDoc);
    saveRetryPending = false;
    clearPendingSave();
    saveRetryBtn.hidden = true;
    saveState.set('Saved ✓');
    refreshDocList();
  } catch (error) {
    saveRetryPending = true;
    writePendingSave();
    saveRetryBtn.hidden = false;
    saveState.set(describeSaveError(error), true);
    toast(`${describeSaveError(error)}. Your current text remains in the editor.`, 'err', 5200);
  }
}


async function offerPendingSaveRecovery(): Promise<void> {
  const draft = readPendingSaves().find((item) => item.docId === currentDoc?.id)
    ?? readPendingSaves()[0];
  if (!draft || !currentDoc) return;
  if (draft.docId === currentDoc.id && draft.content === currentText) {
    clearPendingSave();
    return;
  }
  const body = document.createElement('p');
  body.className = 'muted-note';
  body.textContent = draft.docId === currentDoc.id
    ? `MarkFlow found unsaved changes for “${draft.title}” from ${new Date(draft.savedAt).toLocaleString()}. Restore them into the current document?`
    : `MarkFlow found unsaved changes for “${draft.title}” from ${new Date(draft.savedAt).toLocaleString()}. Create a recovered copy?`;
  const keep = document.createElement('button');
  keep.type = 'button';
  keep.className = 'btn ghost';
  keep.textContent = 'Keep current';
  const restore = document.createElement('button');
  restore.type = 'button';
  restore.className = 'btn primary';
  restore.textContent = draft.docId === currentDoc.id ? 'Restore changes' : 'Create recovered copy';
  const handle = openModal({ title: 'Unsaved changes found', body, foot: [keep, restore] });
  keep.addEventListener('click', () => { clearPendingSave(); handle.close(); });
  restore.addEventListener('click', async () => {
    clearPendingSave();
    if (draft.docId === currentDoc!.id) {
      await loadDoc({ ...currentDoc!, content: draft.content, title: draft.title });
      await persistCurrentDoc();
    } else {
      const recovered = await createDoc(`${draft.title} (Recovered)`, draft.content);
      docs = await listDocs();
      await loadDoc(recovered);
    }
    handle.close();
    toast('Unsaved changes restored.', 'ok');
  });
}
const debouncedSave = debounce(() => { void persistCurrentDoc(); }, 650);

function updateConnectivity(): void {
  const offline = !navigator.onLine;
  connectivityStatus.textContent = offline ? 'Offline — local only' : '';
  connectivityStatus.classList.toggle('offline', offline);
  connectivityStatus.title = offline ? 'The network is unavailable. MarkFlow continues using local storage.' : '';
  if (!offline && saveRetryPending) void persistCurrentDoc();
}

function updatePwaStatus(message: string): void {
  pwaStatus.textContent = message;
  pwaStatus.classList.toggle('warning', /unavailable|failed/i.test(message));
}

async function takeSnapshot(label: string, notify = true): Promise<void> {
  if (!currentDoc) return;
  if (currentText === lastSnapshotText) {
    if (notify) toast('Nothing new to snapshot.', 'info');
    return;
  }
  try {
    await addSnapshot(currentDoc.id, label, currentText, countWords(currentText));
    lastSnapshotText = currentText;
    snapshotFailureNotified = false;
    if (notify) toast(`Snapshot “${label}” pinned to history.`, 'ok');
  } catch (error) {
    if (notify || !snapshotFailureNotified) {
      toast(`Could not save snapshot: ${describeSaveError(error)}.`, 'err', 5200);
      snapshotFailureNotified = true;
    }
  }
}

// every 3 minutes: quiet auto-snapshot when content changed
setInterval(() => {
  if (currentDoc && currentText !== lastSnapshotText && currentText.trim()) {
    void takeSnapshot('auto', false);
  }
}, 3 * 60 * 1000);

// ---------------- document switching ----------------

async function loadDoc(doc: Doc): Promise<void> {
  currentDoc = doc;
  currentText = doc.content;
  lastSnapshotText = currentText;
  snapshotFailureNotified = false;
  saveRetryPending = false;
  saveRetryBtn.hidden = true;
  titleInput.value = doc.title;
  setEditorText(view, currentText);
  saveState.set('Saved ✓');
  refreshDocList();
  await renderPreview();
  view.focus();
  void offerPendingSaveRecovery();
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

function openAssetManager(): void {
  void listOrphanAssets(currentText ? [currentText] : []).then((assets) => {
    const body = document.createElement('div');
    if (!assets.length) {
      const note = document.createElement('p');
      note.className = 'muted-note';
      note.textContent = 'No orphaned attachments. Every stored image is referenced by a document or snapshot.';
      body.appendChild(note);
    } else {
      const note = document.createElement('p');
      note.className = 'muted-note';
      note.textContent = `${assets.length} stored attachment${assets.length === 1 ? '' : 's'} are not referenced by the current documents or snapshots.`;
      body.appendChild(note);
      const list = document.createElement('div');
      for (const asset of assets) {
        const item = document.createElement('div');
        item.className = 'history-item';
        const meta = document.createElement('div');
        meta.className = 'hi-meta';
        const label = document.createElement('div');
        label.className = 'hi-label';
        label.textContent = asset.name;
        const time = document.createElement('div');
        time.className = 'hi-time';
        time.textContent = `${asset.type || 'unknown'} · ${Math.ceil(asset.blob.size / 1024)} KB · ${timeAgo(asset.ts)}`;
        meta.append(label, time);
        item.appendChild(meta);
        list.appendChild(item);
      }
      body.appendChild(list);
    }
    const cleanup = document.createElement('button');
    cleanup.type = 'button';
    cleanup.className = 'btn danger';
    cleanup.textContent = assets.length ? `Delete ${assets.length} orphan${assets.length === 1 ? '' : 's'}` : 'No cleanup needed';
    cleanup.disabled = !assets.length;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn ghost';
    close.textContent = 'Close';
    const handle = openModal({ title: 'Attachment storage', body, foot: [close, cleanup] });
    close.addEventListener('click', handle.close);
    cleanup.addEventListener('click', async () => {
      const ok = await confirmDialog('Delete orphaned attachments', `Delete ${assets.length} attachment${assets.length === 1 ? '' : 's'} that no document or snapshot references? This cannot be undone.`, 'Delete');
      if (!ok) return;
      await deleteAssets(assets.map((asset) => asset.id));
      releaseAssetUrls();
      handle.close();
      toast(`Deleted ${assets.length} orphaned attachment${assets.length === 1 ? '' : 's'}.`, 'ok');
    });
  }).catch(() => toast('Could not inspect attachment storage.', 'err'));
}

function formatBytes(value?: number): string {
  if (value === undefined) return 'Unavailable';
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function openStorageHealth(): void {
  void getStorageHealth().then((health) => {
    const body = document.createElement('div');
    const grid = document.createElement('div');
    grid.className = 'storage-health-grid';
    const rows: [string, string][] = [
      ['Documents', health.documents.toLocaleString()],
      ['Snapshots', health.snapshots.toLocaleString()],
      ['Stored attachments', health.assets.toLocaleString()],
      ['Estimated usage', formatBytes(health.usage)],
      ['Estimated quota', formatBytes(health.quota)],
      ['Persistent storage', health.persistent === undefined ? 'Unavailable' : health.persistent ? 'Granted' : 'Not granted'],
      ['Connection', navigator.onLine ? 'Online' : 'Offline — local editing continues'],
      ['Save state', saveRetryPending ? 'Retry needed' : 'No pending save error'],
    ];
    for (const [label, value] of rows) {
      const key = document.createElement('span');
      key.className = 'storage-health-label';
      key.textContent = label;
      const val = document.createElement('strong');
      val.textContent = value;
      grid.append(key, val);
    }
    body.appendChild(grid);
    const note = document.createElement('p');
    note.className = 'muted-note';
    note.textContent = 'Browser storage limits vary by device and browser. MarkFlow does not impose a fixed document-count limit.';
    body.appendChild(note);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn ghost';
    close.textContent = 'Close';
    const foot = [close];
    if (health.persistenceAvailable && !health.persistent) {
      const persist = document.createElement('button');
      persist.type = 'button';
      persist.className = 'btn primary';
      persist.textContent = 'Protect local storage';
      persist.title = 'Ask the browser to keep MarkFlow data during storage pressure';
      persist.addEventListener('click', async () => {
        const granted = await requestPersistentStorage();
        handle.close();
        toast(granted ? 'Persistent storage granted by the browser.' : 'The browser did not grant persistent storage.', granted ? 'ok' : 'info', 4200);
      });
      foot.push(persist);
    }
    const handle = openModal({ title: 'Local storage health', body, foot });
    close.addEventListener('click', handle.close);
  }).catch(() => toast('Could not inspect local storage.', 'err'));
}

function diagnosticLabel(diagnostic: MarkdownDiagnostic): string {
  return diagnostic.kind.replace(/-/g, ' ');
}

async function openConfidencePanel(): Promise<void> {
  const references = attachmentIds(currentText);
  const available = new Set<string>();
  await Promise.all(references.map(async (id) => {
    if (await getAsset(id)) available.add(id);
  }));
  const diagnostics = analyzeMarkdown(currentText, { availableAttachments: available });
  const body = document.createElement('div');
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
  const warnings = diagnostics.length - errors;
  const summary = document.createElement('p');
  summary.className = 'confidence-summary';
  summary.textContent = diagnostics.length
    ? `${errors} error${errors === 1 ? '' : 's'} · ${warnings} warning${warnings === 1 ? '' : 's'}`
    : 'No structural or portability concerns found.';
  body.appendChild(summary);
  const note = document.createElement('p');
  note.className = 'muted-note';
  note.textContent = 'Checks are local and structural; remote URLs are not fetched.';
  body.appendChild(note);
  if (diagnostics.length) {
    const list = document.createElement('div');
    list.className = 'confidence-list';
    for (const diagnostic of diagnostics) {
      const item = document.createElement('div');
      item.className = `confidence-item ${diagnostic.severity}`;
      const heading = document.createElement('div');
      heading.className = 'confidence-item-head';
      const label = document.createElement('strong');
      label.textContent = diagnosticLabel(diagnostic);
      const location = document.createElement('span');
      location.textContent = `Line ${diagnostic.line}, column ${diagnostic.column}`;
      heading.append(label, location);
      const message = document.createElement('p');
      message.textContent = diagnostic.message;
      item.append(heading, message);
      list.appendChild(item);
    }
    body.appendChild(list);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn ghost';
  close.textContent = 'Close';
  const handle = openModal({ title: 'Markdown Confidence', body, foot: [close], wide: true });
  close.addEventListener('click', handle.close);
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
    const active = (b as HTMLElement).dataset.mode === mode;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', String(active));
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
  saveRetryBtn.addEventListener('click', () => { saveRetryBtn.disabled = true; void persistCurrentDoc().finally(() => { saveRetryBtn.disabled = false; }); });
  window.addEventListener('online', updateConnectivity);
  window.addEventListener('offline', updateConnectivity);
  updateConnectivity();
  installPwaLifecycle(({ message }) => updatePwaStatus(message));
  $('#newDocBtn').addEventListener('click', () => { void createAndLoad(); });
  $('#docSearch').addEventListener('input', refreshDocList);
  const backupInput = $('#backupFileInput') as HTMLInputElement;
  const importBackup = () => backupInput.click();
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
  const libraryToolsBtn = $('#libraryToolsBtn');
  libraryToolsBtn.addEventListener('click', () => {
    popMenu(libraryToolsBtn, [
      { label: 'Version history', onClick: openHistory },
      { label: 'Backup all documents', onClick: async () => { await exportBackupZip(await listDocs()); } },
      { label: 'Import Markdown or MarkFlow ZIP', onClick: importBackup },
      { label: 'Review attachment storage', onClick: openAssetManager },
      { label: 'Local storage health', onClick: openStorageHealth },
    ], 'Documents are stored locally in IndexedDB.', 'up');
  });
  $('#shortcutsBtn').addEventListener('click', openShortcuts);
  $('#confidenceBtn').addEventListener('click', () => { void openConfidencePanel(); });

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
    const active = (b as HTMLElement).dataset.mode === settings.mode;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', String(active));
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
