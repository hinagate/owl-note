// src/app/format-bar.js
// The editor's formatting row. Most controls are data-driven buttons; the
// Word-style Highlight, Change Case and Table controls add compact popovers.
// The host still owns the textarea and supplies apply(run), so every edit goes
// through its undo-preserving insertText path.
import {
  toggleInline, toggleHighlight, setHighlight, removeHighlight, changeCase,
  setTextColor, removeTextColor, setAlignment,
  cycleHeading, toggleLinePrefix, toggleOrderedList, insertLink, insertTable,
  insertSizedTable,
} from '../lib/format.js';

export const HIGHLIGHT_COLORS = [
  { id: 'yellow', name: 'Yellow', value: '#fff176' },
  { id: 'green', name: 'Green', value: '#a9dc76' },
  { id: 'cyan', name: 'Turquoise', value: '#78d9d2' },
  { id: 'blue', name: 'Blue', value: '#90caf9' },
  { id: 'pink', name: 'Pink', value: '#f3a6c8' },
  { id: 'orange', name: 'Orange', value: '#ffb66d' },
  { id: 'purple', name: 'Purple', value: '#c4a7e7' },
  { id: 'gray', name: 'Gray', value: '#cfd4dc' },
];

export const CHANGE_CASE_OPTIONS = [
  { id: 'sentence', label: 'Sentence case' },
  { id: 'lower', label: 'lowercase' },
  { id: 'upper', label: 'UPPERCASE' },
  { id: 'title', label: 'Capitalize Each Word' },
  { id: 'toggle', label: 'tOGGLE cASE' },
];

// Eight colors, so the grid fills the same 4 × 2 as the highlighter and the two
// palettes name the same hues. Only the two that cannot cross over differ:
// yellow is illegible as text, and red is too strong to read behind text.
// Every value clears 5:1 on white, which is what keeps them readable at body size.
export const TEXT_COLORS = [
  { id: 'red', name: 'Red', value: '#c0392b' },
  { id: 'orange', name: 'Orange', value: '#b45309' },
  { id: 'green', name: 'Green', value: '#177245' },
  { id: 'teal', name: 'Teal', value: '#0f766e' },
  { id: 'blue', name: 'Blue', value: '#2563b8' },
  { id: 'purple', name: 'Purple', value: '#7c3fad' },
  { id: 'pink', name: 'Pink', value: '#b02a7a' },
  { id: 'gray', name: 'Gray', value: '#5b6472' },
];

export function formatActions() {
  return [
    { id: 'bold', label: 'B', title: 'Bold (Ctrl+B)', shortcut: 'b', run: (b, s, e) => toggleInline(b, s, e, { left: '**', right: '**' }) },
    { id: 'italic', label: 'I', title: 'Italic (Ctrl+I)', shortcut: 'i', run: (b, s, e) => toggleInline(b, s, e, { left: '*', right: '*' }) },
    { id: 'underline', label: 'U', title: 'Underline (Ctrl+U)', shortcut: 'u', run: (b, s, e) => toggleInline(b, s, e, { left: '<u>', right: '</u>' }) },
    { id: 'strike', label: 'S', title: 'Strikethrough', run: (b, s, e) => toggleInline(b, s, e, { left: '~~', right: '~~' }) },
    { id: 'case', label: 'Aa', title: 'Change case', run: (b, s, e) => changeCase(b, s, e, 'sentence') },
    { id: 'font-color', label: 'A', title: 'Font color', run: (b, s, e) => setTextColor(b, s, e, 'red') },
    { id: 'highlight', label: '🖍', title: 'Highlight', run: (b, s, e) => toggleHighlight(b, s, e, 'yellow') },
    { divider: true },
    { id: 'heading', label: 'H', title: 'Heading — cycles # · ## · ###', run: (b, s) => cycleHeading(b, s) },
    { id: 'bullet-list', label: '•', title: 'Bullet list', run: (b, s, e) => toggleLinePrefix(b, s, e, 'bullet') },
    { id: 'ordered-list', label: '1.', title: 'Numbered list', run: (b, s, e) => toggleOrderedList(b, s, e) },
    { id: 'quote', label: '❝', title: 'Quote', run: (b, s, e) => toggleLinePrefix(b, s, e, 'quote') },
    { id: 'align-left', label: '≡', title: 'Align left', run: (b, s, e) => setAlignment(b, s, e, 'left') },
    { id: 'align-center', label: '≡', title: 'Align center', run: (b, s, e) => setAlignment(b, s, e, 'center') },
    { id: 'align-right', label: '≡', title: 'Align right', run: (b, s, e) => setAlignment(b, s, e, 'right') },
    { id: 'link', label: '🔗', title: 'Link (Ctrl+K)', shortcut: 'k', run: (b, s, e) => insertLink(b, s, e) },
    { id: 'table', label: '▦', title: 'Table — convert selected lines, add a column, or repair it', run: (b, s, e) => insertTable(b, s, e) },
  ];
}

