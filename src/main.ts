// MarkFlow — application coordinator.
import './style.css';
import 'katex/dist/katex.min.css';

import { EditorView, keymap } from '@codemirror/view';
import { redo, undo, redoDepth, undoDepth } from '@codemirror/commands';
import { Prec, StateEffect } from '@codemirror/state';
import { createEditor, setEditorText } from './editor';
import { createRenderer, postRender } from './core/renderer';
import {
  listDocs, createDoc, saveDoc, deleteDoc, duplicateDoc, deleteAssets, listOrphanAssets,
  addSnapshotIfChanged, createRestoreCheckpoint, listSnapshots, getStorageHealth, requestPersistentStorage, getAsset, type Doc,
} from './core/storage';
import { toast, openModal, formDialog, confirmDialog, popMenu, debounce, timeAgo, countWords } from './ui';
import { settings, saveSettings, type ViewMode, type ThemeName } from './state';
import { buildToolbar, toggleInline, insertLink, refreshToolbarContext } from './toolbar';
import { renderDocList } from './library';
import { installImageHandlers, attachmentIds, releaseAssetUrls } from './core/images';
import { installTablePaste } from './core/clipboard';
import { findAllTables, tableLinesEquivalent } from './core/tables';
import { analyzeMarkdown, type MarkdownDiagnostic } from './core/diagnostics';
import { buildLineDiff, buildSideBySideDiff, copySelectedSideBySideLines, type DiffLine, type SideBySideLine } from './core/textDiff';
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
  try {
    const created = await addSnapshotIfChanged(currentDoc.id, label, currentText, countWords(currentText));
    if (!created) {
      if (notify) toast('Nothing new to snapshot.', 'info');
      return;
    }
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
  if (currentDoc && currentText.trim()) {
    void takeSnapshot('auto', false);
  }
}, 3 * 60 * 1000);

// ---------------- document switching ----------------

