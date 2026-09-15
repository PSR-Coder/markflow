import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { buildPrintHtmlDocument, buildPortableMarkdownZip, buildStandaloneHtmlDocument } from '../src/core/exportArtifacts';

describe('export artifacts', () => {
  it('creates a portable Markdown ZIP with relative attachment paths', async () => {
    const blob = await buildPortableMarkdownZip(
      { title: 'Notes', content: '# Notes\n\n![logo](attachment:asset-1.png)' },
      [{ id: 'asset-1.png', name: 'logo.png', type: 'image/png', blob: new Blob(['image']), ts: 1 }],
    );
    const zip = await JSZip.loadAsync(blob);
    expect(await zip.file('notes.md')!.async('text')).toContain('![logo](assets/logo.png)');
    expect(await zip.file('assets/logo.png')!.async('text')).toBe('image');
    expect(await zip.file('README.txt')!.async('text')).toContain('standard relative paths');
  });

  it('builds standalone HTML with escaped title and supplied body styles', () => {
    const html = buildStandaloneHtmlDocument('<Notes>', '<h1>Notes</h1>', 'body{color:red}');
    expect(html).toContain('<title>&lt;Notes&gt;</title>');
    expect(html).toContain('<style>body{color:red}</style>');
    expect(html).toContain('<h1>Notes</h1>');
  });

  it('builds print HTML with theme, base URL, and print trigger', () => {
    const html = buildPrintHtmlDocument('Notes', '<p>Hello</p>', '.katex{}', 'body{color:black}', '/assets/', '2026-09-11');
    expect(html).toContain('<base href="/assets/">');
    expect(html).toContain('body{color:black}');
    expect(html).toContain('Exported from MarkFlow · 2026-09-11');
    expect(html).toContain('window.print()');
  });
});
