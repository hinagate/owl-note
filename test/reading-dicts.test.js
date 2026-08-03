// The bakers run at build time, so a mistake here ships a silently wrong dictionary that
// no runtime test would catch. Both are pure functions over their source data.
import { describe, it, expect } from 'vitest';
import { buildKanaTable, toHiragana } from '../scripts/build-kana-dict.mjs';
import { buildPinyinTable, toneMark } from '../scripts/build-pinyin-dict.mjs';
import { MAX_SURFACE, MAX_PHRASE } from '../src/lib/segment.js';

const rows = (text) => new Map(text.trimEnd().split('\n').map((line) => line.split('\t')));

describe('buildKanaTable', () => {
  it('keeps only the primary reading when the source lists alternates', () => {
    expect(rows(buildKanaTable('東京,とうきょう,とうけい\n').text).get('東京')).toBe('とうきょう');
  });

  it('stores the kanji core and drops the okurigana both sides already share', () => {
    const table = rows(buildKanaTable('食べる,たべる\nお茶,おちゃ\n').text);
    expect(table.get('食べる')).toBe('た');  // べる is written in the surface already
    expect(table.get('お茶')).toBe('ちゃ');  // leading お likewise
  });

  it('keeps the okurigana in the KEY, so 新しい stays distinct from 新', () => {
    const table = rows(buildKanaTable('新しい,あたらしい\n新,しん\n').text);
    expect(table.get('新しい')).toBe('あたら');
    expect(table.get('新')).toBe('しん');
  });

  it('skips kana-only words, which already read as written', () => {
    const built = buildKanaTable('ひらがな,ひらがな\n漢字,かんじ\n');
    expect(rows(built.text).has('ひらがな')).toBe(false);
    expect(built.count).toBe(rows(built.text).size);
  });

  it('normalises katakana readings to the hiragana furigana is written in', () => {
    expect(rows(buildKanaTable('珈琲,コーヒー\n').text).get('珈琲')).toBe('こーひー');
    expect(toHiragana('カタカナ')).toBe('かたかな');
  });

  it('keeps the first entry when a surface repeats', () => {
    expect(rows(buildKanaTable('日,ひ\n日,にち\n').text).get('日')).toBe('ひ');
  });

  it('drops surfaces longer than the cap the runtime matcher scans to', () => {
    const long = 'あ'.repeat(MAX_SURFACE) + '漢'; // one over, and it contains kanji
    expect(rows(buildKanaTable(`${long},よみ\n漢字,かんじ\n`).text).has(long)).toBe(false);
  });

  it('applies the hand-verified overrides over whatever the source said', () => {
    // 中国 is absent from yomi-dict and 私 lists あたし first; both are corrected.
    const table = rows(buildKanaTable('私,あたし,わたし\n').text);
    expect(table.get('私')).toBe('わたし');
    expect(table.get('中国')).toBe('ちゅうごく');
    expect(table.get('日本')).toBe('にほん');
  });

  it('drops word+particle surfaces that would hijack the longest match', () => {
    // 今日は is こんにちは the greeting. Left in, it wins over 今日 and misreads any
    // sentence that simply starts "今日は…".
    const table = rows(buildKanaTable('今日,きょう\n今日は,こんにちは\n').text);
    expect(table.has('今日は')).toBe(false);
    expect(table.get('今日')).toBe('きょう');
  });

  it('ignores blank and malformed lines instead of emitting broken rows', () => {
    const built = buildKanaTable('\n漢字,かんじ\nnoreading\n,\n');
    expect(rows(built.text).get('漢字')).toBe('かんじ');
  });
});

describe('toneMark', () => {
  it('places the mark on a or o first', () => {
    expect(toneMark('hang2')).toBe('háng');
    expect(toneMark('hao3')).toBe('hǎo');
    expect(toneMark('guo2')).toBe('guó');
  });

  it('falls back to e, then to the last vowel', () => {
    expect(toneMark('hen3')).toBe('hěn');
    expect(toneMark('jiu3')).toBe('jiǔ');  // iu marks the u
    expect(toneMark('hui4')).toBe('huì');  // ui marks the i
  });

  it('writes CC-DICT\'s u: as ü', () => {
    expect(toneMark('lu:4')).toBe('lǜ');
    expect(toneMark('nu:3')).toBe('nǚ');
  });

  it('leaves the neutral tone unmarked and lowercases proper nouns', () => {
    expect(toneMark('de5')).toBe('de');
    expect(toneMark('Zhong1')).toBe('zhōng');
  });
});

describe('buildPinyinTable', () => {
  const entry = (traditional, simplified, pinyin) => ({ traditional, simplified, pinyin });

  it('gives every character a default reading', () => {
    const table = rows(buildPinyinTable([
      entry('中', '中', 'zhong1'), entry('國', '国', 'guo2'),
    ]).text);
    expect(table.get('中')).toBe('zhōng');
    expect(table.get('国')).toBe('guó'); // both script forms are indexed
    expect(table.get('國')).toBe('guó');
  });

  it('stores a phrase only when it deviates from the per-character defaults', () => {
    const built = buildPinyinTable([
      entry('行', '行', 'xing2'),
      entry('走', '走', 'zou3'),
      entry('銀', '银', 'yin2'),
      entry('行走', '行走', 'xing2 zou3'), // matches the defaults — not worth a row
      entry('銀行', '银行', 'yin2 hang2'), // 行 reads háng: a genuine exception
    ]);
    const table = rows(built.text);
    expect(table.has('行走')).toBe(false);
    expect(table.get('银行')).toBe('yín háng');
    expect(built.phrases).toBe(2); // the traditional and simplified spellings of 銀行
  });

  it('picks the default reading by corpus frequency, not by dictionary order', () => {
    // 行 appears as xíng twice and háng once, so xíng is the default even though the
    // háng entry comes first — which is what keeps the exception table small.
    const table = rows(buildPinyinTable([
      entry('銀行', '银行', 'yin2 hang2'),
      entry('行走', '行走', 'xing2 zou3'),
      entry('行動', '行动', 'xing2 dong4'),
    ]).text);
    expect(table.get('行')).toBe('xíng');
  });

  it('lets a single-character citation reading outweigh incidental phrase usage', () => {
    const table = rows(buildPinyinTable([
      entry('了', '了', 'le5'),
      entry('了解', '了解', 'liao3 jie3'),
      entry('了結', '了结', 'liao3 jie2'),
    ]).text);
    expect(table.get('了')).toBe('le'); // weighted 3, against two phrase uses
  });

  it('skips entries whose pinyin cannot be aligned character by character', () => {
    const built = buildPinyinTable([entry('中', '中', 'zhong1'), entry('中中', '中中', 'zhong1')]);
    expect(rows(built.text).has('中中')).toBe(false);
  });

  it('ignores non-Han surfaces such as CC-CEDICT\'s numeric entries', () => {
    const built = buildPinyinTable([entry('110', '110', 'yao1 yao1 ling2'), entry('中', '中', 'zhong1')]);
    expect(built.chars).toBe(1);
  });

  it('drops phrases longer than the cap the runtime matcher scans to', () => {
    const long = '中'.repeat(MAX_PHRASE + 1);
    const built = buildPinyinTable([
      entry('中', '中', 'zhong1'),
      entry(long, long, Array(MAX_PHRASE + 1).fill('zhong4').join(' ')),
    ]);
    expect(rows(built.text).has(long)).toBe(false);
  });
});
