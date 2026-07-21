// Runs inside the page through chrome.scripting.executeScript. Keep every helper
// nested: Chrome serializes this function without any module scope/closures.
// The result is structured Markdown plus the page's visible H1 for a clean title.
export function captureSelectionMarkdown(wholePage = false) {
  const pageImages = [];
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

  function imageSource(value) {
    try {
      const raw = String(value || '');
      if (!raw) return '';
      if (/^data:image\//i.test(raw) || /^blob:/i.test(raw)) return raw;
      return safeUrl(raw);
    } catch {
      return '';
    }
  }

  function invisible(node) {
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true'
      || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(node.getAttribute('style') || '')) return true;
    if (!wholePage) return false;
    if (/(?:^|\s)(?:sr-only|visually-hidden|screen-reader-text)(?:\s|$)/i.test(node.className || '')) return true;
    try {
      const style = getComputedStyle(node);
      return style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse';
    } catch {
      return false;
    }
  }

  function imageRegion(node, src, alt) {
    const rect = node.getBoundingClientRect();
    const width = Number(rect.width) || Number(node.naturalWidth) || 0;
    const height = Number(rect.height) || Number(node.naturalHeight) || 0;
    // Ignore avatars, favicons, reaction glyphs, and other UI chrome. Meaningful chat
    // uploads and generated images are comfortably larger than this threshold.
    if (width < 48 || height < 48) return null;

    const state = globalThis.__owlNoteFullPageCaptureV1;
    let x;
    let y;
    if (state?.nestedScroller && state.scrollTarget?.isConnected) {
      const viewport = state.scrollTarget.getBoundingClientRect();
      x = rect.left - viewport.left + state.scrollTarget.scrollLeft;
      y = rect.top - viewport.top + state.scrollTarget.scrollTop;
    } else {
      x = rect.left + (globalThis.scrollX || 0);
      y = rect.top + (globalThis.scrollY || 0);
    }
    const index = pageImages.length;
    const placeholder = `![${escapeText(alt || 'Image')}](owl-smart-img:${index})`;
    pageImages.push({ index, src, alt: alt || 'Image', placeholder, x, y, width, height });
    return placeholder;
  }

  function assistantName() {
    const identity = `${document.title || ''} ${globalThis.location?.hostname || ''}`;
    if (/claude/i.test(identity)) return 'Claude';
    if (/gemini/i.test(identity)) return 'Gemini';
    if (/copilot/i.test(identity)) return 'Copilot';
    if (/chatgpt|openai/i.test(identity)) return 'ChatGPT';
    // data-message-author-role is the stable marker used by ChatGPT. Keep that
    // established label when the page does not expose a more specific provider.
    return 'ChatGPT';
  }

  function messageLabel(node) {
    const role = node.getAttribute('data-message-author-role');
    if (role === 'user') return 'You';
    if (role === 'assistant') return assistantName();
    if (role === 'tool') return 'Tool';
    if (!wholePage) return '';

    // Claude's shared-chat DOM does not expose data-message-author-role. Instead, each
    // message owns a direct screen-reader heading such as "You said" or "Claude
    // responded". Read it for structure, but invisible() still keeps it out of content.
    const announcement = Array.from(node.children || [])
      .find((child) => child.matches?.('h1[data-find-omitted], h2[data-find-omitted], h3[data-find-omitted]'));
    const announced = compact(announcement?.textContent);
    if (/^you (?:said|asked)\b/i.test(announced)) return 'You';
    if (/^claude (?:responded|said|answered)\b/i.test(announced)) return 'Claude';

    // Attachment-only Claude prompts may not render the announcement. The closest
    // Tailwind `.group` owner of data-testid=user-message is still the message boundary.
    const userMessage = node.querySelector?.('[data-testid="user-message"]');
    const hasAnnouncedDescendant = Array.from(node.querySelectorAll?.('h1[data-find-omitted], h2[data-find-omitted], h3[data-find-omitted]') || [])
      .some((child) => /^you (?:said|asked)\b/i.test(compact(child.textContent)));
    if (!hasAnnouncedDescendant && userMessage?.closest?.('.group') === node) return 'You';
    return '';
  }

  function visualLabel(node) {
    const figure = node.closest?.('figure');
    const tag = String(node.tagName || '').toUpperCase();
    return compact(node.getAttribute('alt')
      || node.getAttribute('aria-label')
      || node.getAttribute('title')
      || node.querySelector?.('title')?.textContent
      || figure?.querySelector?.('figcaption')?.textContent
      || (tag === 'IFRAME' ? 'Embedded content' : 'Visual content'));
  }

  function meaningfulButton(node) {
    const text = compact(node.innerText || node.textContent);
    const label = compact(node.getAttribute('aria-label') || node.getAttribute('title'));
    const control = label || text;
    if (/^(?:copy|retry|regenerate|edit|delete|remove|share|report|show more|show less|previous|next|close|thumbs|good response|bad response)\b/i.test(control)) {
      return false;
    }

    const marker = `${node.getAttribute('data-testid') || ''} ${node.className || ''}`;
    if (node.closest?.('[data-testid="file-thumbnail"]')
      || /(?:artifact|attachment|file-card|citation|source-card|preview)/i.test(marker)) return true;
    if (node.querySelector?.('img, canvas, video, iframe, object, embed')) return true;
    if (node.querySelector?.('h1, h2, h3, h4, h5, h6, p, pre, code, table, blockquote')) return true;
    return text.length >= 80;
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

    const tag = String(node.tagName || '').toUpperCase();
    if (invisible(node)) return '';
    if (wholePage && (/^(NAV|ASIDE|FOOTER)$/.test(tag)
      || /^(navigation|complementary|dialog|toolbar)$/.test(node.getAttribute('role') || ''))) return '';
    if (wholePage && (tag === 'BUTTON' || node.getAttribute('role') === 'button')) {
      return meaningfulButton(node) ? children(node) : '';
    }

    if (wholePage && (/^(SVG|CANVAS|VIDEO|IFRAME|OBJECT|EMBED)$/.test(tag)
      || (node.getAttribute('role') === 'img' && !node.querySelector?.('img')))) {
      const source = node.currentSrc || node.getAttribute('poster') || node.getAttribute('src') || node.getAttribute('data') || '';
      return imageRegion(node, imageSource(source), visualLabel(node)) || '';
    }
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|CANVAS|BUTTON|FORM|INPUT|SELECT|TEXTAREA|SOURCE)$/.test(tag)) return '';

    if (wholePage && (node.classList?.contains('katex') || node.classList?.contains('katex-display'))) {
      const tex = compact(node.querySelector('annotation[encoding="application/x-tex"]')?.textContent);
      if (tex) {
        const display = node.classList.contains('katex-display') || node.closest?.('.katex-display');
        return display ? block(`$$\n${tex}\n$$`) : `$${tex}$`;
      }
    }
    if (wholePage && /^(MATH|MROW|ANNOTATION|SEMANTICS)$/.test(tag)) return '';

    if (wholePage) {
      const speaker = messageLabel(node);
      if (speaker) {
        const value = clean(children(node));
        if (!value) return '';
        return block(`## ${speaker}\n\n${value}`);
      }
    }

    if (/^H[1-6]$/.test(tag)) {
      if (wholePage && /^(?:you|chatgpt) said:?$/i.test(compact(node.textContent))) return '';
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
      const source = node.currentSrc || node.getAttribute('src') || node.getAttribute('data-src');
      const src = wholePage ? imageSource(source) : safeUrl(source);
      if (wholePage) return src ? (imageRegion(node, src, alt) || '') : '';
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
    const headingText = compact(heading?.textContent);
    let documentTitle = compact(document.title);
    if (wholePage) {
      documentTitle = documentTitle
        .replace(/^(?:ChatGPT|Claude|Gemini|Microsoft Copilot)\s*[-|:]\s*/i, '')
        .replace(/\s*[-|:]\s*(?:ChatGPT|Claude|Gemini|Microsoft Copilot)$/i, '');
    }
    const genericHeading = /^(?:ChatGPT|Claude|Gemini|Microsoft Copilot)$/i.test(headingText);
    return compact((wholePage && genericHeading ? documentTitle : headingText) || documentTitle).slice(0, 300);
  }

  function pageRoot() {
    const candidates = [...new Set([
      ...document.querySelectorAll('main, [role="main"], article'),
      document.body,
    ].filter(Boolean))];
    const score = (node) => {
      const text = compact(node.innerText || node.textContent).length;
      const structure = node.querySelectorAll('p, li, pre, blockquote, table, h1, h2, h3, article').length;
      const images = Array.from(node.querySelectorAll('img')).filter((img) => {
        const rect = img.getBoundingClientRect();
        return (rect.width || img.naturalWidth || 0) >= 48 && (rect.height || img.naturalHeight || 0) >= 48;
      }).length;
      const controls = node.querySelectorAll('button, input, textarea, select, nav, aside').length;
      return text + structure * 80 + images * 240 - controls * 8;
    };
    return candidates.sort((a, b) => score(b) - score(a))[0] || document.body;
  }

  if (wholePage) {
    const root = pageRoot();
    return { markdown: clean(render(root)), title: pageTitle(), images: pageImages };
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
