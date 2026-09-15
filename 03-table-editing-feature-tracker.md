| P2 | Debounced autosave with durable recovery draft | Shipped, caveat | M4 | 650ms debounce; quota/storage errors show Retry save, persist the latest failed draft locally, and offer restore-or-recover-copy on the next load. |
# MarkFlow Table Editing Feature Tracker

Audit date: 2026-09-11

This tracker is a product and implementation audit of the current repository. It is intentionally more precise than the original round labels: a feature is not considered mature merely because code exists for it.

## Status And Maturity

| Status | Meaning |
|---|---|
| Shipped | Available in the current application and supported by the current implementation. |
| Shipped, caveat | Available, but an important limitation, portability issue, or validation gap remains. |
| Partial | The main path exists, but a meaningful part of the requirement is missing or inconsistent. |
| Planned | Approved direction with no meaningful implementation yet. |
| Declined | Deliberately excluded because Markdown or the current product model cannot support it cleanly. |
| Risk | Existing behavior needs hardening, dedicated tests, or a product decision before it should be called complete. |

| Maturity | Meaning |
|---|---|
| M0 Idea | Opportunity only; no agreed behavior. |
| M1 Specified | User behavior and constraints are written down. |
| M2 Prototype | A spike or partial path exists. |
| M3 Implemented | The feature exists in the application and has a primary path. |
| M4 Behavior-validated | Focused browser or integration checks cover the important behavior. |
| M5 Hardened | Cross-browser, accessibility, failure, persistence, and performance evidence exists. |

The current repository has many M3 and M4 features. It does not yet have a repeatable CI test command or broad M5 evidence, so the tracker does not use M5 casually.

## Current Product Snapshot

| Area | Status | Maturity | Evidence / limitation |
|---|---|---:|---|
| Source Markdown editing | Shipped | M4 | CodeMirror 6, Markdown language support, line numbers, wrapping, search, undo/redo, cursor status. |
| Split preview | Shipped | M4 | markdown-it rendering, proportional scroll sync, task lists, footnotes, links, headings, code highlighting. |
| Preview-only mode | Shipped | M3 | Stable mode exists; no live WYSIWYG/source overlay mode. |
| Visual table editor | Shipped | M4 | Strongest part of the current product; the table-specific smoke coverage is broad. |
| Semantic inline formatting | Shipped, caveat | M4 | Shared engine handles nested and partial Bold/Italic/Strike/Code, links, protected syntax; it is a custom Markdown subset, not a full CommonMark AST transform. |
| Local document persistence | Shipped, caveat | M4 | Dexie/IndexedDB for documents, snapshots, and assets; versioned backup/import, storage health, retryable saves, and offline smoke validation now exist, but browser quota stress remains. |
| Image attachments | Shipped | M3 | Paste/drop/upload, portable `assets/...` Markdown export, backup/import remapping, deletion cleanup, and the visible Assets manager are implemented; artifact and offline validation remain. |
| Export | Shipped, caveat | M4 | Portable Markdown/ZIP, versioned backup ZIP, standalone HTML, and browser-print PDF exist; pure artifact tests cover Markdown ZIP, standalone HTML, and print HTML, but browser print itself is not automated. |
| PWA/offline | Shipped, caveat | M2 | Manifest and Workbox service worker are configured; real offline and update behavior is not validated. |
| Accessibility | Shipped, caveat | M3 | Labels, menu/tab/status semantics, visible keyboard focus, reduced-motion support, key contrast checks, and mobile shell checks exist; screen-reader, full contrast, keyboard-only, and touch workflow audits remain. |
| Automated quality | Shipped, caveat | M4 | `npm test` runs 31 pure contracts and CI runs typecheck/tests/build plus Chromium/Firefox/WebKit and mobile smoke suites on Node 20; broader device/browser coverage remains. |

## Table Model And Markdown Contract

