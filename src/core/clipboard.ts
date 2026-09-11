// Paste-tabular-data: copying a range from Excel/Google Sheets puts TSV
// (tab-separated) text on the clipboard. Convert it straight into an aligned
// Markdown table — first copied row becomes the header.
// NOTE (by design): merged cells are impossible in pipe tables on EVERY
// platform — Excel flattens them to value+empty cells on copy, and that
// flattened layout is what lands here.
import { EditorView } from '@codemirror/view';
import { serializeTable } from './tables';
import { toast } from '../ui';

export function installTablePaste(dom: HTMLElement, view: EditorView): void {
  dom.addEventListener('paste', (e: ClipboardEvent) => {
    if (e.defaultPrevented) return; // image handler may have claimed it
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (!text.includes('\t')) return;
    const lines = text.replace(/\r/g, '').replace(/\n+$/, '');
    if (!lines.includes('\n')) return; // single row: user probably wants raw text
    const grid = lines.split('\n').map((l) => l.split('\t'));
    if (grid[0].length < 2) return;

    const cols = Math.max(...grid.map((r) => r.length));
    grid.forEach((r) => { while (r.length < cols) r.push(''); });
    const header = grid[0].map((c) => c.trim() || 'Column');
    const body = grid.slice(1).map((row) => row.map((c) => c.trim()));
    const table = serializeTable([header, ...body], Array(cols).fill(''));

    e.preventDefault();
    const { from, to } = view.state.selection.main;
    const prevChar = from > 0 ? view.state.doc.sliceString(from - 1, from) : '\n';
    const insert = (prevChar === '\n' ? '' : '\n\n') + table + '\n';
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
      scrollIntoView: true,
    });
    view.focus();
    toast(
      `Spreadsheet pasted as a Markdown table (${body.length} rows × ${cols} cols). First row = header. Merged cells aren't possible in pipe tables — they land as value + empty cells.`,
      'ok',
      4500,
    );
  }, true); // capture phase: run before CM's own paste handling
}
