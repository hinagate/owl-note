import { describe, it, expect } from 'vitest';
import { tidyMarkdown } from '../src/lib/tidy-markdown.js';

describe('tidyMarkdown - adjacent OWL image references', () => {
  const first = '![AI Policy Quiz | Coursera](owl-img:3d2dc6ce630e3)';
  const second = '![capture one.png](owl-img:137f3bc27e261)';
  const third = '![capture two.png](owl-img:18941884c7a4d9)';
  const fourth = '![capture three.png](owl-img:1c88b616ba061a)';

  it('puts a pasted run of short image links into separate paragraphs', () => {
    const body = `${first}\n\n${second}${third}${fourth}`;
    expect(tidyMarkdown(body)).toBe(`${first}\n\n${second}\n\n${third}\n\n${fourth}\n`);
  });

  it('also normalizes horizontal whitespace between otherwise adjacent refs', () => {
    expect(tidyMarkdown(`${second}  \t ${third}`)).toBe(`${second}\n\n${third}\n`);
  });

  it('leaves a single image, mixed prose, and fenced examples untouched', () => {
    expect(tidyMarkdown(second)).toBe(second + '\n');
    expect(tidyMarkdown(`Before ${second}${third}`)).toBe(`Before ${second}${third}\n`);
    expect(tidyMarkdown(`\`\`\`md\n${second}${third}\n\`\`\``)).toBe(`\`\`\`md\n${second}${third}\n\`\`\`\n`);
  });

  it('is idempotent after separating the images', () => {
    const once = tidyMarkdown(`${second}${third}${fourth}`);
    expect(tidyMarkdown(once)).toBe(once);
  });
});

// Deterministic, rule-based markdown tidy (replaces the AI Format action, which
// truncated mid-JSON and rewrote content). Every rule below is content-preserving
// BY CONSTRUCTION — these tests pin each rule, prove fence content is byte-untouched,
// prove idempotence on a gnarly all-rules fixture, and prove CJK bodies only change
// structurally.

describe('tidyMarkdown — rule 1: line endings', () => {
  it('normalizes CRLF and lone CR to LF', () => {
    expect(tidyMarkdown('a\r\nb\rc')).toBe('a\nb\nc\n');
  });
});

describe('tidyMarkdown — rule 2: trailing whitespace (soft-break aware)', () => {
  it('strips a single trailing space', () => {
    expect(tidyMarkdown('hello \nworld')).toBe('hello\nworld\n');
  });
  it('preserves an exactly-two-space soft break', () => {
    expect(tidyMarkdown('hello  \nworld')).toBe('hello  \nworld\n');
  });
  it('normalizes 3+ trailing spaces down to a two-space soft break', () => {
    expect(tidyMarkdown('hello     \nworld')).toBe('hello  \nworld\n');
  });
  it('strips trailing tabs (a tab is not a soft break)', () => {
    expect(tidyMarkdown('hello\t\nworld')).toBe('hello\nworld\n');
    expect(tidyMarkdown('hello \t\nworld')).toBe('hello\nworld\n');
  });
});

describe('tidyMarkdown — rule 3: collapse blank-line runs', () => {
  it('collapses 3+ consecutive blank lines to one', () => {
    expect(tidyMarkdown('a\n\n\n\n\nb')).toBe('a\n\nb\n');
  });
  it('leaves a single or double blank run untouched', () => {
    expect(tidyMarkdown('a\n\nb')).toBe('a\n\nb\n');
    expect(tidyMarkdown('a\n\n\nb')).toBe('a\n\n\nb\n');
  });
});

