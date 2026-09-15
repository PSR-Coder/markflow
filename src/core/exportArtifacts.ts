import JSZip from 'jszip';
import type { Asset } from './storage';
import { attachmentIds, buildPortableAttachmentPaths, rewriteAttachmentPaths } from './attachments';

export interface PortableMarkdownDocument {
  title: string;
  content: string;
}

function safeSlug(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'document';
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>\"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char] as string));
}

export async function buildPortableMarkdownZip(doc: PortableMarkdownDocument, assets: Asset[]): Promise<Blob> {
  const ids = attachmentIds(doc.content);
  const referencedAssets = assets.filter((asset) => ids.includes(asset.id));
  const paths = buildPortableAttachmentPaths(referencedAssets);
  const missing = ids.filter((id) => !paths.has(id));
  const zip = new JSZip();
  zip.file(`${safeSlug(doc.title)}.md`, rewriteAttachmentPaths(doc.content, paths));
  const folder = zip.folder('assets')!;
  for (const asset of referencedAssets) folder.file(paths.get(asset.id)!.slice('assets/'.length), asset.blob);
  zip.file('README.txt', [
    `This export belongs to "${doc.title}".`,
    'Image references use standard relative paths under ./assets/ and can be opened by ordinary Markdown tools.',
    missing.length ? `Missing local attachments were left as attachment references: ${missing.join(', ')}.` : 'All referenced local attachments are included.',
  ].join('\n') + '\n');
  return zip.generateAsync({ type: 'blob' });
}

export function buildStandaloneHtmlDocument(title: string, bodyHtml: string, css: string): string {
  return `<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escapeHtml(title)}</title><style>${css}</style></head>\n<body>${bodyHtml}<p class="generated">Exported from MarkFlow — local-first Markdown editor.</p></body></html>`;
}

export function buildPrintHtmlDocument(
  title: string,
  bodyHtml: string,
  appCss: string,
  themeCss: string,
  baseHref: string,
  dateLabel: string,
): string {
  return `<!DOCTYPE html>\n<html><head><meta charset="utf-8"><base href="${escapeHtml(baseHref)}"><title>${escapeHtml(title)}</title>\n<style>${appCss}</style>\n<style>\n  @page { size: A4; margin: 17mm 16mm; }\n  html,body { background:#fff !important; }\n  body { max-width: 720px; margin: 0 auto; padding: 12px 6px 40px; }\n  ${themeCss}\n  .mermaid-diagram{border:1px solid #ddd;border-radius:8px;padding:10px;}\n  .doc-title-block{font-size:.8em;color:#888;margin-bottom:28px;letter-spacing:.02em;}\n</style></head>\n<body>\n<div class="doc-title-block">Exported from MarkFlow · ${escapeHtml(dateLabel)}</div>\n${bodyHtml}\n<script>window.addEventListener('load',function(){setTimeout(function(){window.print();},450);});<\/script>\n</body></html>`;
}
