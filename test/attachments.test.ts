import { describe, expect, it } from 'vitest';
import { attachmentIds, buildPortableAttachmentPaths, rewriteAttachmentPaths } from '../src/core/attachments';

describe('attachment portability', () => {
  it('deduplicates attachment references', () => {
    expect(attachmentIds('attachment:a.png attachment:a.png attachment:b.png')).toEqual(['a.png', 'b.png']);
  });

  it('sanitizes names and resolves collisions deterministically', () => {
    const paths = buildPortableAttachmentPaths([
      { id: 'one', name: '../photo.png' },
      { id: 'two', name: 'photo.png' },
      { id: 'three', name: 'photo.png' },
    ]);
    expect(paths.get('one')).toBe('assets/photo.png');
    expect(paths.get('two')).toBe('assets/photo-2.png');
    expect(paths.get('three')).toBe('assets/photo-3.png');
  });

  it('rewrites known attachments and leaves missing references visible', () => {
    const paths = new Map([['one', 'assets/photo.png']]);
    expect(rewriteAttachmentPaths('![one](attachment:one) ![two](attachment:two)', paths))
      .toBe('![one](assets/photo.png) ![two](attachment:two)');
  });
});