describe('tidyMarkdown — rule 4: headings', () => {
  // [E11-review fix] `#Word` is deliberately NOT "fixed" into a heading: the same
  // shape is a hashtag line, a shebang, or `#1 issue` — inserting a space would
  // corrupt real note content into headings. Only already-spaced headings count.
  it('leaves unspaced #Word lines alone (hashtags/shebangs are not headings)', () => {
    expect(tidyMarkdown('#Title')).toBe('#Title\n');
    expect(tidyMarkdown('###Sub')).toBe('###Sub\n');
    expect(tidyMarkdown('#tag #another')).toBe('#tag #another\n');
    expect(tidyMarkdown('#!/bin/bash')).toBe('#!/bin/bash\n');
    expect(tidyMarkdown('#1 issue')).toBe('#1 issue\n');
    // ...and no blank lines are forced around them (they are not headings).
    expect(tidyMarkdown('text\n#tag #b\nmore')).toBe('text\n#tag #b\nmore\n');
  });
  it('does NOT treat 7+ hashes as a heading (no space inserted)', () => {
    expect(tidyMarkdown('#######notaheading')).toBe('#######notaheading\n');
  });
  it('ensures one blank line before and after a heading (not at document start)', () => {
    expect(tidyMarkdown('text\n# Heading\nmore')).toBe('text\n\n# Heading\n\nmore\n');
  });
  it('adds no leading blank for a heading at document start', () => {
    expect(tidyMarkdown('# Heading\ntext')).toBe('# Heading\n\ntext\n');
  });
  it('puts exactly one blank between consecutive headings', () => {
    expect(tidyMarkdown('# A\n## B')).toBe('# A\n\n## B\n');
  });
});

describe('tidyMarkdown — rule 5: blank line before a list block', () => {
  it('inserts a blank before the first item when the previous line is prose', () => {
    expect(tidyMarkdown('Intro line\n- one\n- two')).toBe('Intro line\n\n- one\n- two\n');
  });
  it('keeps list items contiguous (no blank between items)', () => {
    expect(tidyMarkdown('- one\n- two\n- three')).toBe('- one\n- two\n- three\n');
  });
  it('works for ordered lists too', () => {
    expect(tidyMarkdown('Intro\n1. one\n2) two')).toBe('Intro\n\n1. one\n2) two\n');
  });
  it('does not add a leading blank for a list at document start', () => {
    expect(tidyMarkdown('- a\n- b')).toBe('- a\n- b\n');
  });
  it('does not touch an already-spaced list', () => {
    expect(tidyMarkdown('Intro\n\n- one')).toBe('Intro\n\n- one\n');
  });
});

describe('tidyMarkdown — rule 6: unicode bullets → "- "', () => {
  it('converts common unicode bullets to a hyphen marker', () => {
    expect(tidyMarkdown('• Milk\n● Eggs\n▪ Bread\n‣ Ham\n◦ Salt\n・ Rice'))
      .toBe('- Milk\n- Eggs\n- Bread\n- Ham\n- Salt\n- Rice\n');
  });
  it('preserves leading whitespace, including a fullwidth space', () => {
    expect(tidyMarkdown('  • Nested')).toBe('  - Nested\n');
    expect(tidyMarkdown('　• Item')).toBe('　- Item\n');
  });
  it('adds the missing space when the bullet hugs the text', () => {
    expect(tidyMarkdown('•Milk')).toBe('- Milk\n');
  });
  it('does NOT convert * or + ASCII bullets to -', () => {
    expect(tidyMarkdown('* one\n* two')).toBe('* one\n* two\n');
    expect(tidyMarkdown('+ one\n+ two')).toBe('+ one\n+ two\n');
  });
});

describe('tidyMarkdown — rule 7: single trailing newline', () => {
  it('adds exactly one trailing newline', () => {
    expect(tidyMarkdown('hello')).toBe('hello\n');
  });
  it('collapses many trailing newlines to one', () => {
    expect(tidyMarkdown('hello\n\n\n')).toBe('hello\n');
  });
});

describe('tidyMarkdown — empty / whitespace bodies', () => {
  it('returns empty string for empty or nullish input', () => {
    expect(tidyMarkdown('')).toBe('');
    expect(tidyMarkdown(null)).toBe('');
    expect(tidyMarkdown(undefined)).toBe('');
  });
  it('returns empty string for a whitespace-only body', () => {
    expect(tidyMarkdown('   ')).toBe('');
    expect(tidyMarkdown('\n\n\n')).toBe('');
    expect(tidyMarkdown('  \n \t\n  ')).toBe('');
  });
});

