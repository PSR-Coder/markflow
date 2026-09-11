import { describe, expect, it } from 'vitest';
import { findAllTables, findTableAtLine, parseRow, serializeTable } from '../src/core/tables';

describe('Markdown tables', () => {
  it('parses escaped pipes and pipes inside code spans', () => {
    expect(parseRow('| a \\| b | `x|y` | c |')).toEqual(['a | b', '`x|y`', 'c']);
  });

  it('ignores pipe-looking rows inside fenced code', () => {
    const lines = ['```md', '| not | a | table |', '```', '', '| A | B |', '| --- | --- |', '| 1 | 2 |'];
    expect(findAllTables(lines)).toHaveLength(1);
    expect(findTableAtLine(lines, 1)).toBeNull();
    expect(findTableAtLine(lines, 4)?.rows).toEqual([['A', 'B'], ['1', '2']]);
  });

  it('reads alignment and serializes padded rows', () => {
    const lines = ['| Name | Score |', '| :--- | ---: |', '| Ada | 10 |'];
    const table = findTableAtLine(lines, 2)!;
    expect(table.aligns).toEqual(['left', 'right']);
    expect(serializeTable(table.rows, table.aligns)).toBe('| Name | Score |\n| :--- | ----: |\n| Ada  | 10    |');
  });

  it('normalizes ragged rows and keeps empty cells valid', () => {
    expect(serializeTable([['A', 'B', 'C'], ['x']], ['', '', ''])).toBe(
      '| A   | B   | C   |\n| --- | --- | --- |\n| x   |     |     |',
    );
  });

  it('supports single-column and header-only tables', () => {
    expect(serializeTable([['A'], ['x']], [''])).toBe('| A   |\n| --- |\n| x   |');
    expect(serializeTable([['A']], [''])).toBe('| A   |\n| --- |');
  });
});