async function loadDoc(doc: Doc): Promise<void> {
  currentDoc = doc;
  currentText = doc.content;
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

type ComparisonMode = 'unified' | 'side-by-side';
type ComparisonFilter = 'all' | 'diff' | 'same';

interface StructuredUnifiedRow extends DiffLine {
  id: string;
  changed: boolean;
  section: number | null;
}

interface StructuredSideRow extends SideBySideLine {
  id: string;
  changed: boolean;
  section: number | null;
}

interface StructuredComparison {
  unified: StructuredUnifiedRow[];
  sideBySide: StructuredSideRow[];
  sectionIds: string[];
}

function comparisonIsLarge(before: string, after: string, diff: DiffLine[]): boolean {
  const changed = diff.filter((line) => line.kind === 'added' || line.kind === 'removed').length;
  return changed >= 8 || Math.max(before.split('\n').length, after.split('\n').length) >= 120;
}

function comparisonSummary(diff: DiffLine[]): string {
  const added = diff.filter((line) => line.kind === 'added').length;
  const removed = diff.filter((line) => line.kind === 'removed').length;
  let tableRows = 0;
  for (let i = 0; i + 1 < diff.length; i++) {
    if (diff[i].kind === 'removed' && diff[i + 1].kind === 'added'
      && diff[i].text.trim().startsWith('|') && diff[i].text.trim().endsWith('|')
      && diff[i + 1].text.trim().startsWith('|') && diff[i + 1].text.trim().endsWith('|')) tableRows++;
  }
  if (!added && !removed) return 'This snapshot matches the current document.';
  return `${added} line${added === 1 ? '' : 's'} added · ${removed} line${removed === 1 ? '' : 's'} removed${tableRows ? ` · ${tableRows} table row${tableRows === 1 ? '' : 's'} changed` : ''}`;
}

function buildStructuredComparison(before: string, after: string): StructuredComparison {
  const unified = buildLineDiff(before, after, { equivalent: tableLinesEquivalent });
  const sideBySide = buildSideBySideDiff(before, after, { equivalent: tableLinesEquivalent });
  const sectionIds: string[] = [];
  const markSections = <T extends { kind: string }>(rows: T[], prefix: string): (T & { id: string; changed: boolean; section: number | null })[] => {
    let section = -1;
    let inChange = false;
    return rows.map((row, index) => {
      const changed = row.kind === 'added' || row.kind === 'removed' || row.kind === 'changed';
      if (changed && !inChange) {
        section++;
        sectionIds[section] = `change-${section + 1}`;
      }
      inChange = changed;
      return { ...row, id: `${prefix}-${index}`, changed, section: changed ? section : null };
    });
  };
  return {
    unified: markSections(unified, 'unified'),
    sideBySide: markSections(sideBySide, 'side'),
    sectionIds,
  };
}

function appendUnifiedRow(container: HTMLElement, line: StructuredUnifiedRow, oldLine: number | null, newLine: number | null): void {
  const row = document.createElement('div');
  row.className = `source-diff-line ${line.kind}`;
  row.dataset.rowId = line.id;
  if (line.section !== null) row.dataset.sectionId = `change-${line.section + 1}`;
  const marker = document.createElement('span');
  marker.className = 'source-diff-marker';
  marker.textContent = line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : line.kind === 'normalized' ? '·' : ' ';
  marker.setAttribute('aria-hidden', 'true');
  const oldNumber = document.createElement('span');
  oldNumber.className = 'source-diff-number';
  oldNumber.textContent = oldLine === null ? '' : String(oldLine);
  const newNumber = document.createElement('span');
  newNumber.className = 'source-diff-number';
  newNumber.textContent = newLine === null ? '' : String(newLine);
  const text = document.createElement('code');
  text.textContent = line.text || ' ';
  row.append(marker, oldNumber, newNumber, text);
  container.appendChild(row);
}

function appendUnifiedRows(
  container: HTMLElement,
  diff: StructuredUnifiedRow[],
  filter: ComparisonFilter,
  expandedContext: Set<string>,
  showUnchanged: boolean,
  onContextChange: (groupId: string, expanded: boolean) => void,
): void {
  let oldLine = 1;
  let newLine = 1;
  let index = 0;
  while (index < diff.length) {
    if ((filter === 'diff' && !diff[index].changed) || (filter === 'same' && diff[index].changed)) {
      if (diff[index].kind === 'context' || diff[index].kind === 'normalized') oldLine++, newLine++;
      else if (diff[index].kind === 'removed') oldLine++;
      else newLine++;
      index++;
      continue;
    }
    if (diff[index].kind === 'context' || diff[index].kind === 'normalized') {
      const start = index;
      while (index < diff.length && (diff[index].kind === 'context' || diff[index].kind === 'normalized')) index++;
      const group = diff.slice(start, index);
      const render = document.createElement('div');
      const groupId = `context-${group[0].id}-${group[group.length - 1].id}`;
      const groupOldLine = oldLine;
      const groupNewLine = newLine;
      const renderGroup = () => group.forEach((line, offset) => {
        appendUnifiedRow(render, line, groupOldLine + offset, groupNewLine + offset);
      });
      oldLine += group.length;
      newLine += group.length;
      const expanded = showUnchanged || expandedContext.has(groupId);
      if (filter === 'all' && group.length > 4 && !expanded) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'source-diff-collapse';
        button.textContent = `Show ${group.length} unchanged lines`;
        button.dataset.contextId = groupId;
        button.addEventListener('click', () => { onContextChange(groupId, true); });
        container.appendChild(button);
      } else {
        renderGroup();
        if (filter === 'all' && group.length > 4) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'source-diff-collapse';
          button.textContent = `Hide ${group.length} unchanged lines`;
          button.dataset.contextId = groupId;
          button.addEventListener('click', () => { onContextChange(groupId, false); });
          render.appendChild(button);
        }
        container.appendChild(render);
      }
      continue;
    }
    const line = diff[index++];
    if (line.kind === 'removed') appendUnifiedRow(container, line, oldLine++, null);
    else appendUnifiedRow(container, line, null, newLine++);
  }
}

