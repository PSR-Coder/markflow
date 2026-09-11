// The rendering engine: markdown-it (15-year battle-tested parser — NOT a regex cascade),
// GFM tables + strikethrough built in, task lists, footnotes, KaTeX, Mermaid, hljs.
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/common';
import taskLists from 'markdown-it-task-lists';
import footnote from 'markdown-it-footnote';
import katexPlugin from './math';
import { settings } from '../state';

export function slugify(text: string, used: Set<string>): string {
  const base = text.toLowerCase().trim()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'section';
  let slug = base;
  let i = 2;
  while (used.has(slug)) slug = `${base}-${i++}`;
  used.add(slug);
  return slug;
}

export function createRenderer(): MarkdownIt {
  const md: MarkdownIt = new MarkdownIt({
    html: settings.renderHtml,
    linkify: true,
    breaks: settings.lineBreaks,
    highlight(str: string, lang: string): string {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return `<pre><code class="hljs language-${lang}">${hljs.highlight(str, { language: lang, ignoreIllegals: true }).value}</code></pre>`;
        } catch { /* fall through */ }
      }
      return `<pre><code class="hljs">${md.utils.escapeHtml(str)}</code></pre>`;
    },
  });

  md.use(taskLists, { label: true, labelAfter: true });
  md.use(footnote);
  md.use(katexPlugin);

  // Heading ids (for TOC / cross-reference links), deduped per render.
  const usedSlugs = new Set<string>();
  const defaultHeadingOpen = md.renderer.rules.heading_open ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.heading_open = (tokens, idx, options, _env, self) => {
    if (idx + 1 < tokens.length && tokens[idx + 1].type === 'inline') {
      tokens[idx].attrSet('id', slugify(tokens[idx + 1].content, usedSlugs));
    }
    return defaultHeadingOpen(tokens, idx, options, _env, self);
  };
  const origRender = md.render.bind(md);
  md.render = (src: string, env?: any) => { usedSlugs.clear(); return origRender(src, env); };

  // External links open in a new tab; bare URLs too.
  const defaultLinkOpen = md.renderer.rules.link_open ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
    const href = tokens[idx].attrGet('href') || '';
    if (/^https?:\/\//i.test(href)) {
      tokens[idx].attrSet('target', '_blank');
      tokens[idx].attrSet('rel', 'noopener noreferrer');
    }
    return defaultLinkOpen(tokens, idx, options, _env, self);
  };

  // Mermaid diagrams: fenced ```mermaid blocks become live SVG after post-processing.
  const defaultFence = md.renderer.rules.fence ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.fence = (tokens, idx, options, _env, self) => {
    const info = tokens[idx].info.trim().split(/\s+/)[0].toLowerCase();
    if (info === 'mermaid') {
      const code = md.utils.escapeHtml(tokens[idx].content);
      return `<div class="mermaid-diagram" data-mermaid-src="${code}"><pre style="opacity:.6">diagram…</pre></div>`;
    }
    return defaultFence(tokens, idx, options, _env, self);
  };

  // Local-asset images: ![alt](attachment:<id>) — src resolved from IndexedDB later.
  const defaultImage = md.renderer.rules.image ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.image = (tokens, idx, options, _env, self) => {
    const src = tokens[idx].attrGet('src') || '';
    if (src.startsWith('attachment:')) {
      tokens[idx].attrSet('data-asset', src.slice('attachment:'.length));
      tokens[idx].attrSet('src', '');
      tokens[idx].attrSet('data-asset-img', '');
    }
    return defaultImage(tokens, idx, options, _env, self);
  };

  return md;
}

// ---------- post-render upgrades (mermaid needs async, so it runs after innerHTML) ----------

let mermaidModule: any = null;
let mermaidSeq = 0;

export async function postRender(container: HTMLElement, theme: 'dark' | 'light'): Promise<void> {
  // Mermaid diagrams
  const diagrams = Array.from(container.querySelectorAll<HTMLElement>('.mermaid-diagram:not([data-done])'));
  if (diagrams.length) {
    try {
      if (!mermaidModule) {
        mermaidModule = (await import('mermaid')).default;
        mermaidModule.initialize({ startOnLoad: false, securityLevel: 'strict', theme: theme === 'dark' ? 'dark' : 'neutral' });
      }
    } catch {
      return; // mermaid failed to load entirely
    }
    for (const el of diagrams) {
      const code = el.getAttribute('data-mermaid-src') || '';
      el.setAttribute('data-done', '1');
      try {
        const { svg } = await mermaidModule.render(`mf-mmd-${Date.now()}-${mermaidSeq++}`, code);
        el.innerHTML = svg;
      } catch (err: any) {
        el.setAttribute('data-error', '');
        el.textContent = `Mermaid: ${String(err?.message || err).split('\n')[0]}`;
      }
    }
  }

  // Local-asset images
  const { resolveAssetUrl } = await import('./images');
  const imgs = Array.from(container.querySelectorAll<HTMLImageElement>('img[data-asset-img]'));
  for (const img of imgs) {
    const id = img.getAttribute('data-asset') || '';
    const url = await resolveAssetUrl(id);
    if (url) {
      img.src = url;
      img.classList.remove('asset-missing');
    } else {
      img.removeAttribute('src');
      img.classList.add('asset-missing');
      img.alt = `[missing attachment: ${img.alt || id}]`;
    }
  }

  // Alt text deserves to be SEEN (#2): wrap standalone images with an alt in
  // <figure> + visible <figcaption> — carries through preview AND exports.
  for (const img of Array.from(container.querySelectorAll<HTMLImageElement>('img[alt]'))) {
    const alt = (img.getAttribute('alt') || '').trim();
    if (!alt || img.closest('td, th, figure, a')) continue;
    const figure = document.createElement('figure');
    img.parentNode?.insertBefore(figure, img);
    figure.appendChild(img);
    const cap = document.createElement('figcaption');
    cap.textContent = alt;
    figure.appendChild(cap);
  }
}
