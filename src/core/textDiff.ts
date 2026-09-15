export type DiffLineKind = 'context' | 'normalized' | 'added' | 'removed';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export interface SideBySideLine {
  kind: DiffLineKind | 'changed';
  left?: { line: number; text: string };
  right?: { line: number; text: string };
}

export interface SelectableSideBySideLine extends SideBySideLine {
  id: string;
}

export interface CopySideBySideResult {
  text: string;
  replaced: number;
  inserted: number;
}

export interface LineDiffOptions {
  /** Treat equivalent source representations as neutral context. */
  equivalent?: (before: string, after: string) => boolean;
}

function linesOf(text: string): string[] {
  return text ? text.split('\n') : [];
}

/** Build an exact, line-oriented diff suitable for a source review surface. */
export function buildLineDiff(before: string, after: string, options: LineDiffOptions = {}): DiffLine[] {
  const oldLines = linesOf(before);
  const newLines = linesOf(after);
  const equivalent = (oldLine: string, newLine: string): boolean => oldLine === newLine
    || Boolean(options.equivalent?.(oldLine, newLine));
  const table = Array.from({ length: oldLines.length + 1 }, () => new Array<number>(newLines.length + 1).fill(0));

  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex--) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex--) {
      table[oldIndex][newIndex] = equivalent(oldLines[oldIndex], newLines[newIndex])
        ? table[oldIndex + 1][newIndex + 1] + 1
        : Math.max(table[oldIndex + 1][newIndex], table[oldIndex][newIndex + 1]);
    }
  }
  const diff: DiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (oldIndex < oldLines.length && newIndex < newLines.length && equivalent(oldLines[oldIndex], newLines[newIndex])) {
      diff.push({ kind: oldLines[oldIndex] === newLines[newIndex] ? 'context' : 'normalized', text: newLines[newIndex] });
      oldIndex++;
      newIndex++;
    } else if (newIndex < newLines.length && (oldIndex >= oldLines.length || table[oldIndex][newIndex + 1] > table[oldIndex + 1][newIndex])) {
      diff.push({ kind: 'added', text: newLines[newIndex++] });
    } else {
      diff.push({ kind: 'removed', text: oldLines[oldIndex++] });
    }
  }
  return diff;
}

/** Align a line diff into historical (left) and current (right) columns. */
export function buildSideBySideDiff(before: string, after: string, options: LineDiffOptions = {}): SideBySideLine[] {
  const oldLines = linesOf(before);
  const newLines = linesOf(after);
  const diff = buildLineDiff(before, after, options);
  const rows: SideBySideLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (let index = 0; index < diff.length;) {
    const line = diff[index];
    if (line.kind === 'context' || line.kind === 'normalized') {
      const leftText = oldLines[oldLine - 1] ?? line.text;
      const rightText = newLines[newLine - 1] ?? line.text;
      rows.push({
        kind: line.kind,
        left: { line: oldLine++, text: leftText },
        right: { line: newLine++, text: rightText },
      });
      index++;
      continue;
    }
    const removed: DiffLine[] = [];
    const added: DiffLine[] = [];
    while (index < diff.length && diff[index].kind === 'removed') removed.push(diff[index++]);
    while (index < diff.length && diff[index].kind === 'added') added.push(diff[index++]);
    const count = Math.max(removed.length, added.length);
    for (let offset = 0; offset < count; offset++) {
      const left = removed[offset];
      const right = added[offset];
      rows.push({
        kind: left && right ? 'changed' : left ? 'removed' : 'added',
        left: left ? { line: oldLine++, text: left.text } : undefined,
        right: right ? { line: newLine++, text: right.text } : undefined,
      });
    }
  }
  return rows;
}

/** Copy selected historical rows into the current source, preserving row order. */
export function copySelectedSideBySideLines(
  source: string,
  rows: readonly SelectableSideBySideLine[],
  selectedIds: ReadonlySet<string>,
): CopySideBySideResult {
  const lines = source.split('\n');
  const replacements = new Map<number, string>();
  const insertions = new Map<number, string[]>();
  const selected = rows.filter((row) => selectedIds.has(row.id) && row.left);

  for (const row of selected) {
    if (row.right) {
      const index = row.right.line - 1;
      if (lines[index] !== row.left!.text) replacements.set(index, row.left!.text);
      continue;
    }
    const rowIndex = rows.indexOf(row);
    let insertionIndex = lines.length;
    for (let previous = rowIndex - 1; previous >= 0; previous--) {
      if (rows[previous].right) {
        insertionIndex = rows[previous].right!.line;
        break;
      }
    }
    if (insertionIndex === lines.length) {
      for (let next = rowIndex + 1; next < rows.length; next++) {
        if (rows[next].right) {
          insertionIndex = Math.max(0, rows[next].right!.line - 1);
          break;
        }
      }
    }
    const group = insertions.get(insertionIndex) ?? [];
    group.push(row.left!.text);
    insertions.set(insertionIndex, group);
  }

  for (const [index, text] of [...replacements].sort(([a], [b]) => b - a)) lines[index] = text;
  for (const [index, values] of [...insertions].sort(([a], [b]) => b - a)) lines.splice(index, 0, ...values);
  return {
    text: lines.join('\n'),
    replaced: replacements.size,
    inserted: [...insertions.values()].reduce((total, values) => total + values.length, 0),
  };
}