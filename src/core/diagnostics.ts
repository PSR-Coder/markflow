import { fenceMask, findAllTables, parseRow } from './tables';

export type DiagnosticSeverity = 'error' | 'warning';
export type DiagnosticKind =
  | 'broken-link'
  | 'missing-attachment'
  | 'malformed-table'
  | 'unclosed-inline'
  | 'heading-hierarchy'
  | 'duplicate-heading'
  | 'unsupported-html'
  | 'portability';

export interface MarkdownDiagnostic {
  kind: DiagnosticKind;
  severity: DiagnosticSeverity;
  message: string;
  line: number;
  column: number;
  offset: number;
}

export interface MarkdownDiagnosticsOptions {
  availableAttachments?: ReadonlySet<string>;
}

interface HeadingInfo {
  level: number;
  text: string;
  offset: number;
}

const ATTACHMENT_RE = /attachment:([A-Za-z0-9._-]+)/g;

function isEscaped(source: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && source[i] === '\\'; i--) slashes++;
  return slashes % 2 === 1;
}

function lineStarts(lines: string[]): number[] {
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  return starts;
}

function addDiagnostic(
  output: MarkdownDiagnostic[],
  source: string,
  starts: readonly number[],
  kind: DiagnosticKind,
  severity: DiagnosticSeverity,
  message: string,
  offset: number,
): void {
  const bounded = Math.max(0, Math.min(offset, source.length));
  let lineIndex = 0;
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle] <= bounded) {
      lineIndex = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  output.push({
    kind,
    severity,
    message,
    line: lineIndex + 1,
    column: bounded - starts[lineIndex] + 1,
    offset: bounded,
  });
}

function codeMask(line: string, baseOffset: number, source: string, starts: readonly number[], output: MarkdownDiagnostic[]): boolean[] {
  const mask = new Array(line.length).fill(false);
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '`' || isEscaped(line, i)) { i++; continue; }
    let run = 1;
    while (line[i + run] === '`') run++;
    const delimiter = '`'.repeat(run);
    let close = -1;
    for (let j = i + run; j <= line.length - run; j++) {
      if (!isEscaped(line, j) && line.startsWith(delimiter, j)) { close = j; break; }
    }
    const end = close < 0 ? line.length : close + run;
    for (let j = i; j < end; j++) mask[j] = true;
    if (close < 0) {
      addDiagnostic(output, source, starts, 'unclosed-inline', 'error', 'Unclosed inline code span.', baseOffset + i);
      break;
    }
    i = end;
  }
  return mask;
}

function delimiterAt(line: string, index: number): string | null {
  if (line.startsWith('***', index) || line.startsWith('___', index)) return line.slice(index, index + 3);
  if (line.startsWith('~~', index) || line.startsWith('**', index) || line.startsWith('__', index)) return line.slice(index, index + 2);
  if (line[index] === '*' || line[index] === '_') return line[index];
  return null;
}

function scanUnclosedInline(
  line: string,
  baseOffset: number,
  source: string,
  starts: readonly number[],
  output: MarkdownDiagnostic[],
): void {
  const mask = codeMask(line, baseOffset, source, starts, output);
  const open = new Map<string, number[]>();
  let i = 0;
  while (i < line.length) {
    if (mask[i] || isEscaped(line, i)) { i++; continue; }
    const delimiter = delimiterAt(line, i);
    if (!delimiter) { i++; continue; }
    const previous = i > 0 ? line[i - 1] : '';
    const next = line[i + delimiter.length] || '';
    if (delimiter !== '~~' && delimiter.includes('_') && /[\p{L}\p{N}]/u.test(previous) && /[\p{L}\p{N}]/u.test(next)) {
      i += delimiter.length;
      continue;
    }
    const canOpen = Boolean(next) && !/\s/.test(next);
    const canClose = Boolean(previous) && !/\s/.test(previous);
    const stack = open.get(delimiter) ?? [];
    if (stack.length && canClose) {
      stack.pop();
    } else if (canOpen) {
      stack.push(i);
    } else if (canClose) {
      addDiagnostic(output, source, starts, 'unclosed-inline', 'error', `Unmatched ${delimiter} marker.`, baseOffset + i);
    }
    if (stack.length) open.set(delimiter, stack);
    else open.delete(delimiter);
    i += delimiter.length;
  }
  for (const [delimiter, offsets] of open) {
    for (const offset of offsets) {
      addDiagnostic(output, source, starts, 'unclosed-inline', 'error', `Unclosed ${delimiter} marker.`, baseOffset + offset);
    }
  }
}

function findClosingBracket(line: string, start: number): number {
  for (let i = start; i < line.length; i++) {
    if (line[i] === ']' && !isEscaped(line, i)) return i;
  }
  return -1;
}

