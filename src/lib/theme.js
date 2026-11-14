// Light or dark. The choice is kept in localStorage rather than chrome.storage because it
// has to be read before the first paint: theme-boot.js runs in the page's head and sets it
// on the root element, so a dark page never flashes white while the app loads.

export const THEME_KEY = 'owl:theme';
export const THEMES = ['light', 'dark', 'system'];
const DARK_QUERY = '(prefers-color-scheme: dark)';

/** What the reader chose. Light until they choose, so an update never changes the look. */
export function readTheme(store = globalThis.localStorage) {
  try {
    const saved = store?.getItem(THEME_KEY);
    return THEMES.includes(saved) ? saved : 'light';
  } catch {
    return 'light';
  }
}

/** The theme actually shown: 'system' follows the computer. */
export function resolveTheme(choice, prefersDark) {
  return choice === 'dark' || (choice === 'system' && prefersDark) ? 'dark' : 'light';
}

export function applyTheme(choice = readTheme(), {
  root = globalThis.document?.documentElement,
  prefersDark = !!globalThis.matchMedia?.(DARK_QUERY)?.matches,
} = {}) {
  if (root) root.dataset.theme = resolveTheme(choice, prefersDark);
}

export function setTheme(choice, store = globalThis.localStorage) {
  if (!THEMES.includes(choice)) return;
  try { store?.setItem(THEME_KEY, choice); } catch { /* the choice just lasts this page */ }
  applyTheme(choice);
}

/** Follow the computer's setting while 'system' is chosen, and a change made in another tab. */
export function watchTheme() {
  globalThis.matchMedia?.(DARK_QUERY)?.addEventListener?.('change', () => applyTheme());
  globalThis.addEventListener?.('storage', (event) => { if (event.key === THEME_KEY) applyTheme(); });
}
