import { describe, expect, it } from 'vitest';
import { buildLineDiff, buildSideBySideDiff } from '../src/core/textDiff';
import { tableLinesEquivalent } from '../src/core/tables';

describe('source line diff', () => {
  it('keeps unchanged lines as context and marks exact additions/removals', () => {
    expect(buildLineDiff('| A |\n| --- |\n| old |', '| A |\n| --- |\n| new |\n| extra |')).toEqual([
      { kind: 'context', text: '| A |' },
      { kind: 'context', text: '| --- |' },
      { kind: 'removed', text: '| old |' },
      { kind: 'added', text: '| new |' },
      { kind: 'added', text: '| extra |' },
    ]);
  });

  it('represents a fresh insertion as additions', () => {
    expect(buildLineDiff('', '| A |\n| --- |')).toEqual([
      { kind: 'added', text: '| A |' },
      { kind: 'added', text: '| --- |' },
    ]);
  });

  it('does not invent changes for identical source', () => {
    expect(buildLineDiff('one\ntwo', 'one\ntwo')).toEqual([
      { kind: 'context', text: 'one' },
      { kind: 'context', text: 'two' },
    ]);
  });

  it('supports snapshot comparisons as a complete document diff', () => {
    expect(buildLineDiff('# Current\n\nKeep this', '# Snapshot\n\nKeep this')).toEqual([
      { kind: 'removed', text: '# Current' },
      { kind: 'added', text: '# Snapshot' },
      { kind: 'context', text: '' },
      { kind: 'context', text: 'Keep this' },
    ]);
  });

  it('keeps table padding re-alignment neutral while exposing the changed cell row', () => {
    const before = '| Column 1 | Column 2 |\n| --- | --- |\n| 1 | x |\n| 2 | y |';
    const after = '| Column 1  | Column 2 |\n| ---- | --- |\n| changed 1 | x |\n| 2         | y |';
    const diff = buildLineDiff(before, after, { equivalent: tableLinesEquivalent });
    expect(diff.filter((line) => line.kind === 'removed' || line.kind === 'added').map((line) => line.text))
      .toEqual(['| 1 | x |', '| changed 1 | x |']);
    expect(diff.filter((line) => line.kind === 'normalized')).toHaveLength(3);
  });

  it('aligns historical and current lines for side-by-side review', () => {
    expect(buildSideBySideDiff('one\ntwo', 'one\nthree')).toEqual([
      { kind: 'context', left: { line: 1, text: 'one' }, right: { line: 1, text: 'one' } },
      { kind: 'changed', left: { line: 2, text: 'two' }, right: { line: 2, text: 'three' } },
    ]);
  });
});