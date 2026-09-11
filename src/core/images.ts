// Smart images: paste or drop an image → stored in IndexedDB → markdown
// references attachment:<id>. Preview resolves to object URLs. No server, ever.
import { putAsset, getAsset, db } from './storage';
import { attachmentIds } from './attachments';
import { toast } from '../ui';

const objectUrlCache = new Map<string, string>();

export async function resolveAssetUrl(id: string): Promise<string | null> {
  if (!id) return null;
  const cached = objectUrlCache.get(id);
  if (cached) return cached;
  const asset = await getAsset(id);
  if (!asset) return null;
  const url = URL.createObjectURL(asset.blob);
  objectUrlCache.set(id, url);
  return url;
}

export function releaseAssetUrls(): void {
  for (const url of objectUrlCache.values()) URL.revokeObjectURL(url);
  objectUrlCache.clear();
}

export interface InsertedImage { markdown: string; }

export async function ingestImageFile(file: File | Blob, fallbackName = 'image'): Promise<string | null> {
  const name = file instanceof File && file.name ? file.name : `${fallbackName}.png`;
  if (file instanceof File && file.type && !file.type.startsWith('image/')) {
    toast('That file is not an image.', 'err');
    return null;
  }
  try {
    const asset = await putAsset(file, name);
    return `![${name.replace(/\.[a-z0-9]+$/i, '')}](attachment:${asset.id})`;
  } catch (err) {
    console.error(err);
    toast('Could not store image locally.', 'err');
    return null;
  }
}

/** Install paste + drop handlers on the editor's DOM. insertMarkdown puts text at the cursor. */
export function installImageHandlers(editorDom: HTMLElement, insertMarkdown: (text: string) => void): void {
  editorDom.addEventListener('paste', (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files || []).filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    void handleFiles(files, insertMarkdown);
  });

  editorDom.addEventListener('dragover', (e: DragEvent) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  });
  editorDom.addEventListener('drop', (e: DragEvent) => {
    const files = Array.from(e.dataTransfer?.files || []).filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    void handleFiles(files, insertMarkdown);
  });
}

async function handleFiles(files: File[], insertMarkdown: (text: string) => void): Promise<void> {
  for (const file of files) {
    const md = await ingestImageFile(file);
    if (md) {
      insertMarkdown(md + '\n');
      toast(`Image stored locally (${Math.round(file.size / 1024)} KB). It exports with your document.`, 'ok');
    }
  }
}

/** Rewrite <img data-asset> elements in an HTML fragment to data URIs (for standalone export). */
export async function inlineAssetsInHtml(html: string): Promise<string> {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const imgs = Array.from(doc.querySelectorAll('img[data-asset]'));
  for (const img of imgs) {
    const id = img.getAttribute('data-asset') || '';
    const asset = await getAsset(id);
    if (asset) {
      const { blobToDataUrl } = await import('./storage');
      img.setAttribute('src', await blobToDataUrl(asset.blob));
    } else {
      img.setAttribute('alt', `[missing attachment: ${img.getAttribute('alt') || id}]`);
    }
    img.removeAttribute('data-asset');
    img.removeAttribute('data-asset-img');
  }
  return doc.body.innerHTML;
}

export { attachmentIds, db };