describe('tidyMarkdown — already-tidy input is returned identical', () => {
  it('is a no-op on a clean document', () => {
    const clean = '# Title\n\nA paragraph.\n\n- item one\n- item two\n';
    expect(tidyMarkdown(clean)).toBe(clean);
  });
});

describe('tidyMarkdown — fenced code blocks are byte-untouched', () => {
  it('preserves blank lines and trailing spaces INSIDE a closed fence', () => {
    const fence = '```js\ncode   \n\n\n\nmore()   \n```';
    const body = `text\n${fence}\nafter`;
    const out = tidyMarkdown(body);
    // The whole fenced block survives verbatim (no ws strip, no blank collapse).
    // No blank lines are inserted around a fence — there is no such rule.
    expect(out).toContain(fence);
    expect(out).toBe(`text\n${fence}\nafter\n`);
  });

  it('does not treat a "# comment" inside a fence as a heading', () => {
    const body = '```sh\n#not a heading\necho hi\n```\ntail';
    const out = tidyMarkdown(body);
    expect(out).toContain('#not a heading'); // no space inserted inside the fence
    expect(out).toBe('```sh\n#not a heading\necho hi\n```\ntail\n');
  });

  it('leaves everything after an UNCLOSED fence untouched (only a final newline is ensured)', () => {
    const body = 'text\n```\nweird   content\n\n\nmore()   ';
    const out = tidyMarkdown(body);
    // Everything from the opening fence to EOF is preserved byte-for-byte.
    expect(out).toBe('text\n```\nweird   content\n\n\nmore()   \n');
    expect(out.slice(out.indexOf('```'))).toBe('```\nweird   content\n\n\nmore()   \n');
  });
});

describe('tidyMarkdown — idempotence on a gnarly all-rules fixture', () => {
  const gnarly = [
    '#Heading one   ', // needs a space + trailing ws + blanks after
    'A paragraph with a soft break  ', // 2-space soft break preserved
    'trailing single space ', // stripped
    '',
    '',
    '',
    '',
    'text before a list',
    '• bullet one',
    '● bullet two',
    'text before a heading',
    '##Another heading',
    'body\r', // stray CR
    '',
    '',
    '```',
    'code   with   trailing   ',
    '',
    '',
    '',
    'kept as-is()',
    '```',
    'tail',
    '',
    '├─ box tree node one', // [E13] rule 8 auto-fences this box-drawing block...
    '└─ box tree node two', // ...and the wrap must remain idempotent on re-tidy
  ].join('\n');

  it('tidy(tidy(x)) === tidy(x)', () => {
    const once = tidyMarkdown(gnarly);
    const twice = tidyMarkdown(once);
    expect(twice).toBe(once);
  });

  it('the fenced block still survives verbatim in the tidied output', () => {
    const out = tidyMarkdown(gnarly);
    expect(out).toContain('```\ncode   with   trailing   \n\n\n\nkept as-is()\n```');
  });
});

describe('tidyMarkdown — CJK safety (structure only, word content untouched)', () => {
  it('fixes heading spacing and bullets in a Chinese note without altering words', () => {
    const body = '# 购物清单\n买牛奶和鸡蛋\n•鸡蛋\n•面包';
    const out = tidyMarkdown(body);
    expect(out).toBe('# 购物清单\n\n买牛奶和鸡蛋\n\n- 鸡蛋\n- 面包\n');
    // Every CJK word is present and unchanged — only markers/whitespace moved.
    for (const word of ['购物清单', '买牛奶和鸡蛋', '鸡蛋', '面包']) {
      expect(out).toContain(word);
    }
    // [E11-review fix] An UNSPACED `#购物清单` could equally be a Chinese hashtag —
    // it is left exactly as written (no space insertion, no forced blank lines).
    expect(tidyMarkdown('#购物清单\n买牛奶')).toBe('#购物清单\n买牛奶\n');
  });

  it('does not insert spaces between CJK characters or reflow the text', () => {
    const body = '这是一个很长的中文段落没有任何空格需要保留原样。';
    expect(tidyMarkdown(body)).toBe(body + '\n');
  });
});

