import { describe, expect, it } from 'vitest';
import { analyzeMarkdown, type DiagnosticKind } from '../src/core/diagnostics';

const kinds = (source: string, options?: Parameters<typeof analyzeMarkdown>[1]): DiagnosticKind[] =>
  analyzeMarkdown(source, options).map((diagnostic) => diagnostic.kind);

describe('Markdown confidence diagnostics', () => {
  it('finds empty, missing-fragment, and undefined-reference links', () => {
    const result = analyzeMarkdown('[empty]()\n[missing](#nowhere)\n[reference][unknown]');
    expect(result.filter((diagnostic) => diagnostic.kind === 'broken-link')).toHaveLength(3);
    expect(result.every((diagnostic) => diagnostic.line >= 1 && diagnostic.column >= 1)).toBe(true);
  });

  it('reports missing attachments while leaving stored attachments as portability warnings', () => {
    const source = '![ok](attachment:one)\n![gone](attachment:two)';
    const result = analyzeMarkdown(source, { availableAttachments: new Set(['one']) });
    expect(result.filter((diagnostic) => diagnostic.kind === 'missing-attachment')).toHaveLength(1);
    expect(result.filter((diagnostic) => diagnostic.kind === 'portability')).toHaveLength(1);
    expect(result.find((diagnostic) => diagnostic.kind === 'missing-attachment')?.message).toContain('two');
  });

  it('detects malformed separators and ragged body rows', () => {
    const result = analyzeMarkdown('| A | B |\n| -- | --- |\n| one |\n\n| C | D |\n| --- | --- |\n| three |');
    expect(result.filter((diagnostic) => diagnostic.kind === 'malformed-table')).toHaveLength(2);
  });

  it('ignores protected fenced code while finding unclosed inline syntax', () => {
    const result = analyzeMarkdown('Text **bold\n\n```md\n**not a diagnostic** `also not one\n```\n\n`code');
    expect(result.filter((diagnostic) => diagnostic.kind === 'unclosed-inline').map((diagnostic) => diagnostic.message))
      .toEqual(['Unclosed ** marker.', 'Unclosed inline code span.']);
  });

  it('reports heading hierarchy and duplicate generated anchors', () => {
    const source = '## Start\n#### Jump\n# Start';
    const result = analyzeMarkdown(source);
    expect(result.map((diagnostic) => diagnostic.kind)).toEqual(['heading-hierarchy', 'heading-hierarchy', 'duplicate-heading']);
    expect(result[0].message).toContain('starts at H2');
    expect(result[1].message).toContain('H2 to H4');
  });

  it('warns about raw HTML and renderer extensions that are not portable Markdown', () => {
    const source = '<div>raw</div>\n\n```mermaid\nflowchart LR\n```';
    expect(kinds(source)).toEqual(['unsupported-html', 'unsupported-html', 'portability']);
  });
});