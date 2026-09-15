import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { buildBackupZip, readBackupZip, readMarkdownZip } from '../src/core/backup';

describe('backup packages', () => {
  it('round-trips document, snapshot, and attachment metadata', async () => {
    const backup = await buildBackupZip({
      docs: [{ id: 'doc-1', title: 'Notes', content: '![logo](attachment:asset-1.png)', createdAt: 10, updatedAt: 20 }],
      snapshots: [{ docId: 'doc-1', label: 'before', content: 'old', words: 1, ts: 15 }],
      assets: [{ id: 'asset-1.png', name: 'logo.png', type: 'image/png', blob: new Blob(['png']), ts: 12 }],
    });
    const parsed = await readBackupZip(backup);
    expect(parsed.manifest.format).toBe('markflow-package');
    expect(parsed.manifest.schema).toBe(2);
    expect(parsed.documents[0].content).toContain('../assets/logo.png');
    expect(parsed.documents[0].snapshots[0].content).toBe('old');
    expect(parsed.assets[0].name).toBe('logo.png');
    expect(await parsed.assets[0].blob.text()).toBe('png');
  });

  it('rejects ZIP files without a compatible manifest', async () => {
    await expect(readBackupZip(new Blob(['not a zip']))).rejects.toThrow();
  });

  it('round-trips package settings metadata', async () => {
    const backup = await buildBackupZip({
      docs: [{ id: 'doc-1', title: 'Notes', content: '# Notes', createdAt: 10, updatedAt: 20 }],
      snapshots: [],
      assets: [],
      settings: { theme: 'light', mode: 'source', sidebarOpen: false, renderHtml: true, lineBreaks: false },
    });
    const parsed = await readBackupZip(backup);
    expect(parsed.manifest.settings).toEqual({ theme: 'light', mode: 'source', sidebarOpen: false, renderHtml: true, lineBreaks: false });
  });

  it('imports ordinary ZIPs containing Markdown files', async () => {
    const zip = new JSZip();
    zip.file('first.md', '# First');
    zip.file('nested/second.md', '# Second');
    const parsed = await readMarkdownZip(await zip.generateAsync({ type: 'blob' }));
    expect(parsed.documents.map((doc) => [doc.title, doc.content])).toEqual([
      ['first', '# First'],
      ['second', '# Second'],
    ]);
  });
});
