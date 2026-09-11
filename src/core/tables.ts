// Table engine — escape-aware, alignment-aware, format-preserving.
// This exists because naive split('|') loses data (see ToolSphere forensic review, case 6).

export type Align = '' | 'left' | 'center' | 'right';

export interface TableBlock {
  startLine: number;   // 0-based, inclusive
  endLine: number;     // 0-based, inclusive
  aligns: Align[];
  rows: string[][];    // [0] = header, [1..] = body rows (separator row NOT included)
}

const SEP_CELL = /^:?-{3,}:?$/;

/** Mark lines inside fenced code blocks — tables there are code, not tables. */
export function fenceMask(lines: string[]): boolean[] {
  const inFence: boolean[] = new Array(lines.length).fill(false);
  let open = false;
  let fenceChar = '';
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s{0,3}(```+|~~~+)/.exec(lines[i]);
    if (m) {
      if (!open) { open = true; fenceChar = m[1][0] === '`' ? '`' : '~'; inFence[i] = true; }
      else if (m[1][0] === fenceChar[0]) { open = false; inFence[i] = true; }
      else inFence[i] = open;
    } else {
      inFence[i] = open;
    }
  }
  return inFence;
}

/** Split a markdown table row into cells, respecting \| escapes and `code spans`. */
export function parseRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      if (s[i + 1] === '|') { cur += '|'; i++; continue; }
      cur += ch;
      continue;
    }
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function isPipeRow(line: string): boolean {
  const t = line.trim();
  return t.length > 0 && t.includes('|');
}

function separatorAligns(line: string): Align[] | null {
  const cells = parseRow(line);
  if (!cells.length || !cells.every((c) => SEP_CELL.test(c.replace(/\s/g, '')))) return null;
  return cells.map((c) => {
    const t = c.replace(/\s/g, '');
    const left = t.startsWith(':');
    const right = t.endsWith(':');
    return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
  });
}

function padRows(rows: string[][], cols: number, fill = ''): void {
  for (const row of rows) while (row.length < cols) row.push(fill);
}

/** Find the table containing `lineNo` (0-based), if any. */
export function findTableAtLine(lines: string[], lineNo: number): TableBlock | null {
  const fenced = fenceMask(lines);
  const usable = (i: number) => i >= 0 && i < lines.length && !fenced[i] && isPipeRow(lines[i]);
  if (!usable(lineNo)) return null;
  let start = lineNo;
  while (usable(start - 1)) start--;
  let end = lineNo;
  while (usable(end + 1)) end++;
  if (end - start < 1) return null; // need at least header + separator

  const lines2 = lines.slice(start, end + 1);
  // Locate the separator row — usually line 2, but be forgiving.
  let sepIdx = -1;
  let aligns: Align[] | null = null;
  for (let i = 0; i < Math.min(3, lines2.length); i++) {
    aligns = separatorAligns(lines2[i]);
    if (aligns) { sepIdx = i; break; }
  }
  if (sepIdx === -1 || sepIdx === 0) return null;

  const header = parseRow(lines2[sepIdx - 1]);
  const cols = Math.max(header.length, aligns!.length);
  const body = lines2.filter((_, i) => i !== sepIdx - 1 && i !== sepIdx).map(parseRow);
  const rows = [header, ...body];
  padRows(rows, cols);
  while (aligns!.length < cols) aligns!.push('');
  return { startLine: start, endLine: end, aligns: aligns!, rows };
}

/** Enumerate all tables in the document (skipping fenced code blocks). */
export function findAllTables(lines: string[]): TableBlock[] {
  const fenced = fenceMask(lines);
  const out: TableBlock[] = [];
  let i = 0;
  while (i < lines.length - 1) {
    if (!fenced[i] && !fenced[i + 1] && isPipeRow(lines[i])) {
      const aligns = separatorAligns(lines[i + 1]);
      if (aligns) {
        let end = i + 1;
        while (end + 1 < lines.length && isPipeRow(lines[end + 1])) end++;
        const header = parseRow(lines[i]);
        const cols = Math.max(header.length, aligns.length);
        const body = lines.slice(i + 2, end + 1).map(parseRow);
        const rows = [header, ...body];
        padRows(rows, cols);
        while (aligns.length < cols) aligns.push('');
        out.push({ startLine: i, endLine: end, aligns, rows });
        i = end + 1;
        continue;
      }
    }
    i++;
  }
  return out;
}

function visualLen(s: string): number {
  return Array.from(s).length;
}

/** Serialize a table back to clean, column-aligned markdown (auto-padded). */
export function serializeTable(rows: string[][], aligns: Align[]): string {
  const cols = Math.max(...rows.map((r) => r.length), aligns.length, 1);
  const widened = rows.map((r) => {
    const c = r.slice();
    while (c.length < cols) c.push('');
    return c;
  });
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    widths[c] = Math.max(3, ...widened.map((r) => visualLen(r[c])));
  }
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - visualLen(s)));
  const sepCell = (align: Align, w: number): string => {
    const dashes = '-'.repeat(Math.max(1, w - (align === 'center' ? 2 : align === '' ? 0 : 1)));
    if (align === 'center') return ':' + dashes + ':';
    if (align === 'left') return ':' + dashes;
    if (align === 'right') return dashes + ':';
    return dashes;
  };
  const fmtRow = (row: string[]) => '| ' + row.map((cell, c) => pad(cell, widths[c])).join(' | ') + ' |';
  const sep = '| ' + aligns.map((a, c) => sepCell(a, widths[c])).join(' | ') + ' |';
  const esc = (row: string[]) => row.map((cell) => cell.replace(/\|/g, '\\|'));
  return [fmtRow(esc(widened[0])), sep, ...widened.slice(1).map((r) => fmtRow(esc(r)))].join('\n');
}

export function newTable(rows: number, cols: number): string {
  const header = Array.from({ length: cols }, (_, i) => `Column ${i + 1}`);
  const aligns: Align[] = Array(cols).fill('');
  const body = Array.from({ length: rows }, () => Array(cols).fill(''));
  return serializeTable([header, ...body], aligns);
}