function findClosingLink(line: string, start: number): number {
  let depth = 1;
  for (let i = start + 1; i < line.length; i++) {
    if (isEscaped(line, i)) continue;
    if (line[i] === '(') depth++;
    if (line[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

function referenceId(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function destination(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('<')) {
    const end = value.indexOf('>');
    return end >= 0 ? value.slice(1, end) : value;
  }
  return value.match(/^(\S+)(?:\s+["'][\s\S]*["'])?$/)?.[1] ?? value;
}

function headingSlug(text: string): string {
  const plain = text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_~]/g, '');
  return plain.toLowerCase().trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'section';
}

function scanHeadings(
  lines: string[],
  fenced: readonly boolean[],
  starts: readonly number[],
  source: string,
  output: MarkdownDiagnostic[],
): Set<string> {
  const headings: HeadingInfo[] = [];
  const ids = new Set<string>();
  let previousLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    const match = /^\s{0,3}(#{1,6})(?:[ \t]+(.*?)[ \t]*|[ \t]*)$/.exec(lines[i]);
    if (!match) continue;
    const level = match[1].length;
    const text = match[2] || '';
    if (!headings.length && level > 1) {
      addDiagnostic(output, source, starts, 'heading-hierarchy', 'warning', `Document starts at H${level}; consider starting with H1.`, starts[i]);
    } else if (previousLevel && level > previousLevel + 1) {
      addDiagnostic(output, source, starts, 'heading-hierarchy', 'warning', `Heading jumps from H${previousLevel} to H${level}.`, starts[i]);
    }
    const id = headingSlug(text);
    if (ids.has(id)) {
      addDiagnostic(output, source, starts, 'duplicate-heading', 'warning', `Heading generates a duplicate anchor id "${id}".`, starts[i]);
    }
    ids.add(id);
    headings.push({ level, text, offset: starts[i] });
    previousLevel = level;
  }
  return new Set(headings.map((heading) => headingSlug(heading.text)));
}

function scanLinks(
  lines: string[],
  fenced: readonly boolean[],
  starts: readonly number[],
  source: string,
  headingIds: ReadonlySet<string>,
  output: MarkdownDiagnostic[],
): void {
  const definitions = new Map<string, { target: string; offset: number }>();
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    const definition = /^\s{0,3}\[([^\]]+)\]:\s*(.*)$/.exec(lines[i]);
    if (!definition) continue;
    const target = destination(definition[2]);
    const offset = starts[i] + definition[0].indexOf(definition[2]);
    definitions.set(referenceId(definition[1]), { target, offset });
    if (!target) addDiagnostic(output, source, starts, 'broken-link', 'error', 'Link definition has no destination.', offset);
  }

  const checkTarget = (target: string, offset: number): void => {
    const value = destination(target);
    if (!value) {
      addDiagnostic(output, source, starts, 'broken-link', 'error', 'Link has no destination.', offset);
      return;
    }
    if (value.startsWith('#')) {
      let fragment = value.slice(1);
      try { fragment = decodeURIComponent(fragment); } catch { /* keep the raw fragment */ }
      if (!headingIds.has(referenceId(fragment))) {
        addDiagnostic(output, source, starts, 'broken-link', 'error', `Link points to missing heading "#${fragment}".`, offset);
      }
    } else if (/\s/.test(value)) {
      addDiagnostic(output, source, starts, 'broken-link', 'error', 'Link destination contains unescaped whitespace.', offset);
    }
  };

  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    const line = lines[i];
    const mask = codeMask(line, starts[i], source, starts, []);
    for (let cursor = 0; cursor < line.length; cursor++) {
      if (mask[cursor] || line[cursor] !== '[' || isEscaped(line, cursor)) continue;
      const labelEnd = findClosingBracket(line, cursor + 1);
      if (labelEnd < 0) continue;
      const image = cursor > 0 && line[cursor - 1] === '!' && !isEscaped(line, cursor - 1);
      if (line[labelEnd + 1] === '(') {
        const linkEnd = findClosingLink(line, labelEnd + 1);
        const targetOffset = starts[i] + labelEnd + 2;
        if (linkEnd < 0) {
          addDiagnostic(output, source, starts, 'broken-link', 'error', image ? 'Image link is not closed.' : 'Link is not closed.', starts[i] + cursor);
          continue;
        }
        checkTarget(line.slice(labelEnd + 2, linkEnd), targetOffset);
        cursor = linkEnd;
        continue;
      }
      if (line[labelEnd + 1] === '[') {
        const refEnd = findClosingBracket(line, labelEnd + 2);
        if (refEnd < 0) continue;
        const idText = line.slice(labelEnd + 2, refEnd) || line.slice(cursor + 1, labelEnd);
        if (!definitions.has(referenceId(idText))) {
          addDiagnostic(output, source, starts, 'broken-link', 'error', `Link reference "${idText}" is not defined.`, starts[i] + cursor);
        }
        cursor = refEnd;
      }
    }
  }
}

function scanAttachments(
  lines: string[],
  fenced: readonly boolean[],
  starts: readonly number[],
  source: string,
  options: MarkdownDiagnosticsOptions,
  output: MarkdownDiagnostic[],
): void {
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    const line = lines[i];
    const mask = codeMask(line, starts[i], source, starts, []);
    for (const match of line.matchAll(ATTACHMENT_RE)) {
      if (mask[match.index]) continue;
      const id = match[1];
      const offset = starts[i] + match.index;
      if (options.availableAttachments && !options.availableAttachments.has(id)) {
        addDiagnostic(output, source, starts, 'missing-attachment', 'error', `Attachment "${id}" is not stored locally.`, offset);
      } else {
        addDiagnostic(output, source, starts, 'portability', 'warning', 'Local attachment references need a portable package or asset export.', offset);
      }
    }
  }
}

function separatorInfo(line: string): { valid: boolean; looksLikeSeparator: boolean; cells: string[] } {
  const cells = parseRow(line);
  const normalized = cells.map((cell) => cell.replace(/\s/g, ''));
  const valid = normalized.length > 0 && normalized.every((cell) => /^:?-{3,}:?$/.test(cell));
  return { valid, looksLikeSeparator: normalized.some((cell) => /-/.test(cell)), cells };
}

function outerPipeRow(line: string): boolean {
  const value = line.trim();
  return value.startsWith('|') && value.endsWith('|');
}

function scanTables(
  lines: string[],
  fenced: readonly boolean[],
  starts: readonly number[],
  source: string,
  output: MarkdownDiagnostic[],
): void {
  const validTables = new Map(findAllTables(lines).map((table) => [table.startLine, table]));
  for (const [startLine, table] of validTables) {
    const headerCells = parseRow(lines[startLine]).length;
    const separatorCells = parseRow(lines[startLine + 1]).length;
    if (headerCells !== separatorCells) {
      addDiagnostic(output, source, starts, 'malformed-table', 'error', 'Table header and separator have different column counts.', starts[startLine + 1]);
    }
    for (let line = startLine + 2; line <= table.endLine; line++) {
      if (parseRow(lines[line]).length !== table.rows[0].length) {
        addDiagnostic(output, source, starts, 'malformed-table', 'warning', 'Table row has a different number of cells than the header.', starts[line]);
      }
    }
  }

  for (let i = 0; i < lines.length - 1; i++) {
    if (fenced[i] || fenced[i + 1] || [...validTables.values()].some((table) => i >= table.startLine && i <= table.endLine)
      || !outerPipeRow(lines[i]) || !outerPipeRow(lines[i + 1])) continue;
    const separator = separatorInfo(lines[i + 1]);
    if (separator.valid) continue;
    if (separator.looksLikeSeparator || (i + 2 < lines.length && !fenced[i + 2] && outerPipeRow(lines[i + 2]))) {
      addDiagnostic(output, source, starts, 'malformed-table', 'error', 'Table-like rows need a valid Markdown separator row.', starts[i + 1]);
    }
  }
}

function scanHtmlAndPortability(
  lines: string[],
  fenced: readonly boolean[],
  starts: readonly number[],
  source: string,
  output: MarkdownDiagnostic[],
): void {
  for (let i = 0; i < lines.length; i++) {
    const fence = /^\s{0,3}(?:`{3,}|~{3,})\s*([^\s]*)/.exec(lines[i]);
    if (fence?.[1].toLowerCase() === 'mermaid') {
      addDiagnostic(output, source, starts, 'portability', 'warning', 'Mermaid diagrams use a MarkFlow extension and may not render on other Markdown platforms.', starts[i]);
    }
    if (fenced[i]) continue;
    const mask = codeMask(lines[i], starts[i], source, starts, []);
    const tags = /<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>/g;
    for (const match of lines[i].matchAll(tags)) {
      if (mask[match.index]) continue;
      const tag = match[0];
      if (/^<(?:(?:https?:\/\/|mailto:)|[^<>\s]+@[^<>]+)>$/i.test(tag)) continue;
      addDiagnostic(output, source, starts, 'unsupported-html', 'warning', 'Raw HTML may not render consistently across Markdown platforms.', starts[i] + match.index);
    }
  }
}

export function analyzeMarkdown(source: string, options: MarkdownDiagnosticsOptions = {}): MarkdownDiagnostic[] {
  const lines = source.split('\n');
  const starts = lineStarts(lines);
  const fenced = fenceMask(lines);
  const diagnostics: MarkdownDiagnostic[] = [];
  const headingIds = scanHeadings(lines, fenced, starts, source, diagnostics);
  scanTables(lines, fenced, starts, source, diagnostics);
  scanLinks(lines, fenced, starts, source, headingIds, diagnostics);
  scanAttachments(lines, fenced, starts, source, options, diagnostics);
  for (let i = 0; i < lines.length; i++) {
    if (!fenced[i]) scanUnclosedInline(lines[i], starts[i], source, starts, diagnostics);
  }
  scanHtmlAndPortability(lines, fenced, starts, source, diagnostics);
  return diagnostics.sort((a, b) => a.offset - b.offset || a.kind.localeCompare(b.kind));
}