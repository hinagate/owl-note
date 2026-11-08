// Runs inside the page through chrome.scripting.executeScript. Keep every helper
// nested: Chrome serializes this function without any module scope/closures.
// The result is structured Markdown plus the page's visible H1 for a clean title.
export function captureSelectionMarkdown(mode = false) {
  const wholePage = mode === true || mode === 'whole-page';
  const smartSelection = mode === 'smart-selection';
  const semanticCapture = wholePage || smartSelection;
  const selectionMarker = 'data-owl-note-smart-selection';
  const pageImages = [];
  // Google AI Studio. Its turns are custom elements that only fill in near the screen.
  const studioChat = wholePage && Boolean(document.querySelector('ms-chat-turn'));
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
    if (!semanticCapture) return false;
    if (/(?:^|\s)(?:sr-only|visually-hidden|cdk-visually-hidden|screen-reader-text)(?:\s|$)/i.test(node.className || '')) return true;
    try {
      const style = getComputedStyle(node);
      return style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse';
    } catch {
      return false;
    }
  }

  function imageRegion(node, src, alt) {
    const marker = smartSelection ? node.getAttribute?.(selectionMarker) : '';
    const liveNode = marker
      ? document.querySelector(`[${selectionMarker}="${marker}"]`) || node
      : node;
    const rect = liveNode.getBoundingClientRect();
    const width = Number(rect.width) || Number(liveNode.naturalWidth) || 0;
    const height = Number(rect.height) || Number(liveNode.naturalHeight) || 0;
    // Ignore avatars, favicons, reaction glyphs, and other UI chrome. Meaningful chat
    // uploads and generated images are comfortably larger than this threshold.
    if (width < 48 || height < 48) return null;
    // AI Studio's page grows as its turns fill in, so a screenshot taken afterwards would
    // not line up with what was measured here. Say so rather than crop the wrong place.
    if (studioChat) return `*Image could not be copied: ${escapeText(alt || 'Image')}*`;

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
    const provider = (identity) => {
      if (/claude/i.test(identity)) return 'Claude';
      if (/gemini/i.test(identity)) return 'Gemini';
      if (/copilot/i.test(identity)) return 'Copilot';
      if (/chatgpt|openai/i.test(identity)) return 'ChatGPT';
      return '';
    };
    // The host decides first: a ChatGPT chat can easily be titled "Add overlay next to
    // Gemini". data-message-author-role began as ChatGPT's marker, so keep that label
    // when the page does not expose a more specific provider.
    return provider(globalThis.location?.hostname || '') || provider(document.title || '') || 'ChatGPT';
  }

  function messageLabel(node) {
    const role = node.getAttribute('data-message-author-role');
    if (role === 'user') return 'You';
    if (role === 'assistant') return assistantName();
    if (role === 'tool') return 'Tool';
    if (!semanticCapture) return '';

    // Gemini's turns are custom elements. A reply is <model-response> in the app and a
    // bare <response-container> on a share page; the first contains the second, so only
    // one of them may label.
    const tag = String(node.tagName || '').toUpperCase();
    if (tag === 'USER-QUERY') return 'You';
    if (tag === 'MODEL-RESPONSE') return 'Gemini';
    if (tag === 'RESPONSE-CONTAINER' && !node.closest?.('model-response')) return 'Gemini';
    // AI Studio names the speaker of each turn's content.
    const turnRole = node.getAttribute('data-turn-role');
    if (turnRole === 'User') return 'You';
    if (turnRole === 'Model') return 'Gemini';
    // So does ChatGPT's lighter shared page, which it serves to some visitors.
    const messageRole = node.getAttribute('data-message-role');
    if (messageRole === 'user') return 'You';
    if (messageRole === 'assistant') return assistantName();

    // ChatGPT's signed-in app moved the role onto a screen-reader heading inside each
    // turn. Anonymous visitors still get the older markup, which the checks above label.
    const roleHeading = Array.from(node.children || []).find((child) => child.hasAttribute?.('data-conversation-role'));
    if (roleHeading && !node.querySelector('[data-message-author-role]')) {
      const conversationRole = roleHeading.getAttribute('data-conversation-role');
      if (conversationRole === 'user') return 'You';
      if (conversationRole === 'assistant') return assistantName();
    }

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

  function codeFence(value, language = '') {
    const code = String(value || '').replace(/^\n|\n$/g, '');
    const longest = Math.max(0, ...Array.from(code.matchAll(/`+/g), (m) => m[0].length));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    return block(`${fence}${language}\n${code}\n${fence}`);
  }

  // Code block headers name the language for people ("JavaScript", "Plain text"). A fence
  // takes a single word, so anything else is left out.
  function fenceLanguage(label) {
    const name = compact(label).toLowerCase();
    return /^[\w+#.-]+$/.test(name) && name !== 'code' ? name : '';
  }

  // The words in part of the page, leaving out its controls: a code block's language without
  // the Copy and Run buttons beside it, for instance.
  function plainText(root, skip) {
    let text = '';
    const walk = (node) => {
      if (node === skip || text.length > 80) return;
      if (node.nodeType === 3) { text += `${node.nodeValue} `; return; }
      if (node.nodeType !== 1) return;
      const name = String(node.tagName || '').toUpperCase();
      if (/^(BUTTON|SVG|SCRIPT|STYLE|TEMPLATE)$/.test(name) || node.getAttribute('role') === 'button' || invisible(node)) return;
      Array.from(node.childNodes || []).forEach(walk);
    };
    if (root) walk(root);
    return compact(text);
  }

  // Shared chat pages draw a code block as a box with its language in an element of its own,
  // apart from the code. Read the box as one fenced block, so the language labels the fence
  // (and a Mermaid diagram gets drawn) instead of standing alone as a paragraph.
  function labelledCodeBlock(node) {
    const pres = node.querySelectorAll?.('pre') || [];
    if (pres.length !== 1) return '';
    // A whole turn whose answer is only a code block looks the same from outside, since its
    // "ChatGPT said:" heading is hidden. Reading it here would lose who spoke.
    if (node.querySelector('[data-message-author-role], [data-message-role], [data-conversation-role], [data-turn-role], [data-turn-id-container], user-query, model-response, response-container')) return '';
    const label = plainText(node, pres[0]);
    const language = label.length <= 20 ? fenceLanguage(label) : '';
    if (!language) return '';
    const code = pres[0].querySelector('code');
    return codeFence((code || pres[0]).textContent, language);
  }

  function isCheckbox(node) {
    return node?.getAttribute?.('role') === 'checkbox'
      || (String(node?.tagName || '').toUpperCase() === 'INPUT' && String(node.getAttribute('type')).toLowerCase() === 'checkbox');
  }

  // A checkbox among an element's own children, bare or wrapped alone in one of them.
  function ownCheckbox(node) {
    for (const child of Array.from(node.children || [])) {
      if (isCheckbox(child)) return { box: child, holder: child };
      const only = child.children?.length === 1 ? child.children[0] : null;
      if (only && isCheckbox(only) && !compact(child.textContent)) return { box: only, holder: child };
    }
    return null;
  }

  function taskMarker(box) {
    const done = box.getAttribute('aria-checked') === 'true' || box.checked === true || box.hasAttribute('checked');
    return done ? '[x] ' : '[ ] ';
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
      // A to-do item keeps its box. Its continuation lines indent to the list marker only:
      // any further and Markdown would read them as code.
      const box = item.querySelector(':scope > input[type="checkbox"], :scope > [role="checkbox"], :scope > p > input[type="checkbox"], :scope > label > input[type="checkbox"]');
      const indent = '  '.repeat(depth);
      const lines = clean(main).split('\n');
      const first = lines.shift() || '';
      const continuation = lines.map((line) => `${indent}${' '.repeat(marker.length)}${line}`);
      return [`${indent}${marker}${box ? taskMarker(box) : ''}${first}`, ...continuation, ...nested.filter(Boolean)].join('\n');
    }).join('\n');
  }

  function table(node) {
    // A row's cells, though AI Studio wraps each one in an element of its own, and none
    // from a table nested inside a cell.
    const rows = Array.from(node.querySelectorAll('tr')).filter((row) => row.closest('table') === node).map((row) =>
      Array.from(row.querySelectorAll('th, td'))
        .filter((cell) => cell.closest('tr') === row)
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

    // ChatGPT's signed-in app renders code without <pre> or <code> around it, and marks
    // up what its own Copy button should do instead.
    const markdownCopy = node.getAttribute('data-markdown-copy');
    if (markdownCopy === 'exclude') return '';
    if (markdownCopy === 'inline-code') return inlineCode(node.textContent);
    if (markdownCopy === 'code-block') {
      const source = node.querySelector('[data-code-block-source], code');
      return codeFence((source || node).textContent, fenceLanguage(plainText(node.querySelector('[data-markdown-copy="exclude"]'))));
    }
    // Gemini names the language in a header above the <pre>, which has no class saying so.
    if (tag === 'CODE-BLOCK' && node.querySelector('pre')) {
      return codeFence(node.querySelector('pre').textContent, fenceLanguage(node.querySelector('.code-block-decoration > span')?.textContent));
    }
    // AI Studio does the same in a panel title.
    if (tag === 'MS-CODE-BLOCK' && node.querySelector('pre')) {
      return codeFence(node.querySelector('pre').textContent, fenceLanguage(node.querySelector('.title-text')?.textContent));
    }
    // AI Studio keeps a reply's thinking in the page even while it is folded away, and
    // labels each turn with its time. Neither is part of what was said.
    if (semanticCapture && (tag === 'MS-THOUGHT-CHUNK'
      || (node.classList?.contains('author-label') && node.querySelector?.('.timestamp')))) return '';
    if (semanticCapture && (tag === 'BUTTON' || node.getAttribute('role') === 'button')) {
      return meaningfulButton(node) ? children(node) : '';
    }

    if (semanticCapture && (/^(SVG|CANVAS|VIDEO|IFRAME|OBJECT|EMBED)$/.test(tag)
      || (node.getAttribute('role') === 'img' && !node.querySelector?.('img')))) {
      const marker = smartSelection ? node.getAttribute?.(selectionMarker) : '';
      const liveNode = marker
        ? document.querySelector(`[${selectionMarker}="${marker}"]`) || node
        : node;
      const source = liveNode.currentSrc || liveNode.getAttribute('poster') || liveNode.getAttribute('src') || liveNode.getAttribute('data') || '';
      return imageRegion(node, imageSource(source), visualLabel(liveNode)) || '';
    }
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|CANVAS|BUTTON|FORM|INPUT|SELECT|TEXTAREA|SOURCE)$/.test(tag)) return '';

    if (semanticCapture && (node.classList?.contains('katex') || node.classList?.contains('katex-display'))) {
      const tex = compact(node.querySelector('annotation[encoding="application/x-tex"]')?.textContent);
      if (tex) {
        const display = node.classList.contains('katex-display') || node.closest?.('.katex-display');
        return display ? block(`$$\n${tex}\n$$`) : `$${tex}$`;
      }
    }
    if (semanticCapture && /^(MATH|MROW|ANNOTATION|SEMANTICS)$/.test(tag)) return '';

    if (semanticCapture) {
      const speaker = messageLabel(node);
      if (speaker) {
        const value = clean(children(node));
        if (!value) return '';
        return block(`## ${speaker}\n\n${value}`);
      }
      // A to-do item drawn as a checkbox beside its words, as in ChatGPT's shopping lists.
      // Inside a real list, list() gives the item its box instead. A turn kept as a list
      // item is not one.
      const checkbox = ownCheckbox(node);
      const listItem = node.closest?.('li');
      if (checkbox && (!listItem || listItem.hasAttribute('data-message-role'))) {
        const words = clean(Array.from(node.childNodes || []).filter((child) => child !== checkbox.holder).map(render).join('\n'))
          .split(/\n+/).map(compact).filter(Boolean).join(' – ');
        if (words) return `- ${taskMarker(checkbox.box)}${words}\n`;
      }
      // ChatGPT lays out short facts side by side in a row, such as an item and its amount.
      // Keep them on one line rather than run them together or stack them.
      if (node.getAttribute('data-d-component') === 'row') {
        const parts = Array.from(node.children || []).map((child) => clean(render(child)));
        if (parts.length > 1 && parts.every((part) => !part.includes('\n') && part.length <= 120)) {
          return block(parts.filter(Boolean).join(' – '));
        }
      }
      if (tag === 'DIV' || tag === 'SECTION') {
        const fenced = labelledCodeBlock(node);
        if (fenced) return fenced;
      }
      // Turns kept as the items of a list are a conversation, not a numbered list.
      if ((tag === 'OL' || tag === 'UL') && Array.from(node.children || []).some((child) => child.hasAttribute?.('data-message-role'))) {
        return block(children(node));
      }
    }

    if (/^H[1-6]$/.test(tag)) {
      if (semanticCapture && /^(?:you|chatgpt) said:?$/i.test(compact(node.textContent))) return '';
      const heading = clean(children(node));
      return heading ? block(`${'#'.repeat(Number(tag[1]))} ${heading}`) : '';
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
      const language = ((codeEl?.className || '').match(/(?:language|lang)-([\w+-]+)/i) || [])[1] || '';
      return codeFence((codeEl || node).textContent, language);
    }
    if (tag === 'A') {
      const label = clean(children(node));
      const href = safeUrl(node.getAttribute('href'));
      if (!href) return label;
      return label ? `[${label}](<${href}>)` : `<${href}>`;
    }
    if (tag === 'IMG') {
      const alt = compact(node.getAttribute('alt'));
      const marker = smartSelection ? node.getAttribute?.(selectionMarker) : '';
      const liveNode = marker
        ? document.querySelector(`[${selectionMarker}="${marker}"]`) || node
        : node;
      const source = liveNode.currentSrc || liveNode.getAttribute('src') || liveNode.getAttribute('data-src');
      const src = semanticCapture ? imageSource(source) : safeUrl(source);
      if (semanticCapture) return src ? (imageRegion(node, src, alt) || '') : '';
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
    if (semanticCapture) {
      documentTitle = documentTitle
        .replace(/^(?:ChatGPT|Claude|Gemini|Microsoft Copilot|Google AI Studio)\s*[-|:]\s*/i, '')
        .replace(/\s*[-|:]\s*(?:ChatGPT|Claude|Gemini|Microsoft Copilot|Google AI Studio)$/i, '');
    }
    const genericHeading = /^(?:ChatGPT|Claude|Gemini|Microsoft Copilot|Google AI Studio)$/i.test(headingText);
    return compact((wholePage && genericHeading ? documentTitle : headingText) || documentTitle).slice(0, 300);
  }

  function pageRoot() {
    // When a chat's turns sit side by side in one container, read just that. It leaves out
    // what surrounds them, such as a shared copy's notice or the reminder that AI makes
    // mistakes. Two or more, so that a lone widget on some other page decides nothing.
    const turnBoxes = Array.from(document.querySelectorAll('[data-turn-id-container], [data-message-role]'))
      .filter((el) => !el.parentElement?.closest('[data-turn-id-container], [data-message-role]'));
    const holder = turnBoxes[0]?.parentElement;
    if (turnBoxes.length > 1 && turnBoxes.every((el) => el.parentElement === holder)) return holder;

    // A chat app's sidebar is not part of the conversation, but it can outweigh a short
    // one in the scoring below. The turns themselves say where the conversation is.
    const turn = document.querySelector('[data-message-author-role], [data-conversation-role], [data-testid="user-message"], user-query');
    const conversation = turn?.closest('main, [role="main"]');
    if (conversation) return conversation;

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

  // AI Studio keeps every turn in the page but fills in only those near the screen, so one
  // read finds one message. Bring each turn into view, read it once it has filled in and
  // stopped changing, then put the reader back where they were.
  async function captureStudioChat() {
    const turnWaitMs = 2000;
    const pollMs = 40;
    const turns = () => document.querySelectorAll('ms-chat-turn');
    const content = (turn) => turn.querySelector('.turn-content') || turn.querySelector('[data-turn-role]') || turn;
    const filled = (turn) => Array.from(content(turn).children).some((child) => !child.classList.contains('author-label'));
    const scroller = document.querySelector('ms-autoscroll-container');
    const startTop = scroller ? scroller.scrollTop : 0;
    const atBottom = scroller ? scroller.scrollHeight - scroller.clientHeight - startTop < 4 : false;
    const parts = [];
    let previous = '';
    try {
      const total = turns().length;
      for (let index = 0; index < total; index++) {
        const turn = turns()[index];
        if (!turn) break;
        turn.scrollIntoView?.({ block: 'start', behavior: 'instant' });
        let size = -1;
        for (let waited = 0; waited < turnWaitMs; waited += pollMs) {
          const now = filled(turn) ? content(turn).textContent.length : -1;
          if (now >= 0 && now === size) break;
          size = now;
          await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
        const role = turn.querySelector('[data-turn-role]')?.getAttribute('data-turn-role');
        const speaker = role === 'User' ? 'You' : role === 'Model' ? 'Gemini' : '';
        const value = clean(children(content(turn)));
        if (!value) continue;
        // A reply can span several turns, such as its thinking and then its answer.
        parts.push(speaker && speaker !== previous ? `## ${speaker}\n\n${value}` : value);
        if (speaker) previous = speaker;
      }
    } finally {
      if (scroller) {
        scroller.scrollTop = atBottom ? scroller.scrollHeight : startTop;
        // The last turns fill in again and grow, which leaves someone who was reading the
        // end of the chat above it. Take them to the end once more after that.
        if (atBottom) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          scroller.scrollTop = scroller.scrollHeight;
        }
      }
    }
    return { markdown: clean(parts.join('\n\n')), title: pageTitle(), images: pageImages };
  }

  if (studioChat) return captureStudioChat();

  if (wholePage) {
    const root = pageRoot();
    return { markdown: clean(render(root)), title: pageTitle(), images: pageImages };
  }

  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return smartSelection
      ? { markdown: '', title: pageTitle(), images: [] }
      : { markdown: '', title: pageTitle() };
  }
  const ranges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index));
  const marked = [];
  if (smartSelection) {
    const candidates = document.querySelectorAll('img, svg, canvas, video, iframe, object, embed, [role="img"]');
    let nextMarker = 0;
    for (const node of candidates) {
      let selected = false;
      for (const range of ranges) {
        try {
          if (range.intersectsNode(node)) { selected = true; break; }
        } catch { /* detached or inaccessible node */ }
      }
      if (!selected) continue;
      marked.push({ node, hadMarker: node.hasAttribute(selectionMarker), value: node.getAttribute(selectionMarker) });
      node.setAttribute(selectionMarker, String(nextMarker++));
    }
  }
  const parts = [];
  try {
    for (const range of ranges) {
      try {
        const holder = document.createElement('div');
        holder.append(range.cloneContents());
        const markdown = clean(children(holder));
        if (markdown) parts.push(markdown);
      } catch {
        // A frame/navigation race should fall back to contextMenus.selectionText.
      }
    }
  } finally {
    for (const { node, hadMarker, value } of marked) {
      if (hadMarker) node.setAttribute(selectionMarker, value);
      else node.removeAttribute(selectionMarker);
    }
  }
  const result = { markdown: parts.join('\n\n'), title: pageTitle() };
  return smartSelection ? { ...result, images: pageImages } : result;
}