| ID | Requirement | Status | Maturity | Current implementation / next proof |
|---|---|---|---:|---|
| T1 | First row is always the Markdown header | Shipped | M4 | `TableBlock.rows[0]` is the header; delete and promote operations preserve the invariant. |
| T2 | Alignment separator is derived and not user-editable | Shipped | M4 | `core/tables.ts` parses separator alignment and `serializeTable()` regenerates it. |
| T3 | Escape-aware pipe parsing | Shipped | M4 | `parseRow()` respects escaped pipes and code spans. Add property tests for nested/escaped combinations. |
| T4 | Ragged rows normalize safely | Shipped | M3 | Rows are padded to the widest row. |
| T5 | Single-column and header-only tables | Shipped | M3 | Model and serializer support them; targeted regression tests should be promoted from browser-only checks. |
| T6 | Pipe characters are escaped on output | Shipped | M4 | Serializer escapes `|`; deliberate inline syntax is preserved. |
| T7 | Cell content is preserved through parse/edit/serialize | Shipped, caveat | M3 | Common paths work; links, images, math, HTML, escaped syntax, and malformed Markdown need a round-trip fixture suite. |
| T8 | Per-cell alignment | Declined | M1 | GFM pipe tables encode one alignment rule per column. The UI correctly applies cell-originated alignment to the whole column and explains why. |
| T9 | Merged cells | Declined | M1 | The matrix model has no rowspan/colspan representation and Markdown pipe tables cannot preserve it. Clipboard paste flattens merged cells to value plus empty cells. |
| T10 | Multi-line cells | Declined | M1 | No portable GFM representation is promised. HTML `<br>` can be a future explicit portability mode, not an implicit table behavior. |
| T11 | Canonical aligned Markdown output | Shipped | M4 | Output is padded and diff-friendly. Add golden fixtures to make formatting changes reviewable. |
| T12 | Table source diff preview before Apply | Planned | M1 | Important trust feature: show the exact Markdown change before committing a large grid edit. |

## Grid And Selection

| ID | Requirement | Status | Maturity | Current implementation / next proof |
|---|---|---|---:|---|
| G1 | Column letter bar A…Z, AA… | Shipped | M4 | Generated by `colLetter()` and rendered as the control header. |
| G2 | Row-number gutter with header row visually distinct | Shipped | M4 | Sticky `.te-num`; row 1 is the model header and has distinct styling. |
| G3 | Corner cell selects all | Shipped | M4 | `Sel.kind === 'all'`; bulk operations use it. |
| G4 | Single-cell selection and focus ring | Shipped | M4 | Inputs remain always editable; focus and selection readout replace a two-mode spreadsheet editor. |
| G5 | Whole-row selection | Shipped | M4 | Click row number. |
| G6 | Whole-column selection | Shipped | M4 | Click column letter. |
| G7 | Ctrl/Cmd multi-row selection | Shipped | M4 | Toggle set semantics. |
| G8 | Shift contiguous row selection | Shipped | M4 | Anchor row plus range selection. |
| G9 | Ctrl/Cmd multi-column selection | Shipped | M4 | Toggle set semantics. |
| G10 | Shift contiguous column selection | Shipped | M4 | Anchor column plus range selection. |
| G11 | Rectangular drag selection | Planned | M1 | Native input text selection is the current conflict. A future table-selection layer needs a deliberate mouse/keyboard model. |
| G12 | Shift+arrow range expansion | Planned | M1 | Depends on a rectangular selection model. |
| G13 | Ctrl/Cmd+A inside a focused table | Planned | M1 | Must not steal editor-level select-all without an explicit table-focus rule. |
| G14 | Selection readout | Shipped | M4 | Cell, row, column, range, and all-cells labels are visible in the ops bar. |
| G15 | Selection highlighting | Shipped | M4 | Accent-soft fill and header/gutter selection state. Contrast still needs an accessibility audit. |
| G16 | Keyboard navigation | Shipped | M4 | Enter, Tab, Shift+Tab, arrows, and append-on-last-cell behavior. Home/End remain intentionally unimplemented. |
| G17 | Double-click edit mode | Declined | M1 | Always-editable inputs reduce mode confusion and are faster for this compact grid. |
| G18 | Delete/Backspace clears selected cells | Declined | M1 | In an input it should edit text. Explicit Clear controls are safer. |
| G19 | Mobile/touch selection model | Partial | M2 | Responsive layout exists, but hover/corner affordances and keyboard behavior require a touch-specific design. |

