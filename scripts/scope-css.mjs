// Puts every rule of a stylesheet under one ancestor selector, so a theme written for a
// whole page (highlight.js's dark code colours) only applies while the app itself is dark.
//
// It handles what those theme files contain: plain rules, selector lists and comments. It
// is not a CSS parser, and says so rather than guess when it meets a nested rule.

/**
 * @param {string} css
 * @param {string} scope the selector every rule is placed under, e.g. ':root[data-theme="dark"]'
 * @param {(property: string, value: string) => string|null} [rewrite] returns a declaration's
 *   new value, or null to keep it
 */
export function scopeCss(css, scope, rewrite = () => null) {
  if (/@(media|supports|keyframes|font-face|import)\b/.test(css)) {
    throw new Error('scopeCss: at-rules are not supported');
  }
  const rule = /((?:\s*\/\*[\s\S]*?\*\/)*\s*)([^{}]+?)\s*\{([^{}]*)\}/g;
  return css.replace(rule, (whole, lead, selectors, body) => {
    const scoped = selectors.split(',').map((selector) => `${scope} ${selector.trim()}`).join(',\n');
    const declarations = body.replace(/([\w-]+)(\s*:\s*)([^;{}]+?)(\s*(?:;|$))/g, (all, property, colon, value, end) => {
      const next = rewrite(property, value.trim());
      return next === null ? all : `${property}${colon}${next}${end}`;
    });
    return `${lead}${scoped} {${declarations}}`;
  });
}

// highlight.js paints its own background behind the code. The app already draws the block
// the code sits in, in the theme's colours, so in dark mode that background is dropped.
export function darkCodeTheme(css) {
  return scopeCss(css, ':root[data-theme="dark"]', (property, value) => (
    property === 'background' && /^#[0-9a-f]{3,8}$/i.test(value) ? 'transparent' : null
  ));
}
