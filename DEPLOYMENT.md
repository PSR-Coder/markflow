# Deploying MarkFlow to Hostinger Shared Hosting

**No VPS needed. No Node.js on the server. ₹0 extra.** The build output (`dist/`) is ordinary static files — the same kind you already serve for ToolSphere.

## 1. Build locally (or in CI)

```bash
npm install
npm run build
```

This produces the `dist/` folder. Everything users will ever download is inside it.

## 2. Pick the target

| Option | Result |
|---|---|
| Subfolder | `https://yourdomain.com/editor/` → upload into `public_html/editor/` |
| Subdomain | `https://md.yourdomain.com` → hPanel → Domains → Subdomains → create → upload into its `public_html` |
| Root domain | `https://yourdomain.com` → upload into `public_html/` (overwrites ToolSphere homepage — use a subfolder/subdomain instead) |

**Subfolder note:** the build uses `base: './'` (relative asset paths), so subfolder hosting works out of the box.

## 3. Upload

- **Fastest for many files:** hPanel → File Manager → select all of `dist/` *contents* → Upload → Extract. Or zip `dist/` contents locally, upload one zip, and Extract in File Manager.
- **FTP (e.g. FileZilla):** credentials in hPanel → Files → FTP Accounts. Upload `dist/` contents (including hidden `.htaccess` — enable "show hidden files").

**Checklist:** `index.html`, `assets/`, `icons/`, `manifest.webmanifest`, `sw.js`, `.htaccess` all present in the target folder.

## 4. HTTPS

hPanel → Security → SSL → enable the free certificate for the domain/subdomain. The bundled `.htaccess` already redirects http→https.

## 5. Verify

1. Open the URL — the editor loads with the Welcome doc.
2. DevTools → Application → Service Workers → `sw.js` activated (offline now works).
3. Hard-refresh: no 404s in the Network tab (if you see 404s in a subfolder, the upload missed `assets/` — re-upload).

## Updating later

Re-run `npm run build`, upload `dist/` again (overwrite). Users' documents are stored in **their own browser IndexedDB**, so redeploying never touches anyone's data.

## Why this works on shared hosting

| Requirement | Needed on server? |
|---|---|
| Node.js / npm | ❌ build-time only |
| Database | ❌ IndexedDB in the user's browser |
| PHP | ❌ |
| WebSockets | ❌ (only v2 collaboration would add this — via free-tier managed services, still no VPS) |