function appendSideBySideRow(
  container: HTMLElement,
  line: StructuredSideRow,
  selectedIds: ReadonlySet<string>,
  onSelect: (id: string, selected: boolean) => void,
  onCopy: (id: string) => void,
): void {
  const row = document.createElement('div');
  row.className = `side-diff-line ${line.kind}`;
  row.dataset.rowId = line.id;
  if (line.section !== null) row.dataset.sectionId = `change-${line.section + 1}`;
  row.classList.toggle('side-diff-selected', selectedIds.has(line.id));
  const sides = [line.left, line.right];
  sides.forEach((side, index) => {
    const pane = document.createElement('div');
    const hasHistorySelection = index === 0 && Boolean(line.left) && line.changed;
    pane.className = `side-diff-pane${hasHistorySelection ? ' side-diff-history' : ''}`;
    const marker = document.createElement('span');
    marker.className = 'side-diff-marker';
    marker.textContent = line.kind === 'changed' ? (index === 0 ? '−' : '+')
      : line.kind === 'removed' && index === 0 ? '−'
        : line.kind === 'added' && index === 1 ? '+' : ' ';
    marker.setAttribute('aria-label', marker.textContent === '+' ? 'Added line' : marker.textContent === '−' ? 'Removed line' : 'Unchanged line');
    if (hasHistorySelection) {
      const select = document.createElement('input');
      select.type = 'checkbox';
      select.className = 'side-diff-select';
      select.checked = selectedIds.has(line.id);
      select.disabled = !line.left;
      select.setAttribute('aria-label', line.left ? `Select historical line ${line.left.line}` : 'No historical line');
      select.addEventListener('change', () => onSelect(line.id, select.checked));
      pane.append(marker, select);
    } else {
      pane.append(marker);
    }
    const number = document.createElement('span');
    number.className = 'side-diff-number';
    number.textContent = side ? String(side.line) : '';
    const text = document.createElement('code');
    const appendText = (value: string, className?: string) => {
      if (!value) return;
      if (!className) { text.appendChild(document.createTextNode(value)); return; }
      const span = document.createElement('span');
      span.className = className;
      span.textContent = value;
      text.appendChild(span);
    };
    if (line.kind === 'changed' && line.left && line.right) {
      const sourceText = index === 0 ? line.left.text : line.right.text;
      const comparisonText = index === 0 ? line.right.text : line.left.text;
      let prefix = 0;
      while (prefix < sourceText.length && prefix < comparisonText.length && sourceText[prefix] === comparisonText[prefix]) prefix++;
      let suffix = 0;
      while (suffix < sourceText.length - prefix && suffix < comparisonText.length - prefix
        && sourceText[sourceText.length - 1 - suffix] === comparisonText[comparisonText.length - 1 - suffix]) suffix++;
      appendText(sourceText.slice(0, prefix));
      appendText(sourceText.slice(prefix, sourceText.length - suffix), index === 0 ? 'side-diff-inline-removed' : 'side-diff-inline-added');
      appendText(suffix ? sourceText.slice(sourceText.length - suffix) : '');
    } else {
      appendText(side?.text || '', line.kind === 'removed' ? 'side-diff-inline-removed' : line.kind === 'added' ? 'side-diff-inline-added' : undefined);
    }
    pane.append(number, text);
    if (index === 0 && line.left && line.changed) {
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'side-diff-copy';
      copy.textContent = '→';
      copy.title = 'Copy this historical line to the current editor';
      copy.setAttribute('aria-label', `Copy historical line ${line.left.line} to current editor`);
      copy.addEventListener('click', () => onCopy(line.id));
      pane.appendChild(copy);
    }
    row.appendChild(pane);
  });
  container.appendChild(row);
}

function appendSideBySideRows(
  container: HTMLElement,
  rows: StructuredSideRow[],
  filter: ComparisonFilter,
  expandedContext: Set<string>,
  showUnchanged: boolean,
  onContextChange: (groupId: string, expanded: boolean) => void,
  selectedIds: ReadonlySet<string>,
  onSelect: (id: string, selected: boolean) => void,
  onCopy: (id: string) => void,
): void {
  let index = 0;
  while (index < rows.length) {
    if ((filter === 'diff' && !rows[index].changed) || (filter === 'same' && rows[index].changed)) {
      index++;
      continue;
    }
    if (rows[index].kind === 'context' || rows[index].kind === 'normalized') {
      const start = index;
      while (index < rows.length && (rows[index].kind === 'context' || rows[index].kind === 'normalized')) index++;
      const group = rows.slice(start, index);
      const render = document.createElement('div');
      const renderGroup = () => group.forEach((line) => appendSideBySideRow(render, line, selectedIds, onSelect, onCopy));
      const groupId = `context-${group[0].id}-${group[group.length - 1].id}`;
      const expanded = showUnchanged || expandedContext.has(groupId);
      if (filter === 'all' && group.length > 4 && !expanded) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'source-diff-collapse';
        button.textContent = `Show ${group.length} unchanged lines`;
        button.dataset.contextId = groupId;
        button.addEventListener('click', () => { onContextChange(groupId, true); });
        container.appendChild(button);
      } else {
        renderGroup();
        if (filter === 'all' && group.length > 4) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'source-diff-collapse';
          button.textContent = `Hide ${group.length} unchanged lines`;
          button.dataset.contextId = groupId;
          button.addEventListener('click', () => { onContextChange(groupId, false); });
          render.appendChild(button);
        }
        container.appendChild(render);
      }
      continue;
    }
    appendSideBySideRow(container, rows[index++], selectedIds, onSelect, onCopy);
  }
}

