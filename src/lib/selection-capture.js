// Runs inside the page through chrome.scripting.executeScript. Keep every helper
// nested: Chrome serializes this function without any module scope/closures.
// The result is structured Markdown plus the page's visible H1 for a clean title.
export function captureSelectionMarkdown() {
  function compact(value) {
    return String(value || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
  }

  function clean(value) {
    return String(value || '')
      .replace(/\r/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function escapeText(value) {
    return String(value || '').replace(/\\/g, '\\\\').replace(/([`*_[\]])/g, '\\$1');
  }

  function safeUrl(value) {
    try {
      const url = new URL(String(value || ''), location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
      return url.href.replace(/</g, '%3C').replace(/>/g, '%3E');
    } catch {
      return '';
    }
  }

  function block(value) {
    const body = clean(value);
    return body ? `\n\n${body}\n\n` : '';
  }

  function children(node) {
    return Array.from(node.childNodes || []).map(render).join('');
  }

  function inlineCode(value) {
    const code = String(value || '').replace(/\s+/g, ' ').trim();
    if (!code) return '';
    const longest = Math.max(0, ...Array.from(code.matchAll(/`+/g), (m) => m[0].length));
    const fence = '`'.repeat(Math.max(1, longest + 1));
    const padded = /^`|`$|^\s|\s$/.test(code) ? ` ${code} ` : code;
    return `${fence}${padded}${fence}`;
  }

  function list(node, ordered, depth = 0) {
    const items = Array.from(node.children || []).filter((el) => el.tagName === 'LI');
    let number = Number.parseInt(node.getAttribute('start') || '1', 10) || 1;
    return items.map((item) => {
      let main = '';
      const nested = [];
      for (const child of Array.from(item.childNodes || [])) {
        if (child.nodeType === 1 && /^(UL|OL)$/.test(child.tagName)) {
          nested.push(list(child, child.tagName === 'OL', depth + 1));
        } else {
          main += render(child);
        }
      }
      const marker = ordered ? `${number++}. ` : '- ';
      const indent = '  '.repeat(depth);
      const lines = clean(main).split('\n');
      const first = lines.shift() || '';
      const continuation = lines.map((line) => `${indent}${' '.repeat(marker.length)}${line}`);
      return [`${indent}${marker}${first}`, ...continuation, ...nested.filter(Boolean)].join('\n');
    }).join('\n');
  }

  function table(node) {
    const rows = Array.from(node.querySelectorAll('tr')).map((row) =>
      Array.from(row.children)
        .filter((cell) => /^(TH|TD)$/.test(cell.tagName))
        .map((cell) => clean(children(cell)).replace(/\n+/g, '<br>').replace(/\|/g, '\\|')));
    const width = Math.max(0, ...rows.map((row) => row.length));
    if (!width || !rows.length) return '';
    const normalized = rows.map((row) => Array.from({ length: width }, (_, i) => row[i] || ''));
    const line = (row) => `| ${row.join(' | ')} |`;
    return [line(normalized[0]), line(Array(width).fill('---')), ...normalized.slice(1).map(line)].join('\n');
  }

  function render(node) {
    if (!node) return '';
    if (node.nodeType === 3) return escapeText(String(node.nodeValue || '').replace(/\s+/g, ' '));
    if (node.nodeType !== 1 && node.nodeType !== 11) return '';
    if (node.nodeType === 11) return children(node);

    const tag = node.tagName;
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true'
      || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(node.getAttribute('style') || '')) return '';
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|CANVAS|BUTTON|FORM|INPUT|SELECT|TEXTAREA|SOURCE)$/.test(tag)) return '';

    if (/^H[1-6]$/.test(tag)) {
      const level = Number(tag[1]);
      return block(`${'#'.repeat(level)} ${clean(children(node))}`);
    }
    if (tag === 'P') return block(children(node));
    if (/^(DIV|SECTION|ARTICLE|MAIN|HEADER|FOOTER|ASIDE|FIGURE|ADDRESS)$/.test(tag)) return block(children(node));
    if (tag === 'BR') return '\n';
    if (tag === 'HR') return block('---');
    if (tag === 'STRONG' || tag === 'B') {
      const value = clean(children(node));
      return value ? `**${value}**` : '';
    }
    if (tag === 'EM' || tag === 'I') {
      const value = clean(children(node));
      return value ? `*${value}*` : '';
    }
    if (tag === 'S' || tag === 'DEL' || tag === 'STRIKE') {
      const value = clean(children(node));
      return value ? `~~${value}~~` : '';
    }
    if (tag === 'CODE' && node.parentElement?.tagName !== 'PRE') return inlineCode(node.textContent);
    if (tag === 'PRE') {
      const codeEl = node.querySelector('code');
      const code = String((codeEl || node).textContent || '').replace(/^\n|\n$/g, '');
      const language = ((codeEl?.className || '').match(/(?:language|lang)-([\w+-]+)/i) || [])[1] || '';
      const longest = Math.max(0, ...Array.from(code.matchAll(/`+/g), (m) => m[0].length));
      const fence = '`'.repeat(Math.max(3, longest + 1));
      return block(`${fence}${language}\n${code}\n${fence}`);
    }
    if (tag === 'A') {
      const label = clean(children(node));
      const href = safeUrl(node.getAttribute('href'));
      if (!href) return label;
      return label ? `[${label}](<${href}>)` : `<${href}>`;
    }
    if (tag === 'IMG') {
      const alt = compact(node.getAttribute('alt'));
      const src = safeUrl(node.getAttribute('src'));
      return src ? `![${escapeText(alt || 'Image')}](<${src}>)` : (alt ? `*${escapeText(alt)}*` : '');
    }
    if (tag === 'UL' || tag === 'OL') return block(list(node, tag === 'OL'));
    if (tag === 'LI') return block(children(node));
    if (tag === 'BLOCKQUOTE') {
      const value = clean(children(node));
      return value ? block(value.split('\n').map((line) => line ? `> ${line}` : '>').join('\n')) : '';
    }
    if (tag === 'TABLE') return block(table(node));
    if (/^(THEAD|TBODY|TFOOT|TR|TH|TD)$/.test(tag)) return children(node);
    if (tag === 'FIGCAPTION') {
      const value = clean(children(node));
      return value ? block(`*${value}*`) : '';
    }
    if (tag === 'DT') return block(`**${clean(children(node))}**`);
    if (tag === 'DD') return block(children(node));
    return children(node);
  }

  function pageTitle() {
    const heading = Array.from(document.querySelectorAll('h1')).find((el) => compact(el.textContent));
    return compact(heading?.textContent || document.title).slice(0, 300);
  }

  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return { markdown: '', title: pageTitle() };
  }
  const parts = [];
  for (let i = 0; i < selection.rangeCount; i++) {
    try {
      const holder = document.createElement('div');
      holder.append(selection.getRangeAt(i).cloneContents());
      const markdown = clean(children(holder));
      if (markdown) parts.push(markdown);
    } catch {
      // A frame/navigation race should fall back to contextMenus.selectionText.
    }
  }
  return { markdown: parts.join('\n\n'), title: pageTitle() };
}
