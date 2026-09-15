// ★ The wedge feature: a spreadsheet-style visual table editor.
// Letter bar + number gutter frame the grid; Canva-style contextual "+"
// circles straddle the grid's left/top edge at the hovered cell's insertion
// boundary (clamped to the visible edge when the table is scrolled).
// Multi-select rows/columns with Ctrl/Shift; bulk ops SYNC the selection
// (Excel semantics: mixed → apply to all, all-have → remove from all) and skip
// empty cells. Sort (body-only, numeric-aware) and a view-only contains-filter.
// Column widths / row heights are draggable — editor-view only, markdown never
// stores them. Per-cell ALIGNMENT remains impossible by markdown design
// (separator row holds column rules) — aligning from a cell aligns its column
// and says why.
import { EditorView } from '@codemirror/view';
import { openModal, formDialog, toast } from './ui';
import { findTableAtLine, serializeTable, tableLinesEquivalent, type Align, type TableBlock } from './core/tables';
import { getInlineMarkState, toggleInlineMarkup, type InlineMarker } from './core/inlineFormatting';
import { buildLineDiff } from './core/textDiff';

interface Model {
  rows: string[][]; // [0] = header (always)
  aligns: Align[];
}

type ApplyFn = (serialized: string) => void;
type Sel =
  | { kind: 'cell'; r: number; c: number }
  | { kind: 'row'; i: number }
  | { kind: 'col'; i: number }
  | { kind: 'rows'; set: Set<number> }
  | { kind: 'cols'; set: Set<number> }
  | { kind: 'all' }
  | null;

const colLetter = (i: number): string => {
  let s = ''; let n = i + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
};

type CellRect = Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'>;
type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
interface InsertionIntent { index: number; edge: 'before' | 'after' }

export function isPointInsideRect(clientX: number, clientY: number, rect: CellRect): boolean {
  return clientX >= rect.left && clientX <= rect.right
    && clientY >= rect.top && clientY <= rect.bottom;
}

export function isPointInsideCornerHotspot(
  clientX: number,
  clientY: number,
  rect: CellRect,
  corner: Corner,
  percentage = 0.25,
): boolean {
  if (!isPointInsideRect(clientX, clientY, rect)) return false;
  const cornerX = corner.endsWith('right') ? rect.right : rect.left;
  const cornerY = corner.startsWith('bottom') ? rect.bottom : rect.top;
  const radius = Math.min(rect.width, rect.height) * percentage;
  return Math.hypot(clientX - cornerX, clientY - cornerY) <= radius;
}

export function getRowInsertionIntent(clientX: number, clientY: number, rect: CellRect, rowIndex: number): InsertionIntent | null {
  if (isPointInsideCornerHotspot(clientX, clientY, rect, 'top-left')) return { index: rowIndex, edge: 'before' };
  if (isPointInsideCornerHotspot(clientX, clientY, rect, 'bottom-left')) return { index: rowIndex + 1, edge: 'after' };
  return null;
}

export function getColumnInsertionIntent(clientX: number, clientY: number, rect: CellRect, columnIndex: number): InsertionIntent | null {
  if (isPointInsideCornerHotspot(clientX, clientY, rect, 'top-left')) return { index: columnIndex, edge: 'before' };
  if (isPointInsideCornerHotspot(clientX, clientY, rect, 'top-right')) return { index: columnIndex + 1, edge: 'after' };
  return null;
}

/** "2–4, 7" style compression for readouts ("Rows 2–4, 7", "Columns A–C") */
function fmtRanges(nums: number[], label: (n: number) => string): string {
  const s = [...new Set(nums)].sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < s.length) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    parts.push(j > i ? `${label(s[i])}–${label(s[j])}` : label(s[i]));
    i = j + 1;
  }
  return parts.join(', ');
}

// -------------------------------------- entries --------------------------------------

export function openTableEditorAtCursor(view: EditorView): boolean {
  const doc = view.state.doc;
  const cursor = doc.lineAt(view.state.selection.main.head);
  const lines = view.state.doc.toString().split('\n');
  const found: TableBlock | null = findTableAtLine(lines, cursor.number - 1);
  if (!found) return false;
  openEditorUI(
    () => ({ rows: found.rows.map((r) => r.slice()), aligns: found.aligns.slice() }),
    (serialized) => {
      const fromLine = view.state.doc.line(found.startLine + 1);
      const toLine = view.state.doc.line(found.endLine + 1);
      view.dispatch({
        changes: { from: fromLine.from, to: toLine.to, insert: serialized },
        selection: { anchor: fromLine.from },
      });
      view.focus();
      toast('Table updated — source stays perfectly aligned.', 'ok');
    },
    'Edit table',
    lines.slice(found.startLine, found.endLine + 1).join('\n'),
  );
  return true;
}

export function openTableEditorFresh(view: EditorView, cols = 3, rows = 3): void {
  const bodyRows = Math.max(0, rows - 1);
  const model: Model = {
    rows: [
      Array.from({ length: cols }, (_, i) => `Column ${i + 1}`),
      ...Array.from({ length: bodyRows }, () => Array<string>(cols).fill('')),
    ],
    aligns: Array<Align>(cols).fill(''),
  };
  openEditorUI(
    () => model,
    (serialized) => {
      const pos = view.state.selection.main.head;
      const line = view.state.doc.lineAt(pos);
      const needsNL = line.text.trim().length > 0;
      const insert = (needsNL ? '\n\n' : '') + serialized + '\n';
      view.dispatch({ changes: { from: needsNL ? line.to : line.from, insert }, scrollIntoView: true });
      view.focus();
      toast('Table inserted.', 'ok');
    },
    'Insert table',
    '',
  );
}