## Contextual Insertion Controls

The old tracker described full guide lines, edge bands, delays, and data-cell zones. Those statements are obsolete. The current behavior is intentionally narrower.

| ID | Requirement | Status | Maturity | Current implementation / next proof |
|---|---|---|---:|---|
| H1 | Row `+` is triggered only by `.te-num` | Shipped | M4 | Data cells, including column A, never trigger Row `+`. |
| H2 | Row top-left hotspot inserts above current row | Shipped | M4 | Uses a clipped corner-circle intent with the current percentage radius. |
| H3 | Row bottom-left hotspot inserts below current row | Shipped | M4 | Uses `insertRowAt(rowIndex + 1)`. |
| H4 | Row hotspot requires pointer inside actual gutter rectangle | Shipped | M4 | Geometry helper checks rectangle intersection before distance. |
| H5 | Column `+` is triggered only by `.te-letter` | Shipped | M4 | Data cells and row gutter never trigger Column `+`. |
| H6 | Column top-left hotspot inserts before current column | Shipped | M4 | Uses `insertColAt(columnIndex)`. |
| H7 | Column top-right hotspot inserts after current column | Shipped | M4 | Uses `insertColAt(columnIndex + 1)`. |
| H8 | Hotspot radius is percentage-based | Shipped, caveat | M4 | Current code uses `Math.min(width, height) * 0.25`; this is a tuned UX value, not a universal Canva equivalence. It needs touch/viewport regression coverage. |
| H9 | No edge-band or whole-gutter trigger | Shipped | M4 | No generic 5px edge decision remains in the current intent helpers. |
| H10 | Immediate hide outside valid hotspot | Shipped | M4 | Stage-level pointer evaluation recomputes the current intent; the circle-button travel exception remains only for clicking. |
| H11 | Resize grips have priority | Shipped | M4 | Grip hit zones suppress contextual controls and remain draggable. |
| H12 | No visible guide line | Shipped | M4 | The handle parent is transparent and dimensionless; only the circle is visible. |
| H13 | Handle follows the current boundary, not previous intent | Shipped | M4 | Stage-level coordinate lookup fixes transitions across the plus-button hit ring. |
| H14 | Exact one row and one column control | Shipped | M4 | Controls are repositioned single instances, not rendered per row/column. |
| H15 | Touch-friendly insertion controls | Planned | M1 | Hover is not available on touch. Add explicit, persistent insertion affordances or a long-press mode rather than guessing. |
| H16 | Contextual control reduced-motion behavior | Planned | M1 | Respect `prefers-reduced-motion`; current fade/flash behavior is not audited. |

## Formatting And Bulk Operations