function buildComparisonBody(before: string, after: string): HTMLElement {
  const body = document.createElement('div');
  body.className = 'comparison-body';
  let currentSource = after;
  let structured = buildStructuredComparison(before, currentSource);
  settings.comparisonSplit = Math.max(.3, Math.min(.7, Number(settings.comparisonSplit) || .5));
  const initialDiff = structured.unified;
  const automatic = settings.comparisonMode === 'auto';
  let mode: ComparisonMode = automatic && comparisonIsLarge(before, currentSource, initialDiff) ? 'side-by-side'
    : settings.comparisonMode === 'side-by-side' ? 'side-by-side' : 'unified';
  let showUnchanged = false;
  const expandedContext = new Set<string>();
  const selectedHistoryIds = new Set<string>();
  const summary = document.createElement('p');
  summary.className = 'muted-note comparison-summary';
  summary.textContent = comparisonSummary(structured.unified) + (automatic && mode === 'side-by-side' ? ' · Side-by-side selected for this larger change.' : '');
  body.appendChild(summary);
  const controls = document.createElement('div');
  controls.className = 'comparison-controls';
  const filterControls = document.createElement('div');
  filterControls.className = 'comparison-filter';
  let filter: ComparisonFilter = 'all';
  let activeSection = 0;
  const filterButtons: HTMLButtonElement[] = [];
  const addFilter = (value: ComparisonFilter, label: string) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn small ghost';
    button.textContent = label;
    button.addEventListener('click', () => { filter = value; activeSection = 0; render(); });
    filterButtons.push(button);
    filterControls.appendChild(button);
  };
  addFilter('all', 'All');
  addFilter('diff', 'Diff');
  addFilter('same', 'Same');
  controls.appendChild(filterControls);
  const unchangedToggle = document.createElement('button');
  unchangedToggle.type = 'button';
  unchangedToggle.className = 'btn small ghost';
  unchangedToggle.textContent = 'Show unchanged';
  unchangedToggle.title = 'Show or hide unchanged context blocks';
  unchangedToggle.addEventListener('click', () => {
    showUnchanged = !showUnchanged;
    if (!showUnchanged) expandedContext.clear();
    render();
  });
  controls.appendChild(unchangedToggle);
  const toggle = (value: ComparisonMode, label: string) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn small ghost';
    button.textContent = label;
    button.addEventListener('click', () => {
      mode = value;
      settings.comparisonMode = value;
      saveSettings();
      render();
    });
    controls.appendChild(button);
    return button;
  };
  const unified = toggle('unified', 'Unified');
  const side = toggle('side-by-side', 'Side by side');
  const copySelected = document.createElement('button');
  copySelected.type = 'button';
  copySelected.className = 'btn small ghost';
  copySelected.textContent = 'Copy selected →';
  copySelected.title = 'Copy selected historical lines into the current editor';
  controls.appendChild(copySelected);
  const copyStatus = document.createElement('span');
  copyStatus.className = 'comparison-copy-status muted-note';
  controls.appendChild(copyStatus);
  const undoButton = document.createElement('button');
  undoButton.type = 'button';
  undoButton.className = 'btn small ghost';
  undoButton.textContent = 'Undo';
  undoButton.title = 'Undo the last copy/edit in the current editor';
  undoButton.addEventListener('click', () => {
    if (!undo(view)) {
      copyStatus.textContent = 'Nothing to undo.';
      return;
    }
    currentSource = view.state.doc.toString();
    structured = buildStructuredComparison(before, currentSource);
    selectedHistoryIds.clear();
    copyStatus.textContent = 'Undid the last comparison edit.';
    render();
  });
  const redoButton = document.createElement('button');
  redoButton.type = 'button';
  redoButton.className = 'btn small ghost';
  redoButton.textContent = 'Redo';
  redoButton.title = 'Redo the last copy/edit in the current editor';
  redoButton.addEventListener('click', () => {
    if (!redo(view)) {
      copyStatus.textContent = 'Nothing to redo.';
      return;
    }
    currentSource = view.state.doc.toString();
    structured = buildStructuredComparison(before, currentSource);
    selectedHistoryIds.clear();
    copyStatus.textContent = 'Redid the comparison edit.';
    render();
  });
  controls.append(undoButton, redoButton);
  const nav = document.createElement('span');
  nav.className = 'comparison-nav';
  const prev = document.createElement('button');
  prev.type = 'button'; prev.className = 'btn small ghost'; prev.textContent = '↑'; prev.title = 'Previous diff'; prev.setAttribute('aria-label', 'Previous diff');
  const next = document.createElement('button');
  next.type = 'button'; next.className = 'btn small ghost'; next.textContent = '↓'; next.title = 'Next diff'; next.setAttribute('aria-label', 'Next diff');
  const position = document.createElement('span');
  position.className = 'muted-note';
  nav.append(prev, next, position);
  controls.appendChild(nav);
  body.appendChild(controls);
  const viewport = document.createElement('div');
  body.appendChild(viewport);
  let sideShell: HTMLElement | null = null;
  const scrollToSection = () => {
    const total = structured.sectionIds.length;
    position.textContent = total ? `${Math.min(activeSection + 1, total)} of ${total} changes` : 'No changes';
    prev.disabled = total === 0;
    next.disabled = total === 0;
    const target = viewport.querySelector<HTMLElement>(`[data-section-id="${structured.sectionIds[activeSection] ?? ''}"]`);
    target?.scrollIntoView({ block: 'center' });
  };
  const adjustSplit = (event: PointerEvent) => {
    if (!sideShell) return;
    const rect = sideShell.getBoundingClientRect();
    const value = Math.max(.3, Math.min(.7, (event.clientX - rect.left) / rect.width));
    settings.comparisonSplit = value;
    sideShell.style.setProperty('--side-split', `${value * 100}%`);
  };
  const copyRows = (ids: ReadonlySet<string>) => {
    const result = copySelectedSideBySideLines(currentSource, structured.sideBySide, ids);
    if (result.text === currentSource) {
      copyStatus.textContent = 'No changes to copy.';
      return;
    }
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: result.text } });
    currentSource = result.text;
    structured = buildStructuredComparison(before, currentSource);
    selectedHistoryIds.clear();
    const parts = [];
    if (result.replaced) parts.push(`${result.replaced} line${result.replaced === 1 ? '' : 's'} replaced`);
    if (result.inserted) parts.push(`${result.inserted} line${result.inserted === 1 ? '' : 's'} inserted`);
    copyStatus.textContent = `Copied ${parts.join(' · ')} from the historical version.`;
    render();
  };
  copySelected.addEventListener('click', () => copyRows(selectedHistoryIds));
  const render = () => {
    filterButtons.forEach((button, index) => button.classList.toggle('active', ['all', 'diff', 'same'][index] === filter));
    unchangedToggle.textContent = showUnchanged ? 'Hide unchanged' : 'Show unchanged';
    unchangedToggle.classList.toggle('active', showUnchanged);
    unchangedToggle.disabled = filter !== 'all';
    copySelected.hidden = mode !== 'side-by-side';
    copySelected.disabled = mode !== 'side-by-side' || selectedHistoryIds.size === 0;
    undoButton.disabled = undoDepth(view.state) === 0;
    redoButton.disabled = redoDepth(view.state) === 0;
    unified.classList.toggle('active', mode === 'unified');
    side.classList.toggle('active', mode === 'side-by-side');
    viewport.innerHTML = '';
    sideShell = null;
    if (mode === 'unified') {
      const code = document.createElement('div');
      code.className = 'source-diff-code history-diff-code';
      appendUnifiedRows(code, structured.unified, filter, expandedContext, showUnchanged, (groupId, expanded) => {
        if (expanded) expandedContext.add(groupId);
        else expandedContext.delete(groupId);
        render();
      });
      viewport.appendChild(code);
    } else {
      const shell = document.createElement('div');
      shell.className = 'side-diff-shell';
      sideShell = shell;
      shell.style.setProperty('--side-split', `${settings.comparisonSplit * 100}%`);
      const heads = document.createElement('div');
      heads.className = 'side-diff-head';
      heads.innerHTML = '<strong>Selected snapshot</strong><strong>Current editor</strong>';
      shell.appendChild(heads);
      const code = document.createElement('div');
      code.className = 'side-diff-code';
      appendSideBySideRows(code, structured.sideBySide, filter, expandedContext, showUnchanged, (groupId, expanded) => {
        if (expanded) expandedContext.add(groupId);
        else expandedContext.delete(groupId);
        render();
      }, selectedHistoryIds, (id, selected) => {
        if (selected) selectedHistoryIds.add(id);
        else selectedHistoryIds.delete(id);
        render();
      }, (id) => copyRows(new Set([id])));
      shell.appendChild(code);
      const divider = document.createElement('button');
      divider.type = 'button'; divider.className = 'side-diff-divider'; divider.title = 'Resize comparison panes'; divider.setAttribute('aria-label', 'Resize comparison panes');
      divider.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        const move = (moveEvent: PointerEvent) => adjustSplit(moveEvent);
        const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop, { once: true });
      });
      divider.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        settings.comparisonSplit = Math.max(.3, Math.min(.7, settings.comparisonSplit + (event.key === 'ArrowRight' ? .02 : -.02)));
        shell.style.setProperty('--side-split', `${settings.comparisonSplit * 100}%`);
      });
      shell.appendChild(divider);
      viewport.appendChild(shell);
    }
    scrollToSection();
  };
  prev.addEventListener('click', () => { if (structured.sectionIds.length) { activeSection = (activeSection - 1 + structured.sectionIds.length) % structured.sectionIds.length; render(); } });
  next.addEventListener('click', () => { if (structured.sectionIds.length) { activeSection = (activeSection + 1) % structured.sectionIds.length; render(); } });
  render();
  return body;
}

