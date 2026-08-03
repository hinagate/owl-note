// The segmenter is where the three languages actually differ, so this is where the
// interesting cases live: dictionary-driven CJK boundaries, okurigana that must stay bare,
// per-character pinyin, and mixed-script text.
import { describe, it, expect } from 'vitest';
import { parseTable } from '../src/lib/phonetics.js';
import {
  makeSegmenter, detectHanScript, scriptForBlock, hasHan, hasLatin,
} from '../src/lib/segment.js';

const IPA = parseTable("phonics\tˈfɑnɪks\nis\tɪz\nuseful\tˈjusfəl\n");
// Values hold only the kanji core; the key keeps its okurigana so 新しい stays distinct
// from 新, exactly as scripts/build-kana-dict.mjs writes them.
const KANA = parseTable([
  '日本\tにほん', '日本語\tにほんご', '私\tわたし', '食べる\tた', '新しい\tあたら',
  '新\tしん', '本\tほん', '読む\tよ', 'お茶\tちゃ', '山\tやま',
].join('\n'));
const PINYIN = parseTable([
  '银\tyín', '行\txíng', '走\tzǒu', '中\tzhōng', '国\tguó',
  '银行\tyín háng', '中国银行\tzhōng guó yín háng',
].join('\n'));

const ja = makeSegmenter({ ipa: IPA, kana: KANA, script: 'ja' });
const zh = makeSegmenter({ ipa: IPA, pinyin: PINYIN, script: 'zh' });

/** Every segmenter run must rebuild its input exactly — the annotator depends on it. */
const rebuilds = (segment, text) => segment(text).map((r) => r.text).join('') === text;
const annotated = (segment, text) => segment(text).filter((r) => r.reading)
  .map((r) => `${r.text}=${r.reading}`);

describe('detectHanScript', () => {
  it('reads Han as Japanese when any kana keeps it company', () => {
    expect(detectHanScript('日本語を勉強する')).toBe('ja');
    expect(detectHanScript('コンピュータ')).toBe('ja');
  });

  it('reads bare Han as Chinese', () => {
    expect(detectHanScript('中国银行')).toBe('zh');
    expect(detectHanScript('')).toBe('zh');
  });
});

describe('scriptForBlock', () => {
  // Coverage is measured against the real shape of the kana table: entries are words, and
  // most kanji have no single-character row, so 世界 is known but 世 alone is not.
  const table = parseTable([
    '世界\tせかい', '言語\tげんご', '概要\tがいよう', '東京\tとうきょう', '学\tがく',
    '新\tしん', '言\tげん', '大\tだい', '会\tかい',
  ].join('\n'));

  it('calls any block with kana Japanese, whatever the note is', () => {
    expect(scriptForBlock('新しい言語', table, 'zh')).toBe('ja');
  });

  it('keeps a kanji-only block Japanese when the note is Japanese', () => {
    // The regression this guards: 概 has no single-character row, so a per-character test
    // would rate 概要 as foreign and read it as Chinese.
    expect(scriptForBlock('概要', table, 'ja')).toBe('ja');
    expect(scriptForBlock('東京世界概要', table, 'ja')).toBe('ja');
  });

  it('flips a block the Japanese dictionary cannot account for to Chinese', () => {
    // 习 门 语 让 你 的 are simplified forms absent from a Japanese word list.
    expect(scriptForBlock('学习一门新语言', table, 'ja')).toBe('zh');
    expect(scriptForBlock('会让你看到更大的世界', table, 'ja')).toBe('zh');
  });

  it('will not overrule the note on too little evidence', () => {
    expect(scriptForBlock('习', table, 'ja')).toBe('ja'); // one stray character proves nothing
  });

  it('never drags a Chinese note towards Japanese', () => {
    expect(scriptForBlock('世界概要東京', table, 'zh')).toBe('zh');
  });

  it('falls back to the note when the kana table has not loaded', () => {
    expect(scriptForBlock('学习一门新语言', null, 'ja')).toBe('ja');
  });
});

describe('hasHan / hasLatin', () => {
  it('reports which tables a note would actually need', () => {
    expect(hasHan('hello 日本')).toBe(true);
    expect(hasHan('hello')).toBe(false);
    expect(hasLatin('hello 日本')).toBe(true);
    expect(hasLatin('日本')).toBe(false);
    expect(hasLatin('ひらがな')).toBe(false);
  });
});

