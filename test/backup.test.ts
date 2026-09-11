import { describe, expect, it } from 'vitest';
import { buildBackupZip, readBackupZip } from '../src/core/backup';

describe('backup packages', () => {
  it('round-trips document, snapshot, and attachment metadata', async () => {
    const backup = await buildBackupZip({
      docs: [{ id: 'doc-1', title: 'Notes', content: '![logo](attachment:asset-1.png)', createdAt: 10, updatedAt: 20 }],
      snapshots: [{ docId: 'doc-1', label: 'before', content: 'old', words: 1, ts: 15 }],
      assets: [{ id: 'asset-1.png', name: 'logo.png', type: 'image/png', blob: new Blob(['png']), ts: 12 }],
    });
    const parsed = await readBackupZip(backup);
    expect(parsed.manifest.format).toBe('markflow-backup');
    expect(parsed.manifest.schema).toBe(1);
    expect(parsed.documents[0].content).toContain('attachment:asset-1.png');
    expect(parsed.documents[0].snapshots[0].content).toBe('old');
    expect(parsed.assets[0].name).toBe('logo.png');
    expect(await parsed.assets[0].blob.text()).toBe('png');
  });

  it('rejects ZIP files without a compatible manifest', async () => {
    await expect(readBackupZip(new Blob(['not a zip']))).rejects.toThrow();
  });
});