| ID | Requirement | Status | Maturity | Current implementation / next proof |
|---|---|---|---:|---|
| F1 | Bold, Italic, Strike, Code in a cell | Shipped | M4 | Shared semantic engine in `core/inlineFormatting.ts`. |
| F2 | Same semantics in main toolbar and table toolbar | Shipped | M4 | Both route through `toggleInlineMarkup()`. |
| F3 | Bold + Italic nesting | Shipped | M4 | Canonical `***text***` representation. |
| F4 | Strike around nested marks | Shipped | M4 | `~~***text***~~` is recognized and each mark can be removed independently. |
| F5 | Partial word selection | Shipped | M4 | Semantic characters are split and reserialized around the selected range. |
| F6 | Whole-cell formatting | Shipped, caveat | M4 | Empty/protected characters are skipped; all eligible visible characters are formatted. |
| F7 | Mixed row/column/table formatting | Shipped | M4 | Mixed means apply to missing marks; all-have means remove. Empty cells are skipped. |
| F8 | Link label formatting without URL mutation | Shipped | M4 | Link destination is kept opaque. |
| F9 | Code, image, math, HTML, escaped syntax protection | Shipped, caveat | M4 | Protected regions are covered by pure tests; add broader CommonMark fixture tests before calling it hardened. |
| F10 | Active / inactive / mixed state | Shipped | M4 | Main toolbar and table toolbar query semantic mark state. Mixed visual styling needs a final design/accessibility pass. |
| F11 | Formatting preserves block syntax | Shipped, caveat | M3 | Heading/list/fence/rule/table structure is protected; this is a safety layer, not a full Markdown AST transform. |
| F12 | Undo/redo groups one formatting action | Shipped | M4 | Table editor snapshots operations. CodeMirror handles source-editor history. |
| F13 | Formatting parser has unit/property tests | Shipped, caveat | M3 | `test/inlineFormatting.test.ts` covers nested, partial, protected, structural, and state behavior; property-based and full CommonMark coverage remain. |
| F14 | Canonical Markdown normalization | Planned | M1 | Add an explicit safe-normalize command with before/after diff, not silent rewriting. |

## Structure And Row/Column Operations

| ID | Requirement | Status | Maturity | Current implementation / next proof |
|---|---|---|---:|---|
| S1 | Add row/column from visible bar controls | Shipped | M4 | `+ Row` and `+ Column` call the same insertion functions. |
| S2 | Duplicate row/column | Shipped | M4 | Copies cell values and view-only sizing metadata. |
| S3 | Move row up/down | Shipped | M4 | Header guard and boundary disabling are present. |
| S4 | Move column left/right | Shipped | M4 | Alignments and view-only widths move with the column. |
| S5 | Clear row/column/all | Shipped | M4 | Explicit action, undoable. |
| S6 | Delete row/column with guards | Shipped | M4 | Header is protected; at least one body row and one column remain. |
| S7 | Promote body row to header | Shipped | M4 | Replace and Move choices; nested dialog is Esc-safe. |
| S8 | Sort body rows | Shipped | M4 | Stable, numeric-aware, header excluded. |
| S9 | View-only contains filter | Shipped | M4 | Apply writes all rows, including hidden rows. |
| S10 | Clipboard row/column/all TSV | Shipped | M3 | Browser clipboard path exists; permission and multi-browser behavior need validation. |
| S11 | TSV paste expands grid | Shipped | M4 | Table editor and source-editor paste paths exist. |
| S12 | Whole-table clipboard replacement | Shipped | M3 | Available through select-all paste; needs large-table and malformed-clipboard tests. |
| S13 | Drag-to-reorder | Planned | M1 | Move buttons cover the current need; drag ghost/indicator is a later ergonomics improvement. |
| S14 | Formula/type-aware columns | Planned | M1 | Must remain Markdown-compatible and should be an optional table-assistance layer, not stored proprietary metadata. |

## Persistence, Assets, Export, And Portability

