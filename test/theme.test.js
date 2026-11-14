import { describe, it, expect, afterEach } from 'vitest';
import { THEME_KEY, applyTheme, readTheme, resolveTheme, setTheme } from '../src/lib/theme.js';

const store = (initial = {}) => {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); },
  };
};

afterEach(() => { delete document.documentElement.dataset.theme; });

describe('readTheme', () => {
  // An update must not change how the app looks to someone who never opened Settings.
  it('is light until the reader chooses', () => {
    expect(readTheme(store())).toBe('light');
  });

  it('returns what was chosen', () => {
    expect(readTheme(store({ [THEME_KEY]: 'dark' }))).toBe('dark');
    expect(readTheme(store({ [THEME_KEY]: 'system' }))).toBe('system');
  });

  it('ignores a value it does not know', () => {
    expect(readTheme(store({ [THEME_KEY]: 'sepia' }))).toBe('light');
  });

  it('is light when storage cannot be read', () => {
    expect(readTheme({ getItem: () => { throw new Error('blocked'); } })).toBe('light');
  });
});

describe('resolveTheme', () => {
  it('follows the computer only when asked to', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});

describe('applyTheme', () => {
  it('puts the theme on the root element, where the stylesheet reads it', () => {
    applyTheme('dark', { prefersDark: false });
    expect(document.documentElement.dataset.theme).toBe('dark');
    applyTheme('system', { prefersDark: false });
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});

describe('setTheme', () => {
  it('remembers the choice and shows it at once', () => {
    const saved = store();
    setTheme('dark', saved);
    expect(saved.data[THEME_KEY]).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('still changes the page when the choice cannot be saved', () => {
    setTheme('dark', { setItem: () => { throw new Error('full'); } });
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('refuses a theme that does not exist', () => {
    const saved = store();
    setTheme('sepia', saved);
    expect(saved.data).toEqual({});
  });
});
