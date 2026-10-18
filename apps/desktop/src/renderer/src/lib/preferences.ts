import { useEffect, useState } from 'react';

/**
 * App-wide appearance preferences: which theme, accent, text size and motion the
 * person chose. They are separate from project settings — they belong to the app,
 * not to a workspace — so they live in localStorage and are applied to the
 * document root as CSS variables.
 */
const STORAGE_KEY = 'puff.preferences.v1';

export type ThemeId = 'graphite' | 'midnight' | 'slate' | 'ember';
export type AccentId = 'emerald' | 'blue' | 'violet' | 'amber' | 'rose';

export interface Preferences {
  theme: ThemeId;
  accent: AccentId;
  /** Multiplies the root font size, which scales the whole interface */
  textScale: number;
  reduceMotion: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'graphite',
  accent: 'emerald',
  textScale: 1,
  reduceMotion: false,
};

/** The three semantic tones, tuned to stay legible on every dark surface. */
const SEMANTIC = {
  '--color-good': '#34d399',
  '--color-warn': '#d29922',
  '--color-bad': '#f85149',
} as const;

export interface Theme {
  id: ThemeId;
  name: string;
  description: string;
  /** Four representative colours for the picker swatch, lightest to darkest */
  swatch: [string, string, string, string];
  tokens: Record<string, string>;
}

/**
 * All themes are dark: the memory graph is drawn on a canvas with fixed node
 * colours, so a light canvas would leave some nodes invisible. What changes is
 * how dark the canvas is and its hue.
 */
export const THEMES: Theme[] = [
  {
    id: 'graphite',
    name: 'Graphite',
    description: 'Neutral grey, softer than black',
    swatch: ['#2d2f37', '#25262c', '#1f2025', '#191a1e'],
    tokens: {
      '--color-abyss': '#191a1e',
      '--color-surface': '#1f2025',
      '--color-surface-2': '#25262c',
      '--color-surface-3': '#2d2f37',
      '--color-line': 'rgb(255 255 255 / 0.08)',
      '--color-line-strong': 'rgb(255 255 255 / 0.14)',
      '--color-ink': '#f3f4f6',
      '--color-ink-2': '#b0b2ba',
      '--color-ink-3': '#888a95',
      ...SEMANTIC,
    },
  },
  {
    id: 'midnight',
    name: 'Midnight',
    description: 'The original near-black canvas',
    swatch: ['#1c1c22', '#15151a', '#101013', '#0a0a0c'],
    tokens: {
      '--color-abyss': '#0a0a0c',
      '--color-surface': '#101013',
      '--color-surface-2': '#15151a',
      '--color-surface-3': '#1c1c22',
      '--color-line': 'rgb(255 255 255 / 0.07)',
      '--color-line-strong': 'rgb(255 255 255 / 0.13)',
      '--color-ink': '#f2f2f4',
      '--color-ink-2': '#a4a4ad',
      '--color-ink-3': '#7e7e87',
      ...SEMANTIC,
    },
  },
  {
    id: 'slate',
    name: 'Slate',
    description: 'Cool blue-grey',
    swatch: ['#2f3b4d', '#273142', '#212936', '#1b212b'],
    tokens: {
      '--color-abyss': '#1b212b',
      '--color-surface': '#212936',
      '--color-surface-2': '#273142',
      '--color-surface-3': '#2f3b4d',
      '--color-line': 'rgb(255 255 255 / 0.08)',
      '--color-line-strong': 'rgb(255 255 255 / 0.15)',
      '--color-ink': '#edf0f5',
      '--color-ink-2': '#a9b4c4',
      '--color-ink-3': '#7e8b9d',
      ...SEMANTIC,
    },
  },
  {
    id: 'ember',
    name: 'Ember',
    description: 'Warm brown-grey',
    swatch: ['#392f29', '#2f2723', '#282020', '#211b18'],
    tokens: {
      '--color-abyss': '#211b18',
      '--color-surface': '#282020',
      '--color-surface-2': '#2f2723',
      '--color-surface-3': '#392f29',
      '--color-line': 'rgb(255 255 255 / 0.08)',
      '--color-line-strong': 'rgb(255 255 255 / 0.15)',
      '--color-ink': '#f6efe9',
      '--color-ink-2': '#c2b3a7',
      '--color-ink-3': '#97877a',
      ...SEMANTIC,
    },
  },
];