| ID | Requirement | Status | Maturity | Current implementation / next proof |
|---|---|---|---:|---|
| P1 | IndexedDB documents | Shipped | M4 | Dexie stores docs, snapshots, and assets. |
| P2 | Debounced autosave with multi-document durable recovery | Shipped, caveat | M4 | 650ms debounce; quota/storage errors show Retry save, persist one latest failed draft per document locally, and offer restore or recovered-copy creation on the next load. Quota stress remains. |
| P3 | Named snapshots | Shipped | M3 | Ctrl/Cmd+S opens a label dialog. |
| P4 | Automatic snapshots | Shipped, caveat | M3 | Checks every three minutes but snapshots only when content changed since load or the last snapshot; opening an idle document creates none; newest 40 retained; timer behavior is not tested across tab suspension. |
| P5 | Restore safety snapshot | Shipped | M3 | `pre-restore` snapshot is created before restore. |
| P6 | Backup all documents, snapshots, and assets | Shipped | M4 | Versioned manifest ZIP includes document metadata, snapshot content, and referenced attachment blobs. |
| P7 | Backup import and ID-safe restore | Shipped, caveat | M3 | Import creates new document/asset IDs, rewrites attachment references, restores snapshots, and reports missing references; conflict policy is duplicate-as-new. |
| P8 | Orphan asset garbage collection and manager | Shipped, caveat | M3 | Deletion cleanup and a visible Assets manager are implemented; cleanup is user-triggered for current orphans and storage/offline validation remains. |
| P9 | Standalone HTML export | Shipped | M3 | Preview HTML and image blobs are embedded. |
| P10 | PDF export | Shipped, caveat | M3 | Browser print pipeline, selectable text, three themes; it requires a popup and user Save-as-PDF action. |
| P11 | Portable Markdown export | Shipped, caveat | M4 | Attachment-bearing ZIPs rewrite references to standard `assets/...` paths; pure artifact tests cover the ZIP, while missing blobs and browser rendering remain caveats. |
| P12 | Settings persistence | Shipped | M3 | Theme, mode, sidebar, inline HTML, and single-newline behavior in localStorage. |
| P13 | PWA lifecycle/installability | Shipped, caveat | M3 | Manifest/service worker configured; top-bar lifecycle status reports cache readiness, updating, updated, or unavailable; installability/update browser matrix remains. |
| P14 | Real offline editing | Shipped, caveat | M3 | CI workflow is configured to verify service-worker readiness, offline reload, cached app boot, IndexedDB content recovery, and Offline status; the configured matrix has not run in the current Node 18 environment and update/failure testing remains. |
| P15 | Import backup package | Shipped, caveat | M3 | Library Tools > Import accepts MarkFlow manifest ZIPs and ordinary ZIPs containing `.md` files; MarkFlow packages restore snapshots/assets, while generic Markdown ZIPs import documents only; corrupt or unsupported ZIPs are rejected. |
| P16 | File System Access / folder sync | Planned | M0 | Future optional adapter; do not make it a core dependency. |
| P17 | Storage health and persistence report | Shipped, caveat | M4 | Library Tools reports document/snapshot/asset counts, browser quota estimate when available, persistent-storage state, connectivity, and pending-save state; pure IndexedDB health contracts pass, while quota enforcement remains browser-dependent. Users can explicitly request persistent storage where supported. |

## Accessibility, Mobile, Performance, And Quality

| ID | Requirement | Status | Maturity | Current implementation / next proof |
|---|---|---|---:|---|
| Q1 | Labels and roles | Shipped | M3 | Buttons, dialogs, table controls, menus, live status regions, and mode tabs expose semantics. |
| Q2 | Keyboard access | Shipped, caveat | M3 | Main shortcuts and table navigation exist; complete focus-order and screen-reader review is missing. |
| Q3 | Reduced motion | Shipped, caveat | M2 | Global `prefers-reduced-motion` rules suppress long transitions/animations; visual audit remains. |
| Q4 | Contrast validation | Shipped, caveat | M2 | Browser smoke checks key light-theme text against AA contrast; full WCAG/manual dark-theme and component audit remains. |
| Q5 | Responsive layout | Shipped, caveat | M3 | Mobile smoke checks no document overflow and primary controls; full touch table workflow remains unproven. |
| Q6 | 1 MB document performance budget | Missing | M0 | Plan states 60fps as a principle but no benchmark exists. |
| Q7 | Large table performance | Risk | M1 | Virtualization is intentionally deferred; measure realistic row/column limits before promising scale. |
| Q8 | CI test command | Shipped, caveat | M4 | GitHub Actions is configured to run TypeScript, pure tests, production build, and Chromium/Firefox/WebKit plus mobile smoke suites on Node 20; this is configured evidence, not a locally observed CI pass. |
| Q9 | Pure parser unit tests | Shipped, caveat | M4 | 25 Vitest contracts cover formatting, tables, attachment paths, backup packages, export artifacts, generic ZIP import, malformed inputs, and property-based round trips; browser compatibility remains. |
| Q10 | Export artifact tests | Shipped, caveat | M3 | Pure tests cover portable Markdown ZIP contents, HTML escaping/styles, and print HTML generation; browser print and full asset-render artifacts remain. |

