export type DiffLineKind = 'context' | 'normalized' | 'added' | 'removed';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
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