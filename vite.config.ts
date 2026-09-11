import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: './',
  build: {
    target: 'es2021',
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      output: {
        manualChunks: {
          codemirror: ['codemirror', '@codemirror/lang-markdown', '@codemirror/language-data', '@lezer/markdown'],
          render: ['markdown-it', 'highlight.js', 'katex'],
          mermaid: ['mermaid'],
        },
      },
    },
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['icons/icon.svg'],
      manifest: {
        name: 'MarkFlow — Markdown Editor',
        short_name: 'MarkFlow',
        description: 'Local-first Markdown editor: live preview, visual tables, smart images, beautiful PDF export.',
        theme_color: '#6d5ae7',
        background_color: '#0f1117',
        display: 'standalone',
        start_url: './',
        icons: [
          { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
    }),
  ],
});
