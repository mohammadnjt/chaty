// Day or night: the light theme swaps the night sky for a sunny one and the
// app for light surfaces. The choice is kept on this device, shared by the
// landing page and the app. index.html and landing.html apply it before the
// first paint (see their inline script), so there's no flash.
import { create } from 'zustand';
import { storage } from './config';

export type ThemeChoice = 'dark' | 'light' | 'system';
export type Theme = 'dark' | 'light';

const KEY = 'chaty.theme';
const prefersLight = () => window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false;

function read(): ThemeChoice {
  const v = storage.get(KEY);
  return v === 'light' || v === 'system' ? v : 'dark';
}

const resolve = (choice: ThemeChoice): Theme => (choice === 'system' ? (prefersLight() ? 'light' : 'dark') : choice);

export const useTheme = create<{ choice: ThemeChoice; theme: Theme }>(() => {
  const choice = read();
  return { choice, theme: resolve(choice) };
});

function apply(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  // The browser bar and the Android status bar follow along.
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#3b8fe8' : '#0a0e24');
}

export function setTheme(choice: ThemeChoice) {
  storage.set(KEY, choice);
  const theme = resolve(choice);
  useTheme.setState({ choice, theme });
  apply(theme);
}

/** The moon / sun switch: flips between day and night. */
export const toggleTheme = () => setTheme(useTheme.getState().theme === 'dark' ? 'light' : 'dark');

apply(useTheme.getState().theme);
window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => {
  const { choice } = useTheme.getState();
  if (choice === 'system') setTheme('system');
});