## Corrected Round History

The historical round labels remain useful as change history, but they are not current feature statuses.

| Historical label | Correct interpretation now |
|---|---|
| R3 | Grid foundation shipped: letter bar, row gutter, selection, navigation, structural controls. |
| R4 | Bulk operations, alignment explanation, sort/filter, resize, expanded window, and wide-table handling shipped. |
| R5 | Ops-bar placement and early contextual-handle issues were resolved, but the old “partial spans are skipped” formatting rule is obsolete. |
| R6 | Contextual controls were refined several times. Current behavior is corner-hotspot-only, gutter-only, rectangle-clipped, synchronous, circle-only, and uses a tuned 25% radius. The old full guide-line, 5px-band, first-data-column, and delayed-hover descriptions are no longer valid. |

## Recommended Next Work

Priority order is based on trust and differentiation, not feature count:

1. Add one-click safe Markdown Confidence repairs backed by the source diff.
2. Add the renderer/platform comparison described in the product plan.
3. Add offline network-drop, service-worker update, browser quota, and failed-save tests.
4. Add mobile/touch insertion and selection behavior before adding more desktop-only table features.

## Horizon 1: Markdown Confidence

| ID | Requirement | Status | Maturity | Current implementation / next proof |
|---|---|---|---:|---|
| C1 | Confidence diagnostics panel | Shipped, caveat | M3 | Read-only local analyzer reports broken links, missing attachments, malformed tables, unclosed inline marks/code, heading hierarchy and duplicate-anchor warnings, raw HTML, and Mermaid/local-attachment portability warnings. It reports line/column locations; remote URLs are intentionally not fetched. |
| C2 | One-click safe fixes with source diff | Planned | M1 | Follows the Source Diff Before Apply slice; no automatic repair is offered by the current panel. |

## Horizon 1: Source Diff And Portable Package

| ID | Requirement | Status | Maturity | Current implementation / next proof |
|---|---|---|---:|---|
| D1 | Table source diff before Apply | Shipped | M4 | The table editor opens a nested exact line diff before committing any grid change, including bulk formatting, sorting, filtering, and structural operations. Back returns to the grid without applying changes; confirmation uses the existing Apply callback. |
| D2 | Source toolbar before/after review | Partial | M2 | Main source-editor formatting remains CodeMirror-native and does not show a separate diff modal. Extend the review boundary only for multi-operation source actions where the scope is clear. |
| D3 | Version history diff before restore | Shipped | M4 | Matching snapshots show Current version with download only. Other snapshots route both Diff and Restore through a comparison modal with unified/side-by-side modes, automatic large-change selection, wrapped responsive panes, sticky controls, draggable split, maximize/restore, line numbers, synchronized scrolling, All/Diff/Same filtering, persistent unchanged-context expansion, Prev/Next navigation, and explicit restore confirmation. |
| D4 | Persisted snapshot deduplication | Shipped | M4 | Ordinary and pre-restore snapshots compare against the newest persisted snapshot. Returning to an older content state still creates a new snapshot when it differs from the latest; duplicate safety checkpoints are avoided. |
| P18 | Portable `.markflow.zip` package | Shipped, caveat | M4 | Schema 2 package manifests documents, snapshots, settings, and referenced assets; Markdown under `docs/` uses `../assets/...` paths; import remaps assets back to local IDs and restores settings. Legacy schema 1 `markflow-backup` packages remain readable. |