describe('Japanese segmentation', () => {
  it('takes the longest surface the table knows, not the first character', () => {
    expect(annotated(ja, '日本語')).toEqual(['日本語=にほんご']);
    expect(annotated(ja, '日本')).toEqual(['日本=にほん']);
  });

  it('leaves okurigana bare so the reading sits only over the kanji', () => {
    expect(annotated(ja, '食べる')).toEqual(['食=た']);
    expect(rebuilds(ja, '食べる')).toBe(true);
  });

  it('keeps a conjugation readable by matching the dictionary form inside it', () => {
    // 食べました is not an entry; 食べる is, and its 食 prefix still lands correctly.
    expect(annotated(ja, '本を読む')).toEqual(['本=ほん', '読=よ']);
    expect(rebuilds(ja, '本を読む')).toBe(true);
  });

  it('does not confuse 新しい with 新', () => {
    expect(annotated(ja, '新しい')).toEqual(['新=あたら']);
    expect(annotated(ja, '新')).toEqual(['新=しん']);
  });

  it('leaves a leading kana of the surface outside the ruby', () => {
    const runs = ja('お茶');
    expect(runs.map((r) => r.text)).toEqual(['お', '茶']);
    expect(runs[0].reading).toBe(null);
    expect(runs[1].reading).toBe('ちゃ');
  });

  it('tags its runs as Japanese so the stylesheet and screen readers know', () => {
    expect(ja('日本').find((r) => r.reading).lang).toBe('ja');
  });

  it('passes unknown kanji through untouched rather than guessing', () => {
    expect(annotated(ja, '鬱蒼')).toEqual([]);
    expect(rebuilds(ja, '鬱蒼')).toBe(true);
  });

  it('rebuilds mixed Japanese and punctuation exactly', () => {
    const text = '私は、日本語を読む。';
    expect(rebuilds(ja, text)).toBe(true);
    expect(annotated(ja, text)).toEqual(['私=わたし', '日本語=にほんご', '読=よ']);
  });
});

describe('Chinese segmentation', () => {
  it('writes pinyin per character, one ruby each', () => {
    const runs = zh('银行');
    expect(runs.map((r) => r.text)).toEqual(['银', '行']);
    expect(runs.map((r) => r.reading)).toEqual(['yín', 'háng']);
  });

  it('lets a phrase override the per-character default for a polyphonic character', () => {
    expect(annotated(zh, '行走')).toEqual(['行=xíng', '走=zǒu']); // default reading
    expect(annotated(zh, '银行')).toEqual(['银=yín', '行=háng']); // exception wins
  });

  it('prefers the longest phrase when several match', () => {
    expect(annotated(zh, '中国银行'))
      .toEqual(['中=zhōng', '国=guó', '银=yín', '行=háng']);
  });

  it('rebuilds text with punctuation exactly', () => {
    expect(rebuilds(zh, '中国，银行。')).toBe(true);
  });

  it('tags its runs as Chinese, and leaves English runs untagged', () => {
    expect(zh('中国').every((r) => r.lang === 'zh')).toBe(true);
    expect(zh('phonics').find((r) => r.reading).lang).toBeUndefined();
  });
});

describe('mixed scripts', () => {
  it('annotates English and Japanese in the same line', () => {
    expect(annotated(ja, 'phonics は 日本 です'))
      .toEqual(['phonics=ˈfɑnɪks', '日本=にほん']);
    expect(rebuilds(ja, 'phonics は 日本 です')).toBe(true);
  });

  it('annotates English inside Chinese', () => {
    expect(annotated(zh, 'phonics 中国')).toEqual(['phonics=ˈfɑnɪks', '中=zhōng', '国=guó']);
  });

  it('does nothing at all without tables', () => {
    const none = makeSegmenter({});
    expect(annotated(none, 'phonics 日本')).toEqual([]);
    expect(rebuilds(none, 'phonics 日本')).toBe(true);
  });

  it('annotates only English when the CJK table is still downloading', () => {
    const partial = makeSegmenter({ ipa: IPA, script: 'ja' });
    expect(annotated(partial, 'phonics 日本')).toEqual(['phonics=ˈfɑnɪks']);
  });

  it('reads a Chinese block as pinyin even inside a Japanese note', () => {
    // The reported bug: one note holding an English, a Japanese and a Chinese sentence
    // classified the whole note Japanese, so the Chinese line came out as kanji readings.
    const KANA_MIX = parseTable([
      '世界\tせかい', '言語\tげんご', '新しい\tあたら', '学ぶ\tまな', '広がる\tひろ',
      '学\tがく', '新\tしん', '言\tげん', '大\tだい', '会\tかい',
    ].join('\n'));
    const PINYIN_MIX = parseTable([
      '学\txué', '习\txí', '一\tyī', '门\tmén', '新\txīn', '语\tyǔ', '言\tyán',
    ].join('\n'));
    const note = makeSegmenter({ kana: KANA_MIX, pinyin: PINYIN_MIX, script: 'ja' });

    expect(annotated(note, '新しい言語')).toEqual(['新=あたら', '言語=げんご']);
    expect(annotated(note, '学习一门新语言'))
      .toEqual(['学=xué', '习=xí', '一=yī', '门=mén', '新=xīn', '语=yǔ', '言=yán']);
  });

  it('survives empty and nullish input', () => {
    expect(ja('')).toEqual([]);
    expect(ja(null)).toEqual([]);
  });
});