async function restoreSnapshot(snapshot: { content: string; ts: number }, historyHandle: { close: () => void }, reviewHandle: { close: () => void }): Promise<void> {
  if (!currentDoc) return;
  try {
    await createRestoreCheckpoint(currentDoc.id, currentText, countWords(currentText));
    reviewHandle.close();
    historyHandle.close();
    currentDoc = { ...currentDoc, content: snapshot.content };
    await saveDoc(currentDoc);
    docs = await listDocs();
    await loadDoc(currentDoc);
    toast(`Restored version from ${new Date(snapshot.ts).toLocaleTimeString()}.`, 'ok');
  } catch (error) {
    toast(`Could not restore this version: ${describeSaveError(error)}.`, 'err', 5200);
  }
}

function openSnapshotDiff(snapshot: { content: string; label: string; ts: number }, historyHandle: { close: () => void }): void {
  const body = buildComparisonBody(snapshot.content, currentText);
  const keep = document.createElement('button');
  keep.type = 'button';
  keep.className = 'btn ghost';
  keep.textContent = 'Keep current editor';
  const restore = document.createElement('button');
  restore.type = 'button';
  restore.className = 'btn primary';
  restore.textContent = 'Restore this version';
  const review = openModal({ title: 'Compare with snapshot', body, foot: [keep, restore], wide: true, maximizable: true });
  keep.addEventListener('click', review.close);
  restore.addEventListener('click', () => { void restoreSnapshot(snapshot, historyHandle, review); });
}

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
      const isCurrent = snap.content === currentText;
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
      if (isCurrent) {
        const badge = document.createElement('span');
        badge.className = 'history-current';
        badge.textContent = 'Current version';
        item.append(meta, badge, dl);
      } else {
        const diff = document.createElement('button');
        diff.className = 'btn small ghost';
        diff.textContent = 'Diff';
        diff.title = 'Compare this snapshot with the current document';
        diff.addEventListener('click', () => openSnapshotDiff(snap, handle));
        const restore = document.createElement('button');
        restore.className = 'btn small primary';
        restore.textContent = 'Restore';
        restore.addEventListener('click', () => openSnapshotDiff(snap, handle));
        item.append(meta, diff, dl, restore);
      }
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
      if (result.settingsRestored) {
        setTheme(settings.theme);
        setMode(settings.mode);
        $('#sidebar').classList.toggle('hidden', !settings.sidebarOpen);
      }
      toast(`Imported ${result.documents} document(s), ${result.snapshots} snapshot(s), and ${result.assets} attachment(s).${result.missingAssets ? ` ${result.missingAssets} attachment reference(s) were missing.` : ''}${result.settingsRestored ? ' Settings restored.' : ''}`, result.missingAssets ? 'info' : 'ok', 5200);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not import this backup.', 'err', 5200);
    }
  });
  const libraryToolsBtn = $('#libraryToolsBtn');
  libraryToolsBtn.addEventListener('click', () => {
    popMenu(libraryToolsBtn, [
      { label: 'Version history', onClick: openHistory },
      { label: 'Export portable package', onClick: async () => { await exportBackupZip(await listDocs()); } },
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