describe('tidyMarkdown — rule 8: auto-fence box-drawing (ASCII-tree) blocks', () => {
  // WHY this rule exists: Markdown collapses single newlines inside a paragraph, so a
  // Unicode box-drawing tree (│ ├─ └─ …) that renders beautifully in the editor flows
  // into ONE wrapped run in the preview — alignment destroyed. The only faithful
  // Markdown treatment for line-art is a fenced code block. Rule 8 detects such blocks
  // and wraps them in ``` so the preview keeps every line break + monospace alignment.

  // The user's REAL note (CJK verbatim) — the primary fixture. Interior bytes must come
  // out byte-exact; only two ``` fence lines are added around the whole tree.
  const tree = [
    '可同箱組合',
    '│',
    '├─ ★【寢具 + 衣物】 同臥室、都是 Day-1、又輕又軟',
    '│   ├─ 床單被套枕套 + 睡衣 / 換洗衣物',
    '│   └─ 棉被當緩衝包在外圈,內衣襪子塞空隙',
    '│      → 大箱最適合這組,裝滿也不會超重',
    '│',
    '├─ ★【盥洗 + 毛巾】 同浴室、都是 Day-1',
    '│   └─ ⚠ 洗髮沐浴等液體先密封進夾鏈袋,放角落直立',
  ].join('\n');

  it('wraps the whole CJK tree (header + interior) in one ``` pair, interior byte-exact', () => {
    const out = tidyMarkdown(tree);
    // The header line 可同箱組合 and the interior are swallowed into a single fence.
    expect(out).toBe('```\n' + tree + '\n```\n');
    // Interior appears verbatim — not one byte of line-art or CJK changed.
    expect(out).toContain(tree);
  });

  it('leaves the CJK bytes inside the tree unchanged', () => {
    const out = tidyMarkdown(tree);
    for (const word of ['可同箱組合', '寢具', '盥洗', '洗髮沐浴等液體先密封進夾鏈袋', '大箱最適合這組']) {
      expect(out).toContain(word);
    }
  });

  it('is idempotent on the CJK tree (fenced block is protected on the next run)', () => {
    const once = tidyMarkdown(tree);
    expect(tidyMarkdown(once)).toBe(once);
  });

  it('fences a block drawn with double-line / corner box chars (full char class)', () => {
    const boxbox = '╔═══╗\n║ x ║\n╚═══╝';
    expect(tidyMarkdown(boxbox)).toBe('```\n╔═══╗\n║ x ║\n╚═══╝\n```\n');
  });

  it('does NOT fence a Markdown table — ASCII `|` and `---` are never box chars', () => {
    const table = '| a | b |\n| --- | --- |\n| 1 | 2 |';
    expect(tidyMarkdown(table)).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |\n');
  });

  it('does NOT fence ASCII box-art or a `---` rule (only Unicode box chars match)', () => {
    // `+`, `|`, `-` are ASCII (U+002B/007C/002D) — outside the box-drawing set.
    expect(tidyMarkdown('+---+\n| a |\n+---+')).toBe('+---+\n| a |\n+---+\n');
    expect(tidyMarkdown('text\n---\nmore')).toBe('text\n---\nmore\n');
  });

  it('does NOT fence a prose paragraph with a lone decorative ───── divider (<2 box lines)', () => {
    const prose = 'Some intro prose.\n─────\nMore prose here.';
    expect(tidyMarkdown(prose)).toBe('Some intro prose.\n─────\nMore prose here.\n');
  });

  it('does NOT fence a mostly-prose block that has a couple of box lines (<50%)', () => {
    // 5-line block, 2 box lines → fails the ≥50% rule, so it stays unfenced.
    const mixed = 'header one\nheader two\nheader three\n├─ a\n└─ b';
    expect(tidyMarkdown(mixed)).toBe('header one\nheader two\nheader three\n├─ a\n└─ b\n');
  });

  it('fences only the qualifying block when prose and a tree are separate blocks', () => {
    const doc = 'Prose line one\nProse line two\nProse line three\n\n├─ branch a\n└─ branch b';
    expect(tidyMarkdown(doc)).toBe(
      'Prose line one\nProse line two\nProse line three\n\n```\n├─ branch a\n└─ branch b\n```\n',
    );
  });

  it('does not re-fence a tree that is already inside a fence', () => {
    const already = '```\n├─ a\n└─ b\n```';
    expect(tidyMarkdown(already)).toBe('```\n├─ a\n└─ b\n```\n');
  });

  it('does not treat a ├─ tree line as a list item (no rule-5 blank inserted)', () => {
    // LIST_ITEM_RE requires -,*,+, or a digit marker; ├ is none of them. A lone
    // 1-box-line block is not fenced, so we can observe it is NOT list-spaced.
    expect(tidyMarkdown('Intro\n├─ x')).toBe('Intro\n├─ x\n');
  });

  it('handles a mixed doc: heading + prose + tree + list all behave correctly', () => {
    const doc = '# Title\n\nSome prose paragraph.\n\n├─ node a\n└─ node b\n\n- item one\n- item two';
    expect(tidyMarkdown(doc)).toBe(
      '# Title\n\nSome prose paragraph.\n\n```\n├─ node a\n└─ node b\n```\n\n- item one\n- item two\n',
    );
  });

  // [E13-review fix] Real markdown syntax adjacent to a tree (no blank line between)
  // must act as a BLOCK BOUNDARY: swallowing a heading/list/table row into the fence
  // renders it as inert <pre> text — previously-correct structure destroyed, and the
  // damage is idempotent so it never self-heals. Plain-text labels (可同箱組合) carry
  // no markdown syntax and stay swallowed — that behavior is sanctioned above.
  it('keeps an adjacent heading OUTSIDE the fence (markdown syntax bounds the block)', () => {
    const out = tidyMarkdown('## Packing\n├─ a\n└─ b');
    // Heading survives as a heading (rule 4b spaces it); fence wraps ONLY the tree.
    expect(out).toBe('## Packing\n\n```\n├─ a\n└─ b\n```\n');
    expect(tidyMarkdown(out)).toBe(out); // idempotent
  });

  it('keeps an adjacent list item after the tree OUTSIDE the fence', () => {
    const out = tidyMarkdown('├─ a\n└─ b\n- item');
    // The list line stays a list (rule 5 gives it its blank after the fence).
    expect(out).toBe('```\n├─ a\n└─ b\n```\n\n- item\n');
    expect(tidyMarkdown(out)).toBe(out); // idempotent
  });

  it('keeps an adjacent table row after the tree OUTSIDE the fence', () => {
    const out = tidyMarkdown('├─ a\n└─ b\n| a | b |');
    expect(out).toBe('```\n├─ a\n└─ b\n```\n| a | b |\n');
    expect(tidyMarkdown(out)).toBe(out); // idempotent
  });

  // [E13-review fix] A PURE DIVIDER line (only ─/═ plus whitespace) is decoration, not
  // tree evidence: trees are characterized by CONNECTORS (│ ├ └ …). Dividers framing
  // prose must never drag the prose into a code fence.
  it('does NOT fence divider-prose-divider (pure ─/═ lines are not tree evidence)', () => {
    const out = tidyMarkdown('──────\nSome prose.\n──────');
    expect(out).toBe('──────\nSome prose.\n──────\n');
    expect(tidyMarkdown(out)).toBe(out); // idempotent
    // Double-line ═ dividers behave the same.
    expect(tidyMarkdown('══════\nprose\n══════')).toBe('══════\nprose\n══════\n');
  });

  it('still fences a connector tree with an interior ────── divider (one fence, divider included)', () => {
    const out = tidyMarkdown('├─ a\n──────\n└─ b');
    expect(out).toBe('```\n├─ a\n──────\n└─ b\n```\n');
    expect(tidyMarkdown(out)).toBe(out); // idempotent
  });
});
