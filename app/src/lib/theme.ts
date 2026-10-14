// Two independent choices, both kept on this device:
// - night or day (or follow the phone): the light theme swaps the night sky
//   for a sunny one and the app for light surfaces. Shared by the landing
//   page and the app.
// - the colour palette (Twilight, Ocean, …): accent colours, surfaces and the
//   landscape (styles.css [data-palette], SCENES in components/Scenery.tsx).
//   The landing page always shows the default one.
// index.html and landing.html apply both before the first paint (see their
// inline script), so there's no flash.
import { create } from 'zustand';
import { storage } from './config';

export type ThemeChoice = 'dark' | 'light' | 'system';
export type Theme = 'dark' | 'light';

export type PaletteId = 'twilight' | 'ocean' | 'forest' | 'sunset' | 'sakura' | 'graphite';

/** Each palette's name, and the browser / status bar colour at night and by day. */
export const PALETTES: { id: PaletteId; name: string; bar: { dark: string; light: string } }[] = [
  { id: 'twilight', name: 'Twilight', bar: { dark: '#0a0e24', light: '#3b8fe8' } },
  { id: 'ocean', name: 'Ocean', bar: { dark: '#021220', light: '#0c86dc' } },
  { id: 'forest', name: 'Forest', bar: { dark: '#021512', light: '#3189da' } },
  { id: 'sunset', name: 'Sunset', bar: { dark: '#1c0a08', light: '#2c83d4' } },
  { id: 'sakura', name: 'Sakura', bar: { dark: '#1c0914', light: '#5d93e2' } },
  { id: 'graphite', name: 'Graphite', bar: { dark: '#07090c', light: '#8092a6' } },
];
export const DEFAULT_PALETTE: PaletteId = 'twilight';

const KEY = 'chaty.theme';
const PALETTE_KEY = 'chaty.palette';
const prefersLight = () => window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false;

function read(): ThemeChoice {
  const v = storage.get(KEY);
  return v === 'light' || v === 'system' ? v : 'dark';
}

function readPalette(): PaletteId {
  const v = storage.get(PALETTE_KEY);
  return PALETTES.find((p) => p.id === v)?.id ?? DEFAULT_PALETTE;
}

const resolve = (choice: ThemeChoice): Theme => (choice === 'system' ? (prefersLight() ? 'light' : 'dark') : choice);

export const useTheme = create<{ choice: ThemeChoice; theme: Theme; palette: PaletteId }>(() => {
  const choice = read();
  return { choice, theme: resolve(choice), palette: readPalette() };
});

function apply() {
  const { theme, palette } = useTheme.getState();
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.palette = palette;
  // The browser bar and the Android status bar follow along.
  const bar = (PALETTES.find((p) => p.id === palette) ?? PALETTES[0]).bar[theme];
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bar);
}

export function setTheme(choice: ThemeChoice) {
  storage.set(KEY, choice);
  useTheme.setState({ choice, theme: resolve(choice) });
  apply();
}

export function setPalette(palette: PaletteId) {
  storage.set(PALETTE_KEY, palette);
  useTheme.setState({ palette });
  apply();
}

/** The landing page keeps the default palette, whatever the app uses. */
export function keepDefaultPalette() {
  useTheme.setState({ palette: DEFAULT_PALETTE });
  apply();
}

/** The moon / sun switch: flips between day and night. */
export const toggleTheme = () => setTheme(useTheme.getState().theme === 'dark' ? 'light' : 'dark');

apply();
window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => {
  const { choice } = useTheme.getState();
  if (choice === 'system') setTheme('system');
});