function baseButton(className, label, title) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.title = title;
  button.setAttribute('aria-label', title);
  return button;
}

function bindImmediateAction(button, apply, run) {
  button.addEventListener('mousedown', (event) => {
    event.preventDefault();
    apply(run);
  });
  // Keyboard and assistive-tech button activation emits click with detail=0.
  // Pointer clicks were already handled on mousedown to retain the selection.
  button.addEventListener('click', (event) => { if (event.detail === 0) apply(run); });
}

export function renderFormatBar(container, { apply, actions = formatActions() }) {
  container.innerHTML = '';
  let activePopup = null;
  let tableDrag = null;
  let suppressTableClick = false;
  let suppressTableClickTimer = null;
  let insertSizeFromDrag = () => {};

  function closePopup({ restoreFocus = false } = {}) {
    if (!activePopup) return;
    const { menu, anchor } = activePopup;
    menu.hidden = true;
    anchor.setAttribute('aria-expanded', 'false');
    activePopup = null;
    tableDrag = null;
    if (restoreFocus) anchor.focus();
  }

  function positionPopup(menu, anchor) {
    const anchorBox = anchor.getBoundingClientRect();
    const menuBox = menu.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 768;
    const left = Math.max(8, Math.min(anchorBox.left, viewportWidth - menuBox.width - 8));
    const fitsBelow = anchorBox.bottom + 4 + menuBox.height <= viewportHeight - 8;
    const top = fitsBelow ? anchorBox.bottom + 4 : Math.max(8, anchorBox.top - menuBox.height - 4);
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  }

  function togglePopup(menu, anchor, { focusFirst = false } = {}) {
    if (activePopup?.menu === menu) { closePopup(); return; }
    closePopup();
    menu.hidden = false;
    anchor.setAttribute('aria-expanded', 'true');
    activePopup = { menu, anchor };
    positionPopup(menu, anchor);
    if (focusFirst) menu.querySelector('button:not([disabled])')?.focus();
  }

  function registerPopup(menu, anchor, popupType = 'menu') {
    menu.hidden = true;
    anchor.setAttribute('aria-haspopup', popupType);
    anchor.setAttribute('aria-expanded', 'false');
    anchor.addEventListener('mousedown', (event) => event.preventDefault()); // retain the textarea's selection
    anchor.addEventListener('click', () => togglePopup(menu, anchor));
    anchor.addEventListener('keydown', (event) => {
      if (!['Enter', ' ', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      togglePopup(menu, anchor, { focusFirst: true });
    });
  }

  function runFromMenu(run) {
    closePopup();
    apply(run);
  }

  function makeCaseControl(action) {
    const button = baseButton('format-btn format-case', action.label, action.title);
    const menu = document.createElement('div');
    menu.className = 'format-popup format-case-popup';
    menu.setAttribute('role', 'menu');
    for (const option of CHANGE_CASE_OPTIONS) {
      const item = baseButton('format-popup-item', option.label, option.label);
      item.setAttribute('role', 'menuitem');
      item.addEventListener('mousedown', (event) => event.preventDefault());
      item.addEventListener('click', () => {
        runFromMenu((body, start, end) => changeCase(body, start, end, option.id));
      });
      menu.appendChild(item);
    }
    registerPopup(menu, button);
    container.append(button, menu);
  }

  function makeHighlightControl(action) {
    const wrap = document.createElement('span');
    wrap.className = 'format-split format-highlight-split';
    const current = { ...HIGHLIGHT_COLORS[0] };
    const main = baseButton('format-btn format-highlight', action.label, `${action.title}: ${current.name}`);
    main.style.setProperty('--highlight-color', current.value);
    bindImmediateAction(main, apply, (body, start, end) => toggleHighlight(body, start, end, current.id));
    const arrow = baseButton('format-drop-toggle format-highlight-menu', '▾', 'Choose highlight color');
    const menu = document.createElement('div');
    menu.className = 'format-popup format-highlight-popup';
    menu.setAttribute('role', 'menu');
    const palette = document.createElement('div');
    palette.className = 'highlight-palette';
    palette.setAttribute('aria-label', 'Highlight colors');
    for (const color of HIGHLIGHT_COLORS) {
      const swatch = baseButton('highlight-swatch', '', color.name);
      swatch.style.setProperty('--swatch-color', color.value);
      swatch.dataset.color = color.id;
      swatch.setAttribute('role', 'menuitem');
      swatch.addEventListener('mousedown', (event) => event.preventDefault());
      swatch.addEventListener('click', () => {
        Object.assign(current, color);
        main.style.setProperty('--highlight-color', current.value);
        main.title = `${action.title}: ${current.name}`;
        main.setAttribute('aria-label', main.title);
        runFromMenu((body, start, end) => setHighlight(body, start, end, current.id));
      });
      palette.appendChild(swatch);
    }
    const remove = baseButton('format-popup-item remove-highlight', 'No color', 'Remove highlight');
    remove.setAttribute('role', 'menuitem');
    remove.addEventListener('mousedown', (event) => event.preventDefault());
    remove.addEventListener('click', () => runFromMenu(removeHighlight));
    menu.append(palette, remove);
    registerPopup(menu, arrow);
    wrap.append(main, arrow, menu);
    container.appendChild(wrap);
  }

  function makeFontColorControl(action) {
    const wrap = document.createElement('span');
    wrap.className = 'format-split format-font-color-split';
    const current = { ...TEXT_COLORS[0] };
    const main = baseButton('format-btn format-font-color', action.label, `${action.title}: ${current.name}`);
    main.style.setProperty('--font-color', current.value);
    bindImmediateAction(main, apply, (body, start, end) => setTextColor(body, start, end, current.id));
    const arrow = baseButton('format-drop-toggle format-font-color-menu', '▾', 'Choose font color');
    const menu = document.createElement('div');
    menu.className = 'format-popup format-font-color-popup';
    menu.setAttribute('role', 'menu');
    const palette = document.createElement('div');
    palette.className = 'font-color-palette';
    palette.setAttribute('aria-label', 'Font colors');
    for (const color of TEXT_COLORS) {
      const swatch = baseButton('font-color-swatch', 'A', color.name);
      swatch.style.setProperty('--swatch-color', color.value);
      swatch.dataset.color = color.id;
      swatch.setAttribute('role', 'menuitem');
      swatch.addEventListener('mousedown', (event) => event.preventDefault());
      swatch.addEventListener('click', () => {
        Object.assign(current, color);
        main.style.setProperty('--font-color', current.value);
        main.title = `${action.title}: ${current.name}`;
        main.setAttribute('aria-label', main.title);
        runFromMenu((body, start, end) => setTextColor(body, start, end, current.id));
      });
      palette.appendChild(swatch);
    }
    const automatic = baseButton('format-popup-item automatic-font-color', 'Automatic', 'Use automatic text color');
    automatic.setAttribute('role', 'menuitem');
    automatic.addEventListener('mousedown', (event) => event.preventDefault());
    automatic.addEventListener('click', () => runFromMenu(removeTextColor));
    menu.append(palette, automatic);
    registerPopup(menu, arrow);
    wrap.append(main, arrow, menu);
    container.appendChild(wrap);
  }

  function makeTableControl(action) {
    const wrap = document.createElement('span');
    wrap.className = 'format-split format-table-split';
    const main = baseButton('format-btn format-table', action.label, action.title);
    bindImmediateAction(main, apply, action.run);
    const arrow = baseButton('format-drop-toggle format-table-menu', '▾', 'Choose table size');
    const menu = document.createElement('div');
    menu.className = 'format-popup format-table-popup';
    menu.setAttribute('role', 'dialog');
    menu.setAttribute('aria-label', 'Insert table');
    const label = document.createElement('strong');
    label.className = 'table-grid-label';
    label.textContent = '1 × 1 Table';
    const grid = document.createElement('div');
    grid.className = 'table-size-grid';
    grid.setAttribute('role', 'grid');
    grid.setAttribute('aria-label', 'Table size');
    const cells = [];
    const GRID_COLUMNS = 10;
    const GRID_ROWS = 8;

    function selectSize(columns, rows) {
      label.textContent = `${columns} × ${rows} Table`;
      for (const cell of cells) {
        const selected = Number(cell.dataset.column) <= columns && Number(cell.dataset.row) <= rows;
        cell.classList.toggle('selected', selected);
        cell.setAttribute('aria-selected', String(selected));
      }
    }

    function insertSize(columns, rows) {
      runFromMenu((body, start, end) => insertSizedTable(body, start, end, columns, rows));
    }
    insertSizeFromDrag = insertSize;

    for (let row = 1; row <= GRID_ROWS; row += 1) {
      for (let column = 1; column <= GRID_COLUMNS; column += 1) {
        const cell = baseButton('table-size-cell', '', `${column} columns by ${row} rows`);
        cell.dataset.column = String(column);
        cell.dataset.row = String(row);
        cell.setAttribute('role', 'gridcell');
        cell.tabIndex = row === 1 && column === 1 ? 0 : -1;
        cell.addEventListener('mousedown', (event) => event.preventDefault());
        cell.addEventListener('pointerdown', () => {
          tableDrag = { startColumn: column, startRow: row, column, row };
          selectSize(column, row);
        });
        cell.addEventListener('pointerover', () => {
          selectSize(column, row);
          if (tableDrag) { tableDrag.column = column; tableDrag.row = row; }
        });
        cell.addEventListener('focus', () => selectSize(column, row));
        cell.addEventListener('click', () => {
          if (suppressTableClick) { suppressTableClick = false; return; }
          insertSize(column, row);
        });
        cell.addEventListener('keydown', (event) => {
          const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
          const move = moves[event.key];
          if (!move) return;
          event.preventDefault();
          const nextColumn = Math.max(1, Math.min(GRID_COLUMNS, column + move[0]));
          const nextRow = Math.max(1, Math.min(GRID_ROWS, row + move[1]));
          const next = cells[(nextRow - 1) * GRID_COLUMNS + nextColumn - 1];
          for (const item of cells) item.tabIndex = item === next ? 0 : -1;
          next.focus();
        });
        cells.push(cell);
        grid.appendChild(cell);
      }
    }
    selectSize(1, 1);
    const shortcutHint = document.createElement('p');
    shortcutHint.className = 'table-shortcut-hint';
    shortcutHint.append(
      document.createTextNode('Tip: '),
      Object.assign(document.createElement('kbd'), { textContent: 'Alt' }),
      document.createTextNode(' + '),
      Object.assign(document.createElement('kbd'), { textContent: 'Enter' }),
      document.createTextNode(' wraps to a new line inside a cell.'),
    );
    menu.append(label, grid, shortcutHint);
    registerPopup(menu, arrow, 'dialog');
    wrap.append(main, arrow, menu);
    container.appendChild(wrap);
  }

  for (const action of actions) {
    if (action.divider) {
      const divider = document.createElement('span');
      divider.className = 'format-divider';
      container.appendChild(divider);
      continue;
    }
    if (action.id === 'case') { makeCaseControl(action); continue; }
    if (action.id === 'font-color') { makeFontColorControl(action); continue; }
    if (action.id === 'highlight') { makeHighlightControl(action); continue; }
    if (action.id === 'table') { makeTableControl(action); continue; }

    const button = baseButton(`format-btn format-${action.id}`, action.label, action.title);
    // Pointer activation runs on mousedown so the textarea keeps focus and its
    // selection; bindImmediateAction also covers keyboard/AT activation.
    bindImmediateAction(button, apply, action.run);
    container.appendChild(button);
  }

  const onDocumentMouseDown = (event) => {
    if (!activePopup) return;
    if (activePopup.menu.contains(event.target) || activePopup.anchor.contains(event.target)) return;
    closePopup();
  };
  const onDocumentPointerUp = () => {
    if (!tableDrag) return;
    const { startColumn, startRow, column, row } = tableDrag;
    tableDrag = null;
    if (column !== startColumn || row !== startRow) {
      // A browser emits click immediately after pointerup. The drag already
      // inserted the table, so consume that synthetic follow-up once.
      suppressTableClick = true;
      clearTimeout(suppressTableClickTimer);
      suppressTableClickTimer = setTimeout(() => { suppressTableClick = false; }, 0);
      insertSizeFromDrag(column, row);
    }
  };
  const onDocumentKeyDown = (event) => {
    if (event.key !== 'Escape' || !activePopup) return;
    event.preventDefault();
    closePopup({ restoreFocus: true });
  };
  document.addEventListener('mousedown', onDocumentMouseDown);
  document.addEventListener('pointerup', onDocumentPointerUp);
  document.addEventListener('keydown', onDocumentKeyDown);

  return () => {
    closePopup();
    document.removeEventListener('mousedown', onDocumentMouseDown);
    document.removeEventListener('pointerup', onDocumentPointerUp);
    document.removeEventListener('keydown', onDocumentKeyDown);
    clearTimeout(suppressTableClickTimer);
  };
}