/** Grid picker for "insert table" — hover a size, click to open a prefilled editor. */
export function showTableSizePicker(anchor: HTMLElement, onPick: (cols: number, rows: number) => void): void {
  document.querySelectorAll('.te-picker').forEach((p) => p.remove());
  const pop = document.createElement('div');
  pop.className = 'te-picker';
  const grid = document.createElement('div');
  grid.className = 'te-pick-grid';
  const label = document.createElement('div');
  label.className = 'te-pick-label';
  const cells: HTMLButtonElement[] = [];
  const MAXC = 8, MAXR = 6;
  const paint = (cx: number, cy: number) => {
    for (const c of cells) c.classList.toggle('on', Number(c.dataset.x) <= cx && Number(c.dataset.y) <= cy);
    label.textContent = `${cx} × ${cy}` + (cy === 1 ? '  (header only)' : `  (header + ${cy - 1} row${cy > 2 ? 's' : ''})`);
  };
  for (let y = 1; y <= MAXR; y++) {
    for (let x = 1; x <= MAXC; x++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'te-pick-cell';
      b.dataset.x = String(x);
      b.dataset.y = String(y);
      b.setAttribute('aria-label', `Insert a ${x} by ${y} table`);
      b.addEventListener('mouseenter', () => paint(x, y));
      b.addEventListener('click', () => { pop.remove(); onPick(x, y); });
      cells.push(b);
      grid.appendChild(b);
    }
  }
  pop.append(grid, label);
  document.body.appendChild(pop);
  paint(3, 2);
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 220))}px`;
  pop.style.top = `${r.bottom + 6}px`;
  const onDoc = (e: MouseEvent) => {
    if (!pop.contains(e.target as Node) && e.target !== anchor) { pop.remove(); document.removeEventListener('mousedown', onDoc); }
  };
  document.addEventListener('mousedown', onDoc);
}

export function openTableEditorByIndex(view: EditorView, index: number, allTables: TableBlock[]): void {
  const found = allTables[index];
  if (!found) return;
  openEditorUI(
    () => ({ rows: found.rows.map((r) => r.slice()), aligns: found.aligns.slice() }),
    (serialized) => {
      const fromLine = view.state.doc.line(found.startLine + 1);
      const toLine = view.state.doc.line(found.endLine + 1);
      view.dispatch({
        changes: { from: fromLine.from, to: toLine.to, insert: serialized },
        selection: { anchor: fromLine.from },
      });
      view.focus();
      toast('Table updated — source stays perfectly aligned.', 'ok');
    },
    `Edit table ${index + 1}`,
    view.state.doc.toString().split('\n').slice(found.startLine, found.endLine + 1).join('\n'),
  );
}

// -------------------------------------- modal --------------------------------------

function openEditorUI(getModel: () => Model, onApply: ApplyFn, title: string, originalSource: string): void {
  const model = getModel();
  const cols = () => model.rows[0]?.length ?? 1;

  let sel: Sel = null;
  let lastCell: HTMLInputElement | null = null;
  let anchorRow = 0;
  let anchorCol = 0;
  let filter: { c: number; text: string } | null = null;
  const undoStack: string[] = [];
  const redoStack: string[] = [];

  // editor-view-only sizing (markdown can't store widths/heights — resets on reopen)
  let colW: (number | undefined)[] = Array.from({ length: cols() }, () => undefined);
  let rowH: (number | undefined)[] = Array.from({ length: model.rows.length }, () => undefined);

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  };

  const root = el('div', 'te-root');
  const stage = el('div', 'te-stage');
  const scroll = el('div', 'te-scroll');
  const grid = el('table', 'te-grid');
  const thead = el('thead');
  const tbody = el('tbody');
  grid.append(thead, tbody);
  scroll.appendChild(grid);
  stage.appendChild(scroll);

  // ---------- Canva-style hover insertion handles ----------
  const hhV = el('div', 'te-hh te-hh-v');
  const hhH = el('div', 'te-hh te-hh-h');
  const hhVBtn = el('button'); hhVBtn.type = 'button'; hhVBtn.textContent = '+'; hhVBtn.title = 'Insert column here'; hhVBtn.setAttribute('aria-label', 'Insert column here');
  const hhHBtn = el('button'); hhHBtn.type = 'button'; hhHBtn.textContent = '+'; hhHBtn.title = 'Insert row here'; hhHBtn.setAttribute('aria-label', 'Insert row here');
  hhV.appendChild(hhVBtn);
  hhH.appendChild(hhHBtn);
  stage.append(hhV, hhH);

  function hideHandles(): void {
    hhV.classList.remove('on');
    hhH.classList.remove('on');
  }

  function showHandle(axis: 'v' | 'h', insertIdx: number, anchorEl: HTMLElement, edge: 'before' | 'after'): void {
    const sr = stage.getBoundingClientRect();
    const gr = grid.getBoundingClientRect();
    const ar = anchorEl.getBoundingClientRect();
    const scR = scroll.getBoundingClientRect();
    const visLeft = Math.max(gr.left, scR.left + 1);
    const visTop = Math.max(gr.top, scR.top + 1);
    if (axis === 'v') {
      const x = Math.min((edge === 'before' ? ar.left : ar.right) - sr.left, sr.width - 3);
      hhV.style.left = `${x}px`;
      hhV.style.top = `${visTop - sr.top}px`;
      hhVBtn.onclick = () => { hideHandles(); insertColAt(insertIdx, true); };
      const label = edge === 'before'
        ? `Insert column before ${colLetter(insertIdx)}`
        : `Insert column after ${colLetter(insertIdx - 1)}`;
      hhVBtn.title = label;
      hhVBtn.setAttribute('aria-label', label);
      hhV.classList.add('on');
    } else {
      const y = Math.min((edge === 'before' ? ar.top : ar.bottom) - sr.top, sr.height - 3);
      hhH.style.top = `${y}px`;
      hhH.style.left = `${visLeft - sr.left}px`;
      hhHBtn.onclick = () => { hideHandles(); insertRowAt(insertIdx, true); };
      const label = edge === 'before'
        ? `Insert row above row ${insertIdx + 1}`
        : `Insert row below row ${insertIdx}`;
      hhHBtn.title = label;
      hhHBtn.setAttribute('aria-label', label);
      hhH.classList.add('on');
    }
  }

  let overCircle = false;
  for (const hb of [hhVBtn, hhHBtn]) {
    hb.addEventListener('mouseenter', () => { overCircle = true; });
    hb.addEventListener('mouseleave', () => { overCircle = false; hideHandles(); });
  }
  let suppressHandles = false;
  stage.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest('.te-hh button')) return;
    suppressHandles = true;
    hideHandles();
  }, true);
  window.addEventListener('mouseup', () => { suppressHandles = false; }, true);

  function gutterCellAtPoint(selector: '.te-num' | '.te-letter', clientX: number, clientY: number): HTMLElement | null {
    for (const cell of grid.querySelectorAll<HTMLElement>(selector)) {
      if (isPointInsideRect(clientX, clientY, cell.getBoundingClientRect())) return cell;
    }
    return null;
  }

  stage.addEventListener('mousemove', (e) => {
    if (suppressHandles) return;
    const t = e.target as HTMLElement;
    if (t.closest('.te-grip-c, .te-grip-r')) { hideHandles(); return; }
    const rowCell = (t.closest('.te-num') as HTMLElement | null)
      ?? gutterCellAtPoint('.te-num', e.clientX, e.clientY);
    const columnCell = (t.closest('.te-letter') as HTMLElement | null)
      ?? gutterCellAtPoint('.te-letter', e.clientX, e.clientY);
    const rowIntent = rowCell
      ? getRowInsertionIntent(e.clientX, e.clientY, rowCell.getBoundingClientRect(), Number(rowCell.dataset.ri))
      : null;
    const columnIntent = columnCell
      ? getColumnInsertionIntent(e.clientX, e.clientY, columnCell.getBoundingClientRect(), Number(columnCell.dataset.ci))
      : null;
    if (!rowIntent && !columnIntent) {
      if (!t.closest('.te-hh button')) hideHandles();
      return;
    }
    if (columnIntent && columnCell) showHandle('v', columnIntent.index, columnCell, columnIntent.edge);
    else hhV.classList.remove('on');
    if (rowIntent && rowCell) showHandle('h', rowIntent.index, rowCell, rowIntent.edge);
    else hhH.classList.remove('on');
  });
  grid.addEventListener('mouseleave', (e) => {
    // mouseleave fires BEFORE the circle's mouseenter when the pointer crosses
    // onto the straddling button — recognise that hop via relatedTarget so the
    // circle survives (instant hide still applies to every other exit).
    const to = e.relatedTarget as HTMLElement | null;
    if (to && to.closest && to.closest('.te-hh')) return;
    if (!overCircle) hideHandles(); // leaving the table entirely → instant hide
  });
  scroll.addEventListener('scroll', hideHandles, { passive: true });

  // ---------- ops bar ----------
  const bar = el('div', 'te-bar');
  const readout = el('span', 'te-readout');
  const chipBox = el('span', 'te-chipbox');
  const undoBtn = el('button', 'te-btn'); undoBtn.type = 'button'; undoBtn.textContent = '↶'; undoBtn.setAttribute('aria-label', 'Undo'); undoBtn.title = 'Undo — Ctrl+Z (inside this editor)';
  const redoBtn = el('button', 'te-btn'); redoBtn.type = 'button'; redoBtn.textContent = '↷'; redoBtn.setAttribute('aria-label', 'Redo'); redoBtn.title = 'Redo — Ctrl+Shift+Z';
  const sep = () => el('span', 'te-sep');
  bar.append(readout, chipBox, sep(), undoBtn, redoBtn, sep());

  const fmtBtns: { marker: string; b: HTMLButtonElement }[] = [];
  const mkFmt = (html: string, marker: string, name: string, hint: string): void => {
    const b = el('button', 'te-btn'); b.type = 'button'; b.innerHTML = html;
    b.setAttribute('aria-label', name);
    b.title = hint;
    b.addEventListener('mousedown', (e) => e.preventDefault()); // keep cell focus
    b.addEventListener('click', () => applyMarker(marker));
    fmtBtns.push({ marker, b });
    bar.appendChild(b);
  };
  mkFmt('<b>B</b>', '**', 'Bold', 'Bold — Ctrl+B (cell, selection, row, column, or table — empties are skipped)');
  mkFmt('<i>I</i>', '*', 'Italic', 'Italic — Ctrl+I');
  mkFmt('<s>S</s>', '~~', 'Strikethrough', 'Strikethrough');
  mkFmt('{}', '`', 'Code', 'Inline code — Ctrl+E');
  const linkBtn = el('button', 'te-btn'); linkBtn.type = 'button'; linkBtn.textContent = '🔗'; linkBtn.setAttribute('aria-label', 'Link'); linkBtn.title = 'Wrap the selected cell(s) in a Markdown link — Ctrl+K';
  linkBtn.addEventListener('mousedown', (e) => e.preventDefault());
  linkBtn.addEventListener('click', openCellLink);
  bar.appendChild(linkBtn);
  bar.appendChild(sep());

  const alignBtns: { al: Align; b: HTMLButtonElement }[] = [];
  const mkAlign = (al: Align, label: string, title: string): void => {
    const b = el('button', 'te-btn'); b.type = 'button'; b.textContent = label; b.title = title;
    b.dataset.al = al;
    b.setAttribute('aria-label', title);
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => applyAlign(al));
    alignBtns.push({ al, b });
    bar.appendChild(b);
  };
  mkAlign('left', '⇤ L', 'Align left — column-level in Markdown; applies to the column(s) touched by the selection');
  mkAlign('center', '⇹ C', 'Align center — column-level in Markdown; applies to the column(s) touched by the selection');
  mkAlign('right', 'R ⇥', 'Align right — column-level in Markdown; applies to the column(s) touched by the selection');
  bar.appendChild(sep());

  const structBox = el('span', 'te-struct');
  bar.appendChild(structBox);
  const grow = el('span', 'tgrow');
  const addRowBtn = el('button', 'te-btn'); addRowBtn.type = 'button'; addRowBtn.textContent = '+ Row'; addRowBtn.title = 'Append a row at the bottom';
  addRowBtn.addEventListener('click', () => insertRowAt(model.rows.length, true));
  const addColBtn = el('button', 'te-btn'); addColBtn.type = 'button'; addColBtn.textContent = '+ Column'; addColBtn.title = 'Append a column on the right';
  addColBtn.addEventListener('click', () => insertColAt(cols(), true));
  bar.append(grow, addRowBtn, addColBtn);

  const BASE_HINT = 'Enter ↓ · Tab → (creates a row at the end) · Ctrl/Shift-click row numbers & letters to multi-select · move to a row number\'s top/bottom-left corner for Row + · move to a column letter\'s top-left/top-right corner for Column + · drag a letter/number edge to resize · Ctrl+Z undoes structural edits';
  const hint = el('p', 'te-hint muted-note');

  root.append(bar, stage, hint); // ops bar pinned at the TOP — always findable while scrolling

  // ---------- snapshot undo/redo ----------
  const snap = (): string => JSON.stringify({ rows: model.rows, aligns: model.aligns });
  function pushUndo(): void {
    undoStack.push(snap());
    if (undoStack.length > 60) undoStack.shift();
    redoStack.length = 0;
  }
  function restore(json: string): void {
    const m = JSON.parse(json) as Model;
    model.rows = m.rows.map((r) => r.slice());
    model.aligns = m.aligns.slice();
    while (colW.length < cols()) colW.push(undefined);
    colW.length = cols();
    while (rowH.length < model.rows.length) rowH.push(undefined);
    rowH.length = model.rows.length;
    if (sel && sel.kind === 'row' && sel.i >= model.rows.length) sel = null;
    if (sel && sel.kind === 'col' && sel.i >= cols()) sel = null;
    if (sel && sel.kind === 'rows' && [...sel.set].some((r) => r >= model.rows.length)) sel = null;
    if (sel && sel.kind === 'cols' && [...sel.set].some((c) => c >= cols())) sel = null;
    rerender();
  }
  function undoOp(): void {
    if (!undoStack.length) return;
    redoStack.push(snap());
    restore(undoStack.pop()!);
    toast('Undone.', 'info', 1200);
  }
  function redoOp(): void {
    if (!redoStack.length) return;
    undoStack.push(snap());
    restore(redoStack.pop()!);
    toast('Redone.', 'info', 1200);
  }
  undoBtn.addEventListener('click', undoOp);
  redoBtn.addEventListener('click', redoOp);

  // ---------- selection ----------
  function setSel(next: Sel): void {
    sel = next;
    paintSel();
    refreshBar();
  }
  function eachSelRow(fn: (r: number) => void): void {
    if (!sel) return;
    if (sel.kind === 'row') fn(sel.i);
    else if (sel.kind === 'rows') sel.set.forEach(fn);
  }
  function eachSelCol(fn: (c: number) => void): void {
    if (!sel) return;
    if (sel.kind === 'col') fn(sel.i);
    else if (sel.kind === 'cols') sel.set.forEach(fn);
  }
  function paintSel(): void {
    grid.querySelectorAll('.te-sel').forEach((e2) => e2.classList.remove('te-sel'));
    if (!sel) return;
    if (sel.kind === 'row' || sel.kind === 'rows' || sel.kind === 'all') {
      const rows = sel.kind === 'row' ? [sel.i] : sel.kind === 'rows' ? [...sel.set] : model.rows.map((_, i) => i);
      for (const r of rows) {
        grid.querySelector(`.te-num[data-ri="${r}"]`)?.classList.add('te-sel');
        grid.querySelectorAll(`td[data-r="${r}"]`).forEach((td) => td.classList.add('te-sel'));
      }
    }
    if (sel.kind === 'col' || sel.kind === 'cols' || sel.kind === 'all') {
      const cs = sel.kind === 'col' ? [sel.i] : sel.kind === 'cols' ? [...sel.set] : Array.from({ length: cols() }, (_, i) => i);
      for (const c of cs) {
        grid.querySelector(`.te-letter[data-ci="${c}"]`)?.classList.add('te-sel');
        grid.querySelectorAll(`td[data-c="${c}"]`).forEach((td) => td.classList.add('te-sel'));
      }
    }
    if (sel.kind === 'all') grid.querySelector('.te-corner')?.classList.add('te-sel');
    if (sel.kind === 'cell') grid.querySelector(`td[data-r="${sel.r}"][data-c="${sel.c}"]`)?.classList.add('te-sel');
  }

  function cellsOfSelection(): HTMLInputElement[] {
    const all = [...grid.querySelectorAll<HTMLInputElement>('input.te-cell')];
    if (!sel) return lastCell ? [lastCell] : [];
    switch (sel.kind) {
      case 'all': return all;
      case 'row': return all.filter((i) => Number(i.dataset.r) === (sel as { i: number }).i);
      case 'col': return all.filter((i) => Number(i.dataset.c) === (sel as { i: number }).i);
      case 'rows': { const set = (sel as { set: Set<number> }).set; return all.filter((i) => set.has(Number(i.dataset.r))); }
      case 'cols': { const set = (sel as { set: Set<number> }).set; return all.filter((i) => set.has(Number(i.dataset.c))); }
      case 'cell': return all.filter((i) => Number(i.dataset.r) === (sel as { r: number; c: number }).r && Number(i.dataset.c) === (sel as { r: number; c: number }).c);
    }
  }
  function colsOfSelection(): number[] {
    if (!sel) return lastCell ? [Number(lastCell.dataset.c)] : [];
    switch (sel.kind) {
      case 'all': case 'row': case 'rows': return Array.from({ length: cols() }, (_, i) => i);
      case 'col': return [(sel as { i: number }).i];
      case 'cols': return [...(sel as { set: Set<number> }).set];
      case 'cell': return [(sel as { c: number }).c];
    }
  }

  function selLabel(): string {
    if (!sel && lastCell) return `Cell ${colLetter(Number(lastCell.dataset.c))}${Number(lastCell.dataset.r) + 1}`;
    if (!sel) return 'No selection — click a cell, a row number, or a column letter';
    switch (sel.kind) {
      case 'cell': return `Cell ${colLetter(sel.c)}${sel.r + 1}`;
      case 'row': return sel.i === 0 ? 'Row 1 — header' : `Row ${sel.i + 1}`;
      case 'rows': return `Rows ${fmtRanges([...sel.set], (n) => String(n + 1))}`;
      case 'col': return `Column ${colLetter(sel.i)}`;
      case 'cols': return `Columns ${fmtRanges([...sel.set], colLetter)}`;
      case 'all': return `All cells (${model.rows.length} × ${cols()})`;
    }
  }

  // ---------- bar refresh ----------
  function refreshBar(): void {
    const targets = cellsOfSelection();
    const markState = (input: HTMLInputElement, marker: InlineMarker) => {
      const hasRange = lastCell === input && (input.selectionStart ?? 0) !== (input.selectionEnd ?? 0);
      return getInlineMarkState(
        input.value,
        hasRange ? (input.selectionStart ?? 0) : 0,
        hasRange ? (input.selectionEnd ?? 0) : 0,
        hasRange ? 'selection' : 'all',
        marker,
      );
    };
    readout.textContent = selLabel();
    undoBtn.disabled = !undoStack.length;
    redoBtn.disabled = !redoStack.length;
    for (const { marker, b } of fmtBtns) {
      b.disabled = !targets.length;
      const states = targets.map((input) => markState(input, marker as InlineMarker));
      const allActive = states.length > 0 && states.every((state) => state === 'active');
      const anyActive = states.some((state) => state === 'active' || state === 'mixed');
      b.classList.toggle('active', allActive);
      b.classList.toggle('mixed', !allActive && anyActive);
    }
    linkBtn.disabled = !targets.length;
    const tCols = colsOfSelection();
    const uniform = tCols.length > 0 && tCols.every((c) => model.aligns[c] === model.aligns[tCols[0]]);
    for (const { al, b } of alignBtns) {
      b.disabled = !tCols.length;
      b.classList.toggle('active', uniform && model.aligns[tCols[0]] === al);
    }
    // filter chip
    chipBox.innerHTML = '';
    if (filter) {
      const chip = el('span', 'te-chip');
      chip.textContent = `Filter: ${colLetter(filter.c)} contains “${filter.text}”`;
      const x = el('button', 'te-chip-x'); x.type = 'button'; x.textContent = '✕'; x.setAttribute('aria-label', 'Clear filter');
      x.title = 'Clear filter (view-only — Apply always writes every row)';
      x.addEventListener('click', () => { filter = null; applyFilter(); refreshBar(); });
      chip.appendChild(x);
      chipBox.appendChild(chip);
    }
    // contextual structural ops
    structBox.innerHTML = '';
    const sbtn = (label: string, title: string, aria: string, fn: () => void, opts?: { disabled?: boolean; danger?: boolean }): void => {
      const b = el('button', 'te-btn' + (opts?.danger ? ' danger' : ''));
      b.type = 'button'; b.textContent = label; b.title = title; b.setAttribute('aria-label', aria);
      b.disabled = !!opts?.disabled;
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', fn);
      structBox.appendChild(b);
    };
    if (sel?.kind === 'row') {
      const i = sel.i;
      if (i > 0) {
        sbtn('⇪ Header', 'Make this row the header row', 'Make this row the header row', () => chooseHeaderMode(i));
        sbtn('⧉', 'Duplicate this row', 'Duplicate row', () => { pushUndo(); syncModel(); model.rows.splice(i + 1, 0, model.rows[i].slice()); rowH.splice(i + 1, 0, rowH[i]); rerender(); setSel({ kind: 'row', i: i + 1 }); });
        sbtn('↑', 'Move row up', 'Move row up', () => { pushUndo(); syncModel(); [model.rows[i - 1], model.rows[i]] = [model.rows[i], model.rows[i - 1]]; [rowH[i - 1], rowH[i]] = [rowH[i], rowH[i - 1]]; rerender(); setSel({ kind: 'row', i: i - 1 }); }, { disabled: i <= 1 });
        sbtn('↓', 'Move row down', 'Move row down', () => { pushUndo(); syncModel(); [model.rows[i + 1], model.rows[i]] = [model.rows[i], model.rows[i + 1]]; [rowH[i + 1], rowH[i]] = [rowH[i], rowH[i + 1]]; rerender(); setSel({ kind: 'row', i: i + 1 }); }, { disabled: i >= model.rows.length - 1 });
      }
      sbtn('⌫', `Clear row ${i + 1} contents`, 'Clear row contents', clearSelection);
      sbtn('🗑', i === 0 ? 'The header row is required — use ⇪ Header on another row to replace it' : model.rows.length <= 2 ? 'A table keeps at least one body row' : 'Delete this row (Ctrl+Z to undo)',
        'Delete row', () => { pushUndo(); syncModel(); model.rows.splice(i, 1); rowH.splice(i, 1); rerender(); setSel(null); toast('Row deleted — Ctrl+Z to undo.', 'info'); },
        { disabled: i === 0 || model.rows.length <= 2, danger: true });
    } else if (sel?.kind === 'col') {
      const i = sel.i;
      sbtn('⇅ A→Z', 'Sort body rows ascending by this column (header stays)', 'Sort A to Z', () => sortBy(i, 1));
      sbtn('⇅ Z→A', 'Sort body rows descending by this column (header stays)', 'Sort Z to A', () => sortBy(i, -1));
      sbtn('▾ Filter', 'Show only rows containing… (view-only; never changes the document)', 'Filter this column', () => openFilter(i));
      sbtn('⧉', 'Duplicate this column', 'Duplicate column', () => { pushUndo(); syncModel(); model.rows.forEach((r) => r.splice(i + 1, 0, r[i])); model.aligns.splice(i + 1, 0, model.aligns[i]); colW.splice(i + 1, 0, colW[i]); rerender(); setSel({ kind: 'col', i: i + 1 }); });
      sbtn('←', 'Move column left', 'Move column left', () => { pushUndo(); syncModel(); model.rows.forEach((r) => [r[i - 1], r[i]] = [r[i], r[i - 1]]); [model.aligns[i - 1], model.aligns[i]] = [model.aligns[i], model.aligns[i - 1]]; [colW[i - 1], colW[i]] = [colW[i], colW[i - 1]]; rerender(); setSel({ kind: 'col', i: i - 1 }); }, { disabled: i <= 0 });
      sbtn('→', 'Move column right', 'Move column right', () => { pushUndo(); syncModel(); model.rows.forEach((r) => [r[i + 1], r[i]] = [r[i], r[i + 1]]); [model.aligns[i + 1], model.aligns[i]] = [model.aligns[i], model.aligns[i + 1]]; [colW[i + 1], colW[i]] = [colW[i], colW[i + 1]]; rerender(); setSel({ kind: 'col', i: i + 1 }); }, { disabled: i >= cols() - 1 });
      sbtn('⌫', `Clear column ${colLetter(i)} contents`, 'Clear column contents', clearSelection);
      sbtn('🗑', cols() <= 1 ? 'A table keeps at least one column' : 'Delete this column (Ctrl+Z to undo)', 'Delete column',
        () => { pushUndo(); syncModel(); model.rows.forEach((r) => r.splice(i, 1)); model.aligns.splice(i, 1); colW.splice(i, 1); rerender(); setSel(null); toast('Column deleted — Ctrl+Z to undo.', 'info'); },
        { disabled: cols() <= 1, danger: true });
    } else if (sel?.kind === 'rows') {
      const set = [...sel.set];
      const bodyCount = set.filter((i) => i > 0).length;
      sbtn('⌫', `Clear rows ${fmtRanges(set, (n) => String(n + 1))} contents`, 'Clear selected rows', clearSelection);
      sbtn('🗑',
        bodyCount === 0 ? 'The header row is required' : model.rows.length - bodyCount < 2 ? 'A table keeps at least one body row' : `Delete ${fmtRanges(set, (n) => 'row ' + (n + 1))} (Ctrl+Z to undo)`,
        'Delete rows', () => {
          pushUndo(); syncModel();
          const hadHeader = sel!.kind === 'rows' && (sel as { set: Set<number> }).set.has(0);
          model.rows = model.rows.filter((_, i2) => i2 === 0 || !(sel as { set: Set<number> }).set.has(i2));
          rowH = rowH.filter((_, i2) => i2 === 0 || !(sel as { set: Set<number> }).set.has(i2));
          rerender(); setSel(null);
          toast(`${bodyCount} row${bodyCount === 1 ? '' : 's'} deleted — Ctrl+Z to undo.` + (hadHeader ? ' Header row was kept.' : ''), 'info');
        },
        { disabled: bodyCount === 0 || model.rows.length - bodyCount < 2, danger: true });
    } else if (sel?.kind === 'cols') {
      const set = [...sel.set];
      sbtn('⌫', `Clear columns ${fmtRanges(set, colLetter)} contents`, 'Clear selected columns', clearSelection);
      sbtn('🗑',
        cols() - set.length < 1 ? 'A table keeps at least one column' : `Delete columns ${fmtRanges(set, colLetter)} (Ctrl+Z to undo)`,
        'Delete columns', () => {
          pushUndo(); syncModel();
          model.rows = model.rows.map((r) => r.filter((_, c2) => !(sel as { set: Set<number> }).set.has(c2)));
          model.aligns = model.aligns.filter((_, c2) => !(sel as { set: Set<number> }).set.has(c2));
          colW = colW.filter((_, c2) => !(sel as { set: Set<number> }).set.has(c2));
          rerender(); setSel(null);
          toast('Columns deleted — Ctrl+Z to undo.', 'info');
        },
        { disabled: cols() - set.length < 1, danger: true });
    } else if (sel?.kind === 'all') {
      sbtn('⌫', 'Clear every cell (Ctrl+Z to undo)', 'Clear all cells', clearSelection);
    }
    structBox.style.display = structBox.childElementCount ? '' : 'none';
    hint.textContent = filter
      ? `${BASE_HINT} · Filtered: showing ${visibleBodyCount()}/${model.rows.length - 1} body rows (view-only — Apply writes every row)`
      : BASE_HINT;
  }

  // ---------- operations ----------
  function syncModel(): void {
    for (const inp of Array.from(grid.querySelectorAll<HTMLInputElement>('input.te-cell'))) {
      const r = Number(inp.dataset.r);
      if (model.rows[r]) model.rows[r][Number(inp.dataset.c)] = inp.value;
    }
  }

  /**
   * Formatting with Excel-style SYNC semantics (#2) — for multi-cell targets:
   *   not all cells have the layer → ADD it to every non-empty cell missing it
   *   all cells have it → REMOVE it from all
   * Single cell keeps parity toggle. Empty cells are never decorated (#9).
   */
  function applyMarker(marker: string): void {
    const targets = cellsOfSelection();
    if (!targets.length) { toast('Click a cell, row number, or column letter first.', 'info'); return; }

    const bulk = targets.length > 1 || sel?.kind === 'rows' || sel?.kind === 'cols' || sel?.kind === 'all';
    if (!bulk) {
      const inp = targets[0];
      const start = inp.selectionStart ?? 0;
      const end = inp.selectionEnd ?? 0;
      const result = toggleInlineMarkup(inp.value, start, end, marker as InlineMarker, {
        scope: start === end ? 'all' : 'selection',
      });
      if (!result.changed) return;
      pushUndo();
      syncModel();
      inp.value = result.next;
      model.rows[Number(inp.dataset.r)][Number(inp.dataset.c)] = result.next;
      inp.focus();
      if (start !== end) inp.setSelectionRange(result.selectionStart, result.selectionEnd);
      refreshBar();
      return;
    }

    const usable = targets.filter((input) => input.value.trim());
    if (!usable.length) { toast('Selected cells are empty — nothing to format.', 'info'); return; }
    const allHave = usable.every((input) => getInlineMarkState(input.value, 0, 0, 'all', marker as InlineMarker) === 'active');
    const action = allHave ? 'remove' : 'add';
    const changes = usable.map((input) => ({ input, result: toggleInlineMarkup(input.value, 0, 0, marker as InlineMarker, { scope: 'all', action }) }))
      .filter(({ result }) => result.changed);
    if (!changes.length) return;
    pushUndo();
    syncModel();
    for (const { input, result } of changes) {
      input.value = result.next;
      model.rows[Number(input.dataset.r)][Number(input.dataset.c)] = result.next;
    }
    toast(`${allHave ? 'Removed from' : 'Applied to'} ${changes.length} cell${changes.length === 1 ? '' : 's'}${targets.length - usable.length ? ` · ${targets.length - usable.length} empty skipped` : ''}.`, 'ok');
    refreshBar();
  }

  function applyAlign(al: Align): void {
    const tCols = colsOfSelection();
    if (!tCols.length) { toast('Select a column, row, or cell first.', 'info'); return; }
    const uniform = tCols.every((c) => model.aligns[c] === model.aligns[tCols[0]]);
    const next: Align = uniform && model.aligns[tCols[0]] === al ? '' : al; // click active align again → back to default
    pushUndo();
    for (const c of tCols) model.aligns[c] = next;
    for (const c of tCols) {
      grid.querySelectorAll<HTMLInputElement>(`input.te-cell[data-c="${c}"]`).forEach((i) => { i.style.textAlign = next || ''; });
    }
    refreshBar();
    if (sel?.kind === 'cell') {
      toast(`Aligned column ${colLetter(sel.c)} — Markdown has no per-cell alignment: the | :---: | row holds one rule per column.`, 'info', 4200);
    }
  }

  function clearSelection(): void {
    const targets = cellsOfSelection();
    if (!targets.length) return;
    pushUndo();
    syncModel();
    for (const inp of targets) {
      inp.value = '';
      model.rows[Number(inp.dataset.r)][Number(inp.dataset.c)] = '';
    }
    refreshBar();
  }

  // body-only, stable, locale+numeric aware sort; header never participates (#6)
  function sortBy(c: number, dir: 1 | -1): void {
    pushUndo();
    syncModel();
    const head = model.rows[0];
    const body = model.rows.slice(1).map((r, i) => ({ r, i }));
    body.sort((a, b) => {
      const cmp = (a.r[c] ?? '').trim().localeCompare((b.r[c] ?? '').trim(), undefined, { numeric: true, sensitivity: 'base' });
      return (cmp || a.i - b.i) * (dir === 1 ? 1 : -1);
    });
    const sortedRows = body.map((x) => x.r);
    const sortedH = body.map((x) => rowH[x.i + 1]);
    model.rows = [head, ...sortedRows];
    rowH = [rowH[0], ...sortedH];
    rerender();
    toast(`Sorted by column ${colLetter(c)} (${dir === 1 ? 'A→Z' : 'Z→A'}) — header kept, body rows only.`, 'ok');
  }

  function openFilter(c: number): void {
    formDialog({
      title: `Filter column ${colLetter(c)}`,
      submitLabel: 'Apply filter',
      fields: [
        { key: 'q', label: 'Show only rows whose cell contains… (case-insensitive)', placeholder: 'e.g. Security', value: filter?.c === c ? filter.text : '' },
      ],
      onSubmit: ({ q }) => {
        filter = q.trim() ? { c, text: q.trim().toLowerCase() } : null;
        applyFilter();
        refreshBar();
        toast(filter ? 'Filter applied — view only. Apply writes every row.' : 'Filter cleared.', 'info');
      },
    });
  }
  function visibleBodyCount(): number {
    if (!filter) return model.rows.length - 1;
    return model.rows.slice(1).filter((r) => (r[filter!.c] ?? '').toLowerCase().includes(filter!.text)).length;
  }
  function applyFilter(): void {
    for (let r = 1; r < model.rows.length; r++) {
      const tr = tbody.querySelector(`tr[data-r="${r}"]`);
      if (!tr) continue;
      const show = !filter || (model.rows[r][filter.c] ?? '').toLowerCase().includes(filter.text);
      (tr as HTMLElement).style.display = show ? '' : 'none';
    }
  }

  function insertRowAt(idx: number, focus = false): void {
    pushUndo();
    syncModel();
    model.rows.splice(idx, 0, Array<string>(cols()).fill(''));
    rowH.splice(idx, 0, undefined);
    rerender();
    flash('row', idx);
    if (focus) focusCell(Math.min(idx, model.rows.length - 1), 0);
  }

  function insertColAt(idx: number, focus = false): void {
    const focusR = Math.min(Number(lastCell?.dataset.r ?? 0), model.rows.length - 1);
    pushUndo();
    syncModel();
    model.rows.forEach((r) => r.splice(idx, 0, ''));
    model.aligns.splice(idx, 0, '');
    colW.splice(idx, 0, undefined);
    rerender();
    flash('col', idx);
    if (focus) focusCell(focusR, Math.min(idx, cols() - 1));
  }

  function flash(kind: 'row' | 'col', idx: number): void {
    const cells: HTMLElement[] = [];
    if (kind === 'row') {
      grid.querySelectorAll(`td[data-r="${idx}"]`).forEach((td) => cells.push(td as HTMLElement));
      const num = grid.querySelector(`.te-num[data-ri="${idx}"]`);
      if (num) cells.push(num as HTMLElement);
    } else {
      grid.querySelectorAll(`td[data-c="${idx}"]`).forEach((td) => cells.push(td as HTMLElement));
      const letter = grid.querySelector(`.te-letter[data-ci="${idx}"]`);
      if (letter) cells.push(letter as HTMLElement);
    }
    cells.forEach((c) => c.classList.add('te-flash'));
    setTimeout(() => cells.forEach((c) => c.classList.remove('te-flash')), 950);
  }

  function focusCell(r: number, c: number, select = true): void {
    const inp = grid.querySelector<HTMLInputElement>(`input.te-cell[data-r="${r}"][data-c="${c}"]`);
    if (inp) { inp.focus(); if (select) inp.select(); }
  }

  function chooseHeaderMode(rowIdx: number): void {
    const opts = el('div', 'te-hd-opts');
    const replaceBtn = el('button', 'te-hd-opt'); replaceBtn.type = 'button';
    replaceBtn.innerHTML = `<b>Replace — use row ${rowIdx + 1} as the header</b><span>Current header text is discarded. Row ${rowIdx + 1} moves up and the table keeps ${model.rows.length - 1} body row${model.rows.length - 2 === 1 ? '' : 's'}.</span>`;
    const moveBtn = el('button', 'te-hd-opt'); moveBtn.type = 'button';
    moveBtn.innerHTML = `<b>Move — promote row ${rowIdx + 1}, keep the old header</b><span>Row ${rowIdx + 1} becomes the header; the current header becomes body row 2. Nothing is lost.</span>`;
    opts.append(replaceBtn, moveBtn);
    const cancel = el('button', 'btn ghost'); cancel.type = 'button'; cancel.textContent = 'Cancel';
    const h = openModal({ title: `Make row ${rowIdx + 1} the header?`, body: opts, foot: [cancel] });
    cancel.addEventListener('click', h.close);
    replaceBtn.addEventListener('click', () => {
      pushUndo(); syncModel();
      model.rows[0] = model.rows[rowIdx].slice();
      model.rows.splice(rowIdx, 1);
      rowH.splice(rowIdx, 1);
      h.close(); rerender(); setSel({ kind: 'row', i: 0 });
      toast('Header replaced — the old header was discarded (Ctrl+Z to undo).', 'ok');
    });
    moveBtn.addEventListener('click', () => {
      pushUndo(); syncModel();
      const promoted = model.rows.splice(rowIdx, 1)[0];
      const oldHeader = model.rows.shift()!;
      model.rows.unshift(promoted, oldHeader);
      const promotedH = rowH.splice(rowIdx, 1)[0];
      const oldH = rowH.shift();
      rowH.unshift(promotedH, oldH);
      h.close(); rerender(); setSel({ kind: 'row', i: 0 });
      toast('Row promoted — the old header is now body row 2.', 'ok');
    });
  }

  function openCellLink(): void {
    const targets = cellsOfSelection();
    if (!targets.length) return;
    const first = targets[0].value.trim();
    const m = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(first);
    formDialog({
      title: 'Link selected cell(s)',
      submitLabel: 'Apply link',
      fields: [
        { key: 'text', label: 'Link text — leave blank to keep each cell’s own text', placeholder: 'Read the docs', value: m?.[1] ?? '' },
        { key: 'url', label: 'URL', type: 'url', placeholder: 'https://example.com', value: m?.[2] ?? '' },
      ],
      onSubmit: ({ text, url }) => {
        if (!url) return;
        const safe = /^https?:\/\//i.test(url) ? url : `https://${url}`;
        pushUndo(); syncModel();
        for (const inp of targets) {
          const cur = inp.value.trim();
          if (!cur) continue;
          const lm = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(cur);
          const label = text.trim() || (lm?.[1] ?? cur) || safe;
          const next = `[${label}](${safe})`;
          inp.value = next;
          model.rows[Number(inp.dataset.r)][Number(inp.dataset.c)] = next;
        }
        refreshBar();
        toast('Link applied.', 'ok');
      },
    });
  }

  // ---------- paste ----------
  function pasteMatrix(r0: number, c0: number, text: string): boolean {
    const matrix = text.replace(/\r/g, '').replace(/\n$/, '').split('\n').map((l) => l.split('\t'));
    let pasteHeader: string[] | null = null;
    if (r0 === 0 && matrix.length > 1) pasteHeader = matrix.shift()!;
    const colsNeeded = Math.max(...matrix.map((r) => r.length), pasteHeader?.length ?? 0);
    while (cols() < c0 + colsNeeded) { model.rows.forEach((row) => row.push('')); model.aligns.push(''); colW.push(undefined); }
    if (pasteHeader) pasteHeader.forEach((v, j) => { model.rows[0][c0 + j] = v.trim(); });
    const startRow = pasteHeader ? 1 : r0;
    matrix.forEach((row, i) => {
      const r = startRow + i;
      while (model.rows.length <= r) { model.rows.push(Array<string>(cols()).fill('')); rowH.push(undefined); }
      row.forEach((val, j) => { model.rows[r][c0 + j] = val.trim(); });
    });
    return pasteHeader !== null;
  }

  function replaceAll(text: string): void {
    const matrix = text.replace(/\r/g, '').replace(/\n$/, '').split('\n').map((l) => l.split('\t'));
    if (!matrix.length) return;
    const width = Math.max(...matrix.map((r) => r.length), 1);
    model.rows = matrix.map((row) => {
      const r = row.map((v) => v.trim());
      while (r.length < width) r.push('');
      return r;
    });
    while (model.aligns.length < width) model.aligns.push('');
    model.aligns.length = width;
    while (colW.length < width) colW.push(undefined);
    colW.length = width;
    rowH = Array.from({ length: model.rows.length }, () => undefined);
  }

  grid.addEventListener('paste', (e: ClipboardEvent) => {
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (!/[\t\n]/.test(text)) return;
    const inp = e.target as HTMLInputElement;
    if (!inp.classList?.contains('te-cell')) return;
    e.preventDefault();
    pushUndo();
    syncModel();
    if (sel?.kind === 'all') {
      replaceAll(text);
      rerender();
      setSel(null);
      toast('Whole table replaced from the clipboard.', 'ok');
      return;
    }
    const becameHeader = pasteMatrix(Number(inp.dataset.r), Number(inp.dataset.c), text);
    rerender();
    setSel({ kind: 'cell', r: Number(inp.dataset.r), c: Number(inp.dataset.c) });
    toast(becameHeader ? 'Pasted — first copied row became the header row.' : 'Spreadsheet data pasted into the table.', 'ok');
  });

  // ---------- copy/cut out (row/col selections → TSV) ----------
  function selTSV(): string {
    const selected = sel;
    if (!selected || selected.kind === 'cell') return '';
    if (selected.kind === 'row') return model.rows[selected.i].join('\t');
    if (selected.kind === 'col') return model.rows.map((r) => r[selected.i] ?? '').join('\n');
    if (selected.kind === 'rows') return [...selected.set].sort((a, b) => a - b).map((i) => model.rows[i].join('\t')).join('\n');
    if (selected.kind === 'cols') {
      const cs = [...selected.set].sort((a, b) => a - b);
      return model.rows.map((r) => cs.map((c) => r[c] ?? '').join('\t')).join('\n');
    }
    return model.rows.map((r) => r.join('\t')).join('\n');
  }
  function gridClipboard(e: ClipboardEvent): void {
    if (!sel || sel.kind === 'cell') return; // native input copy
    const t = e.target as HTMLInputElement;
    if (t.classList?.contains('te-cell') && (t.selectionStart ?? 0) !== (t.selectionEnd ?? 0)) return; // user copied text within a cell
    e.preventDefault();
    e.clipboardData?.setData('text/plain', selTSV());
    if (e.type === 'cut') clearSelection();
  }
  stage.addEventListener('copy', gridClipboard);
  stage.addEventListener('cut', gridClipboard);

  // ---------- column/row resize (editor view only; #8) ----------
  function setColW(j: number, px: number): void {
    colW[j] = Math.max(64, Math.min(520, Math.round(px)));
    const w = `${colW[j]}px`;
    const th = grid.querySelector<HTMLElement>(`.te-letter[data-ci="${j}"]`);
    if (th) { th.style.minWidth = w; th.style.width = w; }
    grid.querySelectorAll<HTMLElement>(`td[data-c="${j}"]`).forEach((td) => { td.style.minWidth = w; td.style.width = w; td.style.maxWidth = w; });
  }
  function setRowH(r: number, px: number): void {
    rowH[r] = Math.max(28, Math.min(200, Math.round(px)));
    const h = `${rowH[r]}px`;
    const tr = tbody.querySelector<HTMLElement>(`tr[data-r="${r}"]`);
    if (tr) {
      tr.style.height = h;
      tr.querySelectorAll<HTMLInputElement>('input').forEach((i) => { i.style.height = '100%'; });
    }
  }
  function addResizeGrip(host: HTMLElement, axis: 'x' | 'y', start: () => number, apply: (px: number) => void): void {
    const g = el('span', axis === 'x' ? 'te-grip-c' : 'te-grip-r');
    g.title = axis === 'x' ? 'Drag to resize this column (editor view only — Markdown has no column widths)' : 'Drag to resize this row (editor view only)';
    host.appendChild(g);
    g.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const s0 = axis === 'x' ? e.clientX : e.clientY;
      const w0 = start();
      const mv = (ev: MouseEvent) => { apply(w0 + ((axis === 'x' ? ev.clientX : ev.clientY) - s0)); };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });
  }

  // ---------- grid construction ----------
  function buildCtl(): void {
    thead.innerHTML = '';
    const tr = el('tr', 'te-ctl');
    const corner = el('th', 'te-corner');
    corner.textContent = '▦';
    corner.title = 'Select the whole table';
    corner.setAttribute('aria-label', 'Select the whole table');
    corner.addEventListener('click', () => setSel(sel?.kind === 'all' ? null : { kind: 'all' }));
    tr.appendChild(corner);
    for (let c = 0; c < cols(); c++) {
      const th = el('th', 'te-letter');
      th.dataset.ci = String(c);
      th.title = `Select column ${colLetter(c)} (Ctrl/Shift-click to multi-select)`;
      th.setAttribute('aria-label', `Select column ${colLetter(c)}`);
      if (colW[c]) { th.style.minWidth = `${colW[c]}px`; th.style.width = `${colW[c]}px`; }
      const span = el('span', 'te-lab');
      span.textContent = colLetter(c);
      th.appendChild(span);
      th.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.te-grip-c')) return;
        if (e.shiftKey) {
          const set = new Set<number>();
          for (let i = Math.min(anchorCol, c); i <= Math.max(anchorCol, c); i++) set.add(i);
          setSel(set.size === 1 ? { kind: 'col', i: c } : { kind: 'cols', set });
        } else if (e.ctrlKey || e.metaKey) {
          if (sel?.kind === 'cols') {
            const set = new Set(sel.set);
            if (set.has(c)) set.delete(c); else set.add(c);
            setSel(set.size === 1 ? { kind: 'col', i: [...set][0] } : set.size ? { kind: 'cols', set } : null);
          } else if (sel?.kind === 'col' && sel.i !== c) {
            setSel({ kind: 'cols', set: new Set([sel.i, c]) });
          } else {
            setSel({ kind: 'col', i: c });
          }
        } else {
          anchorCol = c;
          setSel(sel?.kind === 'col' && sel.i === c ? null : { kind: 'col', i: c });
        }
      });
      addResizeGrip(th, 'x',
        () => grid.querySelector<HTMLElement>(`td[data-c="${c}"]`)?.getBoundingClientRect().width ?? 96,
        (px) => setColW(c, px));
      tr.appendChild(th);
    }
    thead.appendChild(tr);
  }

  function buildBody(): void {
    tbody.innerHTML = '';
    for (let r = 0; r < model.rows.length; r++) {
      const tr = el('tr');
      tr.dataset.r = String(r);
      if (r === 0) tr.classList.add('te-hrow');
      if (rowH[r]) tr.style.height = `${rowH[r]}px`;
      const num = el('th', 'te-num');
      num.dataset.ri = String(r);
      num.textContent = String(r + 1);
      num.title = r === 0 ? 'Row 1 — the header row (always first)' : `Select row ${r + 1} (Ctrl/Shift-click to multi-select)`;
      num.setAttribute('aria-label', r === 0 ? 'Select the header row' : `Select row ${r + 1}`);
      num.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.te-grip-r')) return;
        if (e.shiftKey) {
          const set = new Set<number>();
          for (let i = Math.min(anchorRow, r); i <= Math.max(anchorRow, r); i++) set.add(i);
          setSel(set.size === 1 ? { kind: 'row', i: r } : { kind: 'rows', set });
        } else if (e.ctrlKey || e.metaKey) {
          if (sel?.kind === 'rows') {
            const set = new Set(sel.set);
            if (set.has(r)) set.delete(r); else set.add(r);
            setSel(set.size === 1 ? { kind: 'row', i: [...set][0] } : set.size ? { kind: 'rows', set } : null);
          } else if (sel?.kind === 'row' && sel.i !== r) {
            setSel({ kind: 'rows', set: new Set([sel.i, r]) });
          } else {
            setSel({ kind: 'row', i: r });
          }
        } else {
          anchorRow = r;
          setSel(sel?.kind === 'row' && sel.i === r ? null : { kind: 'row', i: r });
        }
      });
      addResizeGrip(num, 'y',
        () => tbody.querySelector<HTMLElement>(`tr[data-r="${r}"]`)?.getBoundingClientRect().height ?? 32,
        (px) => setRowH(r, px));
      tr.appendChild(num);
      for (let c = 0; c < cols(); c++) {
        const td = el('td');
        td.dataset.r = String(r);
        td.dataset.c = String(c);
        if (colW[c]) { td.style.minWidth = `${colW[c]}px`; td.style.width = `${colW[c]}px`; td.style.maxWidth = `${colW[c]}px`; }
        const inp = el('input', 'te-cell');
        inp.value = model.rows[r][c] ?? '';
        inp.dataset.r = String(r);
        inp.dataset.c = String(c);
        inp.style.textAlign = model.aligns[c] || '';
        if (rowH[r]) inp.style.height = '100%';
        inp.title = model.rows[r][c] ?? '';
        inp.setAttribute('aria-label', r === 0 ? `Header, column ${colLetter(c)}` : `Row ${r + 1}, column ${colLetter(c)}`);
        inp.addEventListener('input', () => {
          model.rows[r][c] = inp.value;
          inp.title = inp.value;
          refreshBar();
        });
        inp.addEventListener('select', refreshBar);
        td.appendChild(inp);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    applyFilter();
  }

  function rerender(): void {
    hideHandles();
    lastCell = null;
    buildCtl();
    buildBody();
    paintSel();
    refreshBar();
  }
  rerender();

  function openSourceDiff(): void {
    syncModel();
    const nextSource = serializeTable(model.rows, model.aligns);
    const diff = buildLineDiff(originalSource, nextSource, { equivalent: tableLinesEquivalent });
    const body = el('div', 'source-diff table-source-diff');
    const summary = el('p', 'muted-note');
    const normalizedLines = diff.filter((line) => line.kind === 'normalized').length;
    const addedLines = diff.filter((line) => line.kind === 'added').length;
    const removedLines = diff.filter((line) => line.kind === 'removed').length;
    const changedLines = Math.max(addedLines, removedLines);
    summary.textContent = nextSource === originalSource
      ? 'No Markdown changes are pending.'
      : `${changedLines} content line${changedLines === 1 ? '' : 's'} changed. Review the exact Markdown change before it reaches the document.${normalizedLines ? ` ${normalizedLines} line${normalizedLines === 1 ? '' : 's'} are shown as neutral context because only table padding was re-aligned.` : ''}`;
    body.appendChild(summary);
    const code = el('div', 'source-diff-code table-source-diff-code');
    for (const line of diff) {
      const row = el('div', `source-diff-line ${line.kind}`);
      const marker = el('span', 'source-diff-marker');
      marker.textContent = line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : line.kind === 'normalized' ? '·' : ' ';
      marker.setAttribute('aria-hidden', 'true');
      const text = el('code');
      text.textContent = line.text || ' ';
      row.append(marker, text);
      code.appendChild(row);
    }
    body.appendChild(code);
    const back = el('button', 'btn ghost');
    back.type = 'button';
    back.textContent = 'Back to editor';
    const confirm = el('button', 'btn primary');
    confirm.type = 'button';
    confirm.textContent = 'Apply changes';
    confirm.disabled = nextSource === originalSource;
    const review = openModal({ title: 'Review Markdown changes', body, foot: [back, confirm], wide: true });
    back.addEventListener('click', review.close);
    confirm.addEventListener('click', () => {
      onApply(nextSource);
      review.close();
      handle.close();
    });
  }

  grid.addEventListener('focusin', (e) => {
    const t = e.target as HTMLElement;
    if (t.classList?.contains('te-cell')) {
      lastCell = t as HTMLInputElement;
      const r = Number(lastCell.dataset.r);
      const c = Number(lastCell.dataset.c);
      if (sel?.kind !== 'cell' || sel.r !== r || sel.c !== c) setSel({ kind: 'cell', r, c });
    }
  });

  // ---------- keyboard ----------
  root.addEventListener('keydown', (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopPropagation(); undoOp(); return; }
    if (mod && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); e.stopPropagation(); redoOp(); return; }
    if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); e.stopPropagation(); applyMarker('**'); return; }
    if (mod && e.key.toLowerCase() === 'i') { e.preventDefault(); e.stopPropagation(); applyMarker('*'); return; }
    if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); e.stopPropagation(); applyMarker('`'); return; }
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); e.stopPropagation(); openCellLink(); return; }

    const inp = e.target as HTMLInputElement;
    if (!inp.classList?.contains('te-cell')) return;
    const r = Number(inp.dataset.r);
    const c = Number(inp.dataset.c);
    const lastR = model.rows.length - 1;
    const lastC = cols() - 1;

    if (e.key === 'Tab') {
      e.preventDefault();
      syncModel();
      let nr = r; let nc = c;
      if (e.shiftKey) {
        if (c === 0) { nr = r - 1; nc = lastC; } else nc = c - 1;
        if (nr < 0) { nr = lastR; nc = lastC; }
      } else {
        if (c === lastC) { nr = r + 1; nc = 0; } else nc = c + 1;
        if (nr > lastR) { insertRowAt(model.rows.length); nr = model.rows.length - 1; nc = 0; }
      }
      focusCell(nr, nc);
      return;
    }
    if (e.key === 'Enter' && !mod) {
      e.preventDefault();
      syncModel();
      let nr = e.shiftKey ? r - 1 : r + 1;
      if (nr > lastR) { insertRowAt(model.rows.length); nr = model.rows.length - 1; }
      if (nr < 0) nr = 0;
      focusCell(nr, c);
      return;
    }
    if (e.key.startsWith('Arrow')) {
      const atStart = (inp.selectionStart ?? 0) === 0;
      const atEnd = (inp.selectionEnd ?? 0) === inp.value.length;
      let nr = r; let nc = c; let handled = true;
      if (e.key === 'ArrowUp') nr = Math.max(0, r - 1);
      else if (e.key === 'ArrowDown') nr = Math.min(lastR, r + 1);
      else if (e.key === 'ArrowLeft' && atStart) { if (c === 0 && r > 0) { nr = r - 1; nc = lastC; } else if (c > 0) nc = c - 1; else handled = false; }
      else if (e.key === 'ArrowRight' && atEnd) { if (c === lastC && r < lastR) { nr = r + 1; nc = 0; } else if (c < lastC) nc = c + 1; else handled = false; }
      else handled = false;
      if (handled && (nr !== r || nc !== c || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        focusCell(nr, nc, e.key === 'ArrowUp' || e.key === 'ArrowDown');
      }
    }
  });

  // ---------- footer ----------
  const cancel = el('button', 'btn ghost'); cancel.type = 'button'; cancel.textContent = 'Cancel';
  const apply = el('button', 'btn primary'); apply.type = 'button'; apply.textContent = 'Apply to document';
  const handle = openModal({ title, body: root, foot: [cancel, apply], wide: true });
  cancel.addEventListener('click', handle.close);
  apply.addEventListener('click', openSourceDiff);

  // expand/shrink the editor window (#7)
  const maxBtn = el('button', 'modal-x te-maxbtn');
  maxBtn.type = 'button';
  maxBtn.textContent = '⛶';
  maxBtn.title = 'Expand / restore the editor window';
  maxBtn.setAttribute('aria-label', 'Expand or restore the editor window');
  const head = handle.el.querySelector('.modal-head');
  const xBtn = handle.el.querySelector('.modal-x:not(.te-maxbtn)');
  if (head && xBtn) head.insertBefore(maxBtn, xBtn);
  maxBtn.addEventListener('click', () => handle.el.classList.toggle('te-max'));

  // silence TS: helpers are exercised through their call sites
  void undoOp; void redoOp;
}
