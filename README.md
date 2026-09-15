**Next hardening:** service-worker update/failure matrices, multi-entry failed-save queuing, and screen-reader/contrast/mobile audits.
# MarkFlow v0.1

A **local-first, privacy-first Markdown editor** for the web. Built per `markdown-editor-project/01-deep-analysis-and-plan.md` to fix the documented gaps in Dillinger / StackEdit / HackMD: tables that don't suck, images that just work, beautiful **client-side** PDF export, and a real document library — with nothing ever leaving the user's browser.

## Quick start

```bash
npm install
npm run dev      # dev server
npm run build    # → dist/  (upload this to Hostinger shared hosting — see DEPLOYMENT.md)
```

## What's in v0.1

| Area | Implementation |
|---|---|
| Editing surface | **CodeMirror 6** (markdown mode, real undo, search, shortcuts, line wrapping) |
| Preview | **markdown-it** + task lists, footnotes, linkify — *not* a regex cascade (see forensic review) |
| Math / diagrams | KaTeX (`$…$`, `$$…$$`, currency-guarded) · Mermaid (lazy-loaded) |
| **Visual table editor (spreadsheet-style)** | Letter bar + row-number gutter frame the grid; **pinned top ops bar**; contextual **+** circles use clipped top/bottom-left row-number and top-left/top-right column-letter hotspots with no guide lines; **wide tables scroll inside the modal**; B/I/S/code/link + common alignment with live preview & active states; **promote any row to header (Replace/Move)**; duplicate/move/clear/delete; **snapshot undo/redo**; **Ctrl/Shift multi-select rows & columns**; **semantic formatting** (nested/partial marks, protected links/code/math/images/HTML, mixed selection sync); **sort (numeric-aware, header-protected)** + view-only **filter**; **expandable window**; **drag column/row sizing** (view-only; inputs stretch into tall rows) — a tall row always stays ONE logical & visual row; Excel/Sheets paste (first row → header, auto-expands) **and** row/column copy-out as TSV; insert-table **size picker**; auto-aligned source output |

| **Smart images** | Paste/drop/upload → IndexedDB (`attachment:` refs) → exports inline them automatically |
| Document library | IndexedDB (Dexie): quota-limited documents, search, rename/duplicate/delete, autosave, storage health, and persistent-storage protection request |
| Version history | Ctrl+S named snapshots + 3-min auto snapshots deduplicated against the newest persisted version, Current version action state, responsive unified/side-by-side Diff-before-restore review with wrapping, sticky options, draggable split, maximize, All/Diff/Same filtering, persistent unchanged-context expansion, Prev/Next navigation, and one-way historical-line copy with undoable live updates |
| Recovery | Library Tools dropup: portable `.markflow.zip` package with versioned manifest, relative assets, snapshots, settings, and legacy-compatible import; ordinary ZIP import for `.md` files remains supported |
| Export | `.md` (auto-zips when images attached) · portable `.markflow.zip` package · standalone HTML (images embedded) · **PDF via browser print** (3 themes, selectable text, no watermark) |
| Modes / themes | Source · Split (scroll-synced) · Preview — dark & light, PWA installable, works offline |
| Portability settings | Toggle inline HTML & single-newline behavior (GitHub parity on demand) |

## Architecture

```
src/
  main.ts            coordinator: boot, autosave, render loop, top bar
  editor.ts          CodeMirror 6 setup + keymaps + scroll sync
  toolbar.ts         formatting commands (inline/line/insert ops)
  tableEditor.ts     the visual table grid editor (modal)
  library.ts         sidebar doc list
  exporter.ts        portable md/html/pdf/backup export, print themes, restore import
  ui.ts              modals, toasts, popovers, helpers
  state.ts           settings (localStorage — settings only!)
  welcome.ts         onboarding seed document
  core/
    renderer.ts      markdown-it wiring: KaTeX, Mermaid, hljs, task lists
    math.ts          guarded KaTeX plugin ($5 ≠ math)
    tables.ts        escape-aware, fence-aware table parse/serialize
    storage.ts       Dexie: docs / snapshots / assets
    images.ts        paste-drop ingest, object-URL resolution
    attachments.ts   attachment reference and portable path mapping
    backup.ts        versioned portable package/export/import, generic Markdown ZIP fallback
    textDiff.ts      exact line-oriented source review diffs
test/
  smoke.mjs          browser boot+interaction suite (playwright-core)
  *.test.ts          pure formatting, table, diagnostics, source-diff, attachment, package, backup, and export contracts
```

## Testing

```bash
npm test                             # pure parser/serializer/formatting/backup contracts
npm run build                        # production bundle
npm run build && node test/smoke.mjs # browser suite; requires Node 20+ and a static server on :4173
```

The pure suite currently covers 48 formatting, table, Markdown Confidence, source-diff, snapshot-policy, attachment, portable-package, export-artifact, generic ZIP-import, malformed-input, property-based, and save-recovery contracts. The browser suite remains a larger smoke script and requires Node 20+ for the installed Playwright version.

## Status & next steps

**Shipped (v0.1):** everything above, including semantic inline formatting, deterministic parser/table contract tests, read-only Markdown Confidence diagnostics, table source diff before Apply, persisted snapshot deduplication, unified/side-by-side history comparison with selective historical-line copy, and portable `.markflow.zip` packages with relative assets, snapshots, settings, and legacy-compatible import.
**Next Horizon 1 slice:** one-click safe Confidence repairs backed by the source diff, then renderer/platform comparison. Remaining hardening includes the Node 20 browser matrix, service-worker rollout failure matrices, quota stress testing, and screen-reader/contrast/mobile audits.
**Later:** target-platform preview modes, paste-rich-text→Markdown, AI sidebar (BYOK), GitHub sync, DOCX export, image resize handles, and code-live "Live" mode.
**v2:** Yjs collaboration + comments, sharing links.

Deploy: **works on Hostinger shared hosting as-is** — see `DEPLOYMENT.md`.
