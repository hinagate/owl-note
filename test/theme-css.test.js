import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Dark mode is one block of app.css: the same variable names with other values. These
// checks keep that true as the stylesheet grows.

const css = readFileSync('src/app/app.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const block = (selector) => {
  const start = css.indexOf(`${selector} {`);
  return css.slice(start + selector.length + 2, css.indexOf('}', start));
};
const names = (body) => [...body.matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1]);

const light = names(block(':root'));
const dark = names(block(':root[data-theme="dark"]'));
// Green is the app's colour in both themes.
const SAME_IN_BOTH = ['accent', 'accent-dark'];
// Set from code on the element that uses them, not part of a theme.
const SET_BY_CODE = ['col-sidebar', 'chip-bg', 'highlight-color', 'font-color', 'tool-ink', 'swatch-color'];

describe('the theme variables', () => {
  it('gives every colour that varies a dark value', () => {
    const missing = light.filter((name) => !SAME_IN_BOTH.includes(name) && !dark.includes(name));
    expect(missing).toEqual([]);
  });

  it('defines nothing in dark that light does not have', () => {
    expect(dark.filter((name) => !light.includes(name))).toEqual([]);
  });

  it('uses no variable that is not defined', () => {
    const used = new Set([...css.matchAll(/var\(--([a-z0-9-]+)/g)].map((m) => m[1]));
    const unknown = [...used].filter((name) => !light.includes(name) && !SET_BY_CODE.includes(name));
    expect(unknown).toEqual([]);
  });

  it('tells the browser to draw its own controls dark too', () => {
    expect(block(':root[data-theme="dark"]')).toMatch(/color-scheme:\s*dark/);
  });
});

// A white, grey or near-black written straight into a rule stays that colour in dark mode:
// a white panel on a dark page, or dark text on a dark background.
describe('colours written into rules', () => {
  // Places that are meant to look the same in both themes.
  const SAME_ON_PURPOSE = [
    /image-lightbox/,                // already a dark overlay
    /\.draw-canvas\b|\.draw-photo\b|\.draw-text-editor|\.draw-custom-plus|\.draw-scroll/, // the drawing itself is on white
    /\.pronounce-slow input::before/, // the knob of a switch
    /\.preview mark(\.|\[class\*=")highlight-/, // the reader's own highlight colours, and the dark words on them
    /\.preview-content\.phonetics \.(pause-bar|word-link)/, // mid-greys that show on both
    /\.mermaid-diagram svg/,          // diagrams keep a light card
  ];
  const isNeutral = (hex) => {
    const h = hex.length === 4 ? hex.slice(1).replace(/./g, (c) => c + c) : hex.slice(1, 7);
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    return Math.max(r, g, b) - Math.min(r, g, b) <= 16;
  };

  it('take whites, greys and near-blacks from the theme', () => {
    const found = [];
    for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = selectors.trim().replace(/\s+/g, ' ');
      if (selector.startsWith(':root') && !selector.includes(' ')) continue; // the theme blocks
      if (SAME_ON_PURPOSE.some((allowed) => allowed.test(selector))) continue;
      for (const declaration of body.split(';')) {
        const colon = declaration.indexOf(':');
        if (colon < 0) continue;
        const property = declaration.slice(0, colon).trim();
        if (!/^(background(-color)?|color|border|outline)/.test(property)) continue;
        for (const [hex] of declaration.slice(colon + 1).matchAll(/#[0-9a-fA-F]{3,6}\b/g)) {
          if (property === 'color' && /^#fff(fff)?$/i.test(hex)) continue; // white text on a coloured button
          if (isNeutral(hex)) found.push(`${selector} { ${property}: ${hex} }`);
        }
      }
    }
    // If this lists a rule: use a variable from the top of app.css (var(--surface),
    // var(--text), var(--border)...), or add the selector to SAME_ON_PURPOSE above.
    expect(found).toEqual([]);
  });
});
