export const WELCOME_MD = `# Welcome to MarkFlow

A **local-first** Markdown editor. Everything you write stays in *this browser* — no account, no server, no tracking. Delete your site data and it's gone, so use **Backup all** in the sidebar now and then.

## The five-minute tour

**1. Three ways to work.** Use the **Source / Split / Preview** switch (top right). Split keeps both panes scrolling together.

**2. Formatting without memorizing syntax.** Select text and hit the toolbar, or use shortcuts — **Ctrl+B** bold, **Ctrl+I** italic, **Ctrl+E** code, **Ctrl+K** link. Press **Ctrl+S** anytime to pin a named snapshot into *History*.

**3. Tables that don't suck.** Click **⊞ ＋Table** in the toolbar (or hover any table in the preview and press *Edit table*) to open the grid editor: add, move and delete rows/columns, set alignment, and **paste ranges straight from Excel or Google Sheets**. Your source always stays perfectly aligned:

| Feature        | Status     | Notes                        |
| :------------- | :--------: | ---------------------------: |
| Visual tables  | ✅ shipped | add/move/delete/paste TSV    |
| Local images   | ✅ shipped | paste or drop right in       |
| PDF export     | ✅ shipped | File → Export → PDF theme    |
| Collaboration  | 🔜 v2      | comments & live co-editing   |

**4. Images that just work.** Paste a screenshot or drop a file — it's stored *locally* in IndexedDB and exported alongside your document. Try it now: copy any image and Ctrl+V here.

**5. Made for technical writing.** Math with KaTeX — e.g. $e^{i\\pi} + 1 = 0$ — diagrams with Mermaid, and highlighted code blocks:

\`\`\`mermaid
flowchart LR
  A[Write Markdown] --> B{MarkFlow}
  B --> C[Preview]
  B --> D[Beautiful PDF]
  B --> E[Clean .zip backup]
\`\`\`

\`\`\`js
// fenced code with syntax highlighting
export const hello = (name) => \`Hello, \${name}!\`;
\`\`\`

- [x] Local autosave
- [x] Named snapshots & version history
- [ ] Your first document — press **+ New document** in the sidebar

> Everything is a real Markdown file under the hood. No lock-in, ever.[^1]

[^1]: Footnotes work too. Export to **.md**, **standalone HTML** (images embedded), or **PDF** with the Export button — nothing ever leaves your machine.
`;