export interface Accent {
  id: AccentId;
  name: string;
  brand: string;
  soft: string;
  deep: string;
}

/** The single accent, in five hues. Every theme shares the same choices. */
export const ACCENTS: Accent[] = [
  { id: 'emerald', name: 'Emerald', brand: '#34d399', soft: '#6ee7b7', deep: '#059669' },
  { id: 'blue', name: 'Blue', brand: '#60a5fa', soft: '#93c5fd', deep: '#3b82f6' },
  { id: 'violet', name: 'Violet', brand: '#a78bfa', soft: '#c4b5fd', deep: '#8b5cf6' },
  { id: 'amber', name: 'Amber', brand: '#fbbf24', soft: '#fcd34d', deep: '#d97706' },
  { id: 'rose', name: 'Rose', brand: '#fb7185', soft: '#fda4af', deep: '#e11d48' },
];

export const TEXT_SCALES = [
  { id: 'small', label: 'Small', value: 0.9 },
  { id: 'default', label: 'Default', value: 1 },
  { id: 'large', label: 'Large', value: 1.1 },
  { id: 'xlarge', label: 'Extra large', value: 1.25 },
] as const;

/** The theme and accent a preference resolves to, falling back to the defaults. */
function resolve(prefs: Preferences): { theme: Theme; accent: Accent } {
  return {
    theme: THEMES.find((t) => t.id === prefs.theme) ?? THEMES[0]!,
    accent: ACCENTS.find((a) => a.id === prefs.accent) ?? ACCENTS[0]!,
  };
}

/** Write the chosen theme, accent, text size and motion onto the document root. */
export function applyPreferences(prefs: Preferences): void {
  const root = document.documentElement;
  const { theme, accent } = resolve(prefs);
  for (const [key, value] of Object.entries(theme.tokens)) root.style.setProperty(key, value);
  root.style.setProperty('--color-brand', accent.brand);
  root.style.setProperty('--color-brand-soft', accent.soft);
  root.style.setProperty('--color-brand-deep', accent.deep);
  root.style.setProperty('--color-memory', accent.brand);
  root.style.setProperty('--ui-scale', String(prefs.textScale));
  root.dataset.theme = theme.id;
  root.dataset.motion = prefs.reduceMotion ? 'reduced' : 'full';
}

export function loadPreferences(): Preferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFERENCES;
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    return {
      theme: THEMES.some((t) => t.id === parsed.theme)
        ? (parsed.theme as ThemeId)
        : DEFAULT_PREFERENCES.theme,
      accent: ACCENTS.some((a) => a.id === parsed.accent)
        ? (parsed.accent as AccentId)
        : DEFAULT_PREFERENCES.accent,
      textScale:
        typeof parsed.textScale === 'number' && parsed.textScale >= 0.5 && parsed.textScale <= 2
          ? parsed.textScale
          : DEFAULT_PREFERENCES.textScale,
      reduceMotion:
        typeof parsed.reduceMotion === 'boolean'
          ? parsed.reduceMotion
          : DEFAULT_PREFERENCES.reduceMotion,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function savePreferences(prefs: Preferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // A full or blocked store must never break the app; the theme still applies for this session.
  }
}

/** Read, apply and persist the appearance preferences. */
export function usePreferences() {
  const [prefs, setPrefs] = useState<Preferences>(() => loadPreferences());

  useEffect(() => {
    applyPreferences(prefs);
    savePreferences(prefs);
  }, [prefs]);

  return {
    prefs,
    update: (patch: Partial<Preferences>) => setPrefs((p) => ({ ...p, ...patch })),
    reset: () => setPrefs(DEFAULT_PREFERENCES),
  };
}
