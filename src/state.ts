// App-wide settings (localStorage) — note: DOCUMENTS live in IndexedDB, never here.

export type ViewMode = 'source' | 'split' | 'preview';
export type ThemeName = 'dark' | 'light';
export type ComparisonMode = 'auto' | 'unified' | 'side-by-side';

export interface Settings {
  theme: ThemeName;
  mode: ViewMode;
  sidebarOpen: boolean;
  renderHtml: boolean;   // allow inline HTML in markdown (off = portable + safe)
  lineBreaks: boolean;   // render single newlines as <br> (off = GitHub/CommonMark parity)
  comparisonMode: ComparisonMode;
  comparisonSplit: number;
}

const KEY = 'mf-settings';

const defaults: Settings = {
  theme: (localStorage.getItem('mf-theme') as ThemeName) ||
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
  mode: 'split',
  sidebarOpen: true,
  renderHtml: false,
  lineBreaks: true, // friendlier default for non-GitHub users; toggle for platform parity
  comparisonMode: 'auto',
  comparisonSplit: 0.5,
};

export const settings: Settings = (() => {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...defaults };
  }
})();

export function saveSettings(): void {
  localStorage.setItem(KEY, JSON.stringify(settings));
  localStorage.setItem('mf-theme', settings.theme);
}
