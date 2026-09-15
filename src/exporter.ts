// Export engine. Everything happens client-side — your text never touches a server.
// (Dillinger sends your document to *their* server for PDF. StackEdit paywalls it.
//  We print locally with selectable text and no watermark. That's the point.)
import { addImportedSnapshot, createDoc, db, listSnapshots, putAsset, saveDoc, type Doc } from './core/storage';
import { attachmentIds, inlineAssetsInHtml } from './core/images';
import { buildBackupZip, readBackupZip, readMarkdownZip } from './core/backup';
import { rewriteAttachmentIds } from './core/attachments';
import { buildPortableMarkdownZip, buildPrintHtmlDocument, buildStandaloneHtmlDocument } from './core/exportArtifacts';
import { toast } from './ui';

export function slug(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'document';
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function downloadText(filename: string, text: string, mime = 'text/markdown'): void {
  downloadBlob(filename, new Blob([text], { type: `${mime};charset=utf-8` }));
}

// ---------- Markdown export (zip when local images are attached) ----------

export async function exportMarkdown(doc: Doc, assetNote = true): Promise<void> {
  const ids = attachmentIds(doc.content);
  if (!ids.length) {
    downloadText(`${slug(doc.title)}.md`, doc.content);
    if (assetNote) toast('Downloaded Markdown.', 'ok');
    return;
  }
  const assets = [];
  for (const id of ids) {
    const asset = await db.assets.get(id);
    if (asset) assets.push(asset);
  }
  const blob = await buildPortableMarkdownZip({ title: doc.title, content: doc.content }, assets);
  downloadBlob(`${slug(doc.title)}.zip`, blob);
  toast(`Exported as portable Markdown with ${assets.length} embedded image(s).`, 'ok');
}

export async function exportBackupZip(docs: Doc[]): Promise<void> {
  const snapshots = (await Promise.all(docs.map((doc) => listSnapshots(doc.id)))).flat();
  const assetIds = new Set<string>();
  for (const doc of docs) attachmentIds(doc.content).forEach((id) => assetIds.add(id));
  for (const snapshot of snapshots) attachmentIds(snapshot.content).forEach((id) => assetIds.add(id));
  const assets = [];
  for (const id of assetIds) {
    const asset = await db.assets.get(id);
    if (asset) assets.push(asset);
  }
  const blob = await buildBackupZip({ docs, snapshots, assets });
  downloadBlob(`markflow-backup-${new Date().toISOString().slice(0, 10)}.zip`, blob);
  toast(`Backed up ${docs.length} document(s), ${snapshots.length} snapshot(s), and ${assets.length} attachment(s).`, 'ok');
}

export async function importBackupZip(blob: Blob): Promise<{ documents: number; snapshots: number; assets: number; missingAssets: number }> {
  let backup;
  try {
    backup = await readBackupZip(blob);
  } catch (error) {
    if (error instanceof Error && /manifest/i.test(error.message)) backup = await readMarkdownZip(blob);
    else throw error;
  }
  const assetIds = new Map<string, string>();
  for (const asset of backup.assets) {
    const imported = await putAsset(asset.blob, asset.name);
    assetIds.set(asset.sourceId, imported.id);
  }
  let missingAssets = 0;
  const referenced = (content: string): void => {
    for (const id of attachmentIds(content)) if (!assetIds.has(id)) missingAssets++;
  };
  for (const entry of backup.documents) {
    referenced(entry.content);
    for (const snapshot of entry.snapshots) referenced(snapshot.content);
    const doc = await createDoc(entry.title, rewriteAttachmentIds(entry.content, assetIds));
    doc.createdAt = entry.createdAt;
    doc.updatedAt = entry.updatedAt;
    await saveDoc(doc);
    for (const snapshot of entry.snapshots) {
      await addImportedSnapshot({
        docId: doc.id,
        label: snapshot.label,
        content: rewriteAttachmentIds(snapshot.content, assetIds),
        words: snapshot.words,
        ts: snapshot.ts,
      });
    }
  }
  return { documents: backup.documents.length, snapshots: backup.manifest.snapshots.length, assets: backup.assets.length, missingAssets };
}

// ---------- standalone HTML export ----------

const EXPORT_CSS = `
  :root { --accent:#6d5ae7; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color:#1e2330; max-width: 780px; margin: 40px auto; padding: 0 22px; line-height: 1.7; font-size: 16px; }
  h1,h2,h3,h4 { line-height:1.3; margin:1.4em 0 .5em; font-weight:750; }
  h1 { font-size:1.9em; padding-bottom:.3em; border-bottom:1px solid #d9dde8; }
  h2 { font-size:1.5em; padding-bottom:.25em; border-bottom:1px solid #e3e6ee; }
  p { margin: 0 0 1em; }
  a { color: var(--accent); }
  code { font-family: ui-monospace, Menlo, Consolas, monospace; background:#eff1f7; padding:.16em .38em; border-radius:5px; font-size:.86em; }
  pre { background:#24293a; color:#dde2f0; padding:14px 16px; border-radius:10px; overflow-x:auto; }
  pre code { background:transparent; padding:0; }
  blockquote { margin:0 0 1em; padding:2px 16px; color:#4a5163; border-left:3px solid var(--accent); background:rgba(109,90,231,.08); border-radius:0 6px 6px 0; }
  table { border-collapse:collapse; margin:0 0 1.2em; }
  th,td { border:1px solid #c3c9d9; padding:7px 13px; }
  th { background:rgba(109,90,231,.1); }
  tr:nth-child(even) td { background:#f5f6fa; }
  img { max-width:100%; border-radius:6px; }
  figure { margin:0 0 1.1em; }
  figure img { display:block; margin:0 auto; }
  figcaption { margin-top:7px; text-align:center; color:#767d90; font-size:.82em; font-style:italic; }
  hr { border:0; border-top:2px solid #d9dde8; margin:1.8em 0; }
  .footnotes { font-size:.86em; color:#4a5163; border-top:1px solid #d9dde8; margin-top:2em; }
  .generated { color:#767d90; font-size:.78rem; text-align:center; margin-top:48px; }
`;

export async function exportStandaloneHtml(title: string, previewHtml: string): Promise<void> {
  const bodyHtml = await inlineAssetsInHtml(previewHtml);
  const html = buildStandaloneHtmlDocument(title, bodyHtml, EXPORT_CSS);
  downloadText(`${slug(title)}.html`, html, 'text/html');
  toast('Downloaded standalone HTML (images embedded).', 'ok');
}

// ---------- PDF via the browser's real print pipeline ----------

export type PrintTheme = 'github' | 'serif' | 'minimal';

const PRINT_THEMES: Record<PrintTheme, { label: string; css: string }> = {
  github: {
    label: 'GitHub (clean sans)',
    css: `body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;color:#1f2328;font-size:11pt;line-height:1.6;} h1{font-size:1.8em;border-bottom:1px solid #d1d9e0;padding-bottom:.25em;} h2{font-size:1.4em;border-bottom:1px solid #e3e8ee;padding-bottom:.2em;} h1,h2,h3{font-weight:650;margin:1.3em 0 .5em;} table{border-collapse:collapse;} th,td{border:1px solid #d1d9e0;padding:6px 12px;} th{background:#f6f8fa;} tr:nth-child(even) td{background:#f6f8fa;} code{background:#eff1f3;padding:.15em .35em;border-radius:5px;font-family:ui-monospace,Menlo,monospace;font-size:.85em;} pre{background:#f6f8fa;color:#1f2328;padding:12px;border-radius:8px;} pre code{background:none;padding:0;} blockquote{color:#59636e;border-left:3px solid #d1d9e0;padding:0 1em;margin-left:0;} a{color:#0969da;text-decoration:none;} img{max-width:100%;}`,
  },
  serif: {
    label: 'Serif report',
    css: `body{font-family:"Iowan Old Style",Charter,Georgia,serif;color:#191919;font-size:11.5pt;line-height:1.68;} h1,h2,h3{font-family:ui-sans-serif,system-ui,sans-serif;font-weight:750;margin:1.5em 0 .5em;} h1{font-size:1.9em;padding-bottom:.3em;border-bottom:2.5px solid #6d5ae7;} h2{font-size:1.4em;} table{border-collapse:collapse;width:100%;font-size:.94em;} th,td{border:1px solid #b9bdc9;padding:7px 12px;text-align:left;} th{background:#efeafe;} code{font-family:ui-monospace,Menlo,monospace;font-size:.85em;background:#f2f0fa;padding:.1em .3em;border-radius:4px;} pre{background:#232435;color:#e8e9f5;padding:13px;border-radius:8px;} pre code{background:none;} blockquote{font-style:italic;color:#444;border-left:3px solid #6d5ae7;margin-left:0;padding-left:1em;} a{color:#5a48d8;} img{max-width:100%;}`,
  },
  minimal: {
    label: 'Minimal (typewriter)',
    css: `body{font-family:ui-monospace,Menlo,Consolas,monospace;color:#111;font-size:10.5pt;line-height:1.65;} h1{font-size:1.5em;letter-spacing:-.02em;} h1,h2,h3{margin:1.4em 0 .5em;} h1,h2{border-bottom:1px solid #111;padding-bottom:.2em;} table{border-collapse:collapse;} th,td{border:1px solid #999;padding:5px 10px;font-size:.92em;} pre{border:1px solid #999;padding:10px;white-space:pre-wrap;} code{font-size:.9em;} blockquote{border-left:2px solid #111;margin-left:0;padding-left:1em;color:#333;} a{color:#111;} img{max-width:100%;}`,
  },
};

interface PrintOpts { title: string; theme: PrintTheme; toc: boolean; }

function collectPageStyles(): string {
  let css = '';
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) css += rule.cssText + '\n';
    } catch { /* cross-origin sheets skipped */ }
  }
  return css;
}

export function printThemeLabels(): { key: PrintTheme; label: string }[] {
  return (Object.keys(PRINT_THEMES) as PrintTheme[]).map((k) => ({ key: k, label: PRINT_THEMES[k].label }));
}

export async function exportPdfViaPrint(previewHtml: string, opts: PrintOpts): Promise<void> {
  const bodyHtml = await inlineAssetsInHtml(previewHtml);
  const themeCss = PRINT_THEMES[opts.theme].css;
  const appCss = collectPageStyles(); // carries KaTeX + hljs styles so math & code survive
  const base = location.href.replace(/[^/]*$/, '');

  const w = window.open('', '_blank');
  if (!w) {
    toast('Pop-up blocked — allow pop-ups for this site to print to PDF.', 'err', 4200);
    return;
  }
  const html = buildPrintHtmlDocument(opts.title, bodyHtml, appCss, themeCss, base, new Date().toLocaleDateString());
  w.document.write(html);
  w.document.close();
  toast('Print view opened — choose “Save as PDF”. Text stays selectable, no watermark.', 'ok', 4200);
}

// re-export for main
export { attachmentIds };
