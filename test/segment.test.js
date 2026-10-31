// The segmenter is where the three languages actually differ, so this is where the
// interesting cases live: dictionary-driven CJK boundaries, okurigana that must stay bare,
// per-character Jyutping, and mixed-script text.
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
// Like scripts/build-jyutping-dict.mjs writes it: one default per character, and words
// only where they differ from reading those defaults one by one.
const JYUTPING = parseTable([
  '銀\tngan4', '行\thaang4', '路\tlou6', '中\tzung1', '國\tgwok3',
  '銀行\tngan4 hong4', '中國銀行\tzung1 gwok3 ngan4 hong4',
].join('\n'));

const ja = makeSegmenter({ ipa: IPA, kana: KANA, script: 'ja' });
const yue = makeSegmenter({ ipa: IPA, jyutping: JYUTPING, script: 'yue' });

/** Every segmenter run must rebuild its input exactly — the annotator depends on it. */
const rebuilds = (segment, text) => segment(text).map((r) => r.text).join('') === text;
const annotated = (segment, text) => segment(text).filter((r) => r.reading)
  .map((r) => `${r.text}=${r.reading}`);

describe('detectHanScript', () => {
  it('reads Han as Japanese when any kana keeps it company', () => {
    expect(detectHanScript('日本語を勉強する')).toBe('ja');
    expect(detectHanScript('コンピュータ')).toBe('ja');
  });

  it('reads bare Han as Cantonese, the only Chinese reading offered', () => {
    expect(detectHanScript('中國銀行')).toBe('yue');
    expect(detectHanScript('')).toBe('yue');
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
    expect(scriptForBlock('新しい言語', table, 'yue')).toBe('ja');
  });

  it('keeps a kanji-only block Japanese when the note is Japanese', () => {
    // The regression this guards: 概 has no single-character row, so a per-character test
    // would rate 概要 as foreign and read it as Cantonese.
    expect(scriptForBlock('概要', table, 'ja')).toBe('ja');
    expect(scriptForBlock('東京世界概要', table, 'ja')).toBe('ja');
  });

  it('flips a block the Japanese dictionary cannot account for to Cantonese', () => {
    // 佢 哋 喺 傾 are written-Cantonese characters, and 會 學 the Traditional forms Japanese
    // simplified: none of them is in a Japanese word list.
    expect(scriptForBlock('佢哋喺度傾計', table, 'ja')).toBe('yue');
    expect(scriptForBlock('你會唔會嚟大學', table, 'ja')).toBe('yue');
  });

  it('will not overrule the note on too little evidence', () => {
    // 概 is Japanese (in 概要) but has no row of its own: one such character proves nothing.
    expect(scriptForBlock('概', table, 'ja')).toBe('ja');
  });

  // The reported case: a note with an English, a Japanese and a Cantonese line. The
  // Japanese dictionary knows 出來 (an old spelling of 出来) and 飲茶, so five of the six
  // characters looked Japanese and the line came out as え・でき・やむちゃ.
  it('reads a line as Cantonese when it uses a character no Japanese word does', () => {
    const japanese = parseTable(['得る\tえ', '出來\tでき', '飲茶\tやむちゃ', '今度\tこんど'].join('\n'));
    expect(scriptForBlock('得閒出來飲茶', japanese, 'ja')).toBe('yue'); // 閒: never Japanese
    expect(scriptForBlock('佢', japanese, 'ja')).toBe('yue'); // even alone: Japanese has no reading for it
    expect(scriptForBlock('飲茶', japanese, 'ja')).toBe('ja'); // every character is Japanese too
  });

  it('never drags a Cantonese note towards Japanese', () => {
    expect(scriptForBlock('世界概要東京', table, 'yue')).toBe('yue');
  });

  it('falls back to the note when the kana table has not loaded', () => {
    expect(scriptForBlock('佢哋喺度傾計', null, 'ja')).toBe('ja');
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

describe('Cantonese segmentation', () => {
  it('writes Jyutping per character, one ruby each', () => {
    const runs = yue('銀行');
    expect(runs.map((r) => r.text)).toEqual(['銀', '行']);
    expect(runs.map((r) => r.reading)).toEqual(['ngan4', 'hong4']);
  });

  it('lets a word override the per-character default for a polyphonic character', () => {
    expect(annotated(yue, '行路')).toEqual(['行=haang4', '路=lou6']); // default reading
    expect(annotated(yue, '銀行')).toEqual(['銀=ngan4', '行=hong4']); // exception wins
  });

  it('prefers the longest word when several match', () => {
    expect(annotated(yue, '中國銀行'))
      .toEqual(['中=zung1', '國=gwok3', '銀=ngan4', '行=hong4']);
  });

  it('rebuilds text with punctuation exactly', () => {
    expect(rebuilds(yue, '中國，銀行。')).toBe(true);
  });

  it('attaches pronunciation cues and stress to English content words only', () => {
    const en = makeSegmenter({ ipa: parseTable('speed\tspiːd\ncup\tkʌp\nthe\tðə\n') });
    const [speed] = en('speed');
    expect(speed.parts.map((p) => p.cue)).toEqual([null, 'longer', 'final']);
    // No cue in cup, but its stress is still shown.
    expect(en('cup')[0].parts).toEqual([{ text: 'kʌp', cue: null, stressed: true }]);
    expect('parts' in en('the')[0]).toBe(false);
    expect(yue('中國').some((r) => 'parts' in r)).toBe(false);
  });

  it('tags its runs as Cantonese (yue), and leaves English runs untagged', () => {
    expect(yue('中國').every((r) => r.lang === 'yue')).toBe(true);
    expect(yue('phonics').find((r) => r.reading).lang).toBeUndefined();
  });
});

// "Wha' do you want": a final p, t or k before another consonant is held, silently.
describe('held stops before a consonant', () => {
  const en = makeSegmenter({
    ipa: parseTable([
      'what\twʌt', 'do\tdu', 'you\tjə', 'want\twɑːnt', 'is\tɪz', 'it\tɪt', 'at\tət',
      'school\tskuːl', 'asked\tæskt', 'me\tmi', 'hour\tˈaʊ.ɚ', 'book\tbʊk', 'well-known\tˈwɛlˈnoʊn',
    ].join('\n')),
  });
  const held = (text) => en(text).filter((r) => r.parts?.some((p) => p.held))
    .map((r) => `${r.text}=${r.parts.map((p) => (p.held ? `(${p.text})` : p.text)).join('')}`);

  it('holds the t of what before do, but not the t of want at the end', () => {
    expect(held('What do you want')).toEqual(['What=wʌ(t)']);
  });

  it('lets a vowel link instead: what is, it is, at an hour', () => {
    expect(held('what is it')).toEqual([]);
    expect(held('at an hour')).toEqual([]);
  });

  it('treats punctuation as a pause, not a link', () => {
    expect(held('what, do')).toEqual([]);
    expect(held('what. Do')).toEqual([]);
  });

  it('holds a function word too, and a stop inside an orange cluster', () => {
    expect(held('at school')).toEqual(['at=ə(t)']);
    expect(held('asked me')).toEqual(['asked=æsk(t)']);
    expect(held('book me')).toEqual(['book=bʊ(k)']);
  });

  it('gives street smarts the falling mark and the held t together', () => {
    const seg = makeSegmenter({ ipa: parseTable('street\tstriːt\nsmarts\tsmɑːrts\n') });
    const [street, , smarts] = seg('street smarts');
    expect(street.parts.map((p) => [p.text, Boolean(p.fall), Boolean(p.held)]))
      .toEqual([['str', true, false], ['iː', false, false], ['t', false, true]]);
    expect(smarts.parts[0].fall).toBe(true); // held vowel too; at the end, nothing to hold
    expect(smarts.parts.some((p) => p.held)).toBe(false);
  });

  it('never changes what the runs say', () => {
    for (const text of ['What do you want', 'at school', 'asked me, what is it']) {
      expect(rebuilds(en, text)).toBe(true);
      for (const run of en(text)) {
        if (run.parts) expect(run.parts.map((p) => p.text).join('')).toBe(run.reading);
      }
    }
  });
});

// From a review of real notes: each of these was read wrong.
describe('reading English in context', () => {
  const en = makeSegmenter({
    ipa: parseTable([
      'second\tˈsɛk.ənd', 'live\tlaɪv', 'video\tˈvɪd.i.oʊ', 'we\twi', 'also\tˈɔːl.soʊ', 'use\tjuːs',
      'this\tðɪs', "i've\taɪv", 'been\tbɪn', 'for\tfɚ', 'about\təˈbaʊt', 'eight\teɪt',
      'years\tjɪrz', 'people\tˈpiː.pəl', 'who\thu', 'in\tɪn', 'i\taɪ', 'have\thæv', 'read\trɛd',
      'it\tɪt', 'the\tðə', 'news\tnuːz', 'make\tmeɪk', 'of\təv',
    ].join('\n')),
  });
  const reading = (text, word) => en(text).find((r) => r.text === word)?.reading;

  it('keeps live an adjective before a noun, and a verb after a subject or before in', () => {
    expect(reading('Second, live video', 'live')).toBe('laɪv');
    expect(reading('People who live in', 'live')).toBe('lɪv');
  });

  it('looks past an adverb to find the subject: We also use → the verb', () => {
    expect(reading('We also use this', 'use')).toBe('juːz');
    expect(reading('Make use of this', 'use')).toBe('juːs');
  });

  it('reads read as the past only after have', () => {
    expect(reading('I read the news', 'read')).toBe('riːd');
    expect(reading('I have read it', 'read')).toBe('rɛd');
  });

  it('reads I\u2019ve as one word, and 8 as eight with its t held', () => {
    const runs = en('I\u2019ve been for about 8 years');
    expect(runs.find((r) => r.text === 'I\u2019ve').reading).toBe('aɪv');
    const eight = runs.find((r) => r.text === '8');
    expect(eight.reading).toBe('eɪt');
    expect(eight.parts.map((p) => (p.held ? `(${p.text})` : p.text)).join('')).toBe('eɪ(t)');
    expect(rebuilds(en, 'I\u2019ve been for about 8 years')).toBe(true);
  });

  it('never reads a number in Chinese or Japanese company', () => {
    const mixed = makeSegmenter({ ipa: parseTable('eight\teɪt\n'), jyutping: parseTable('有\tjau5\n個\tgo3\n') });
    expect(mixed('我有8個').some((r) => r.text === '8' && r.reading)).toBe(false);
    expect(mixed('有 8 個').some((r) => r.text === '8' && r.reading)).toBe(false);
  });
});

describe('English words the dictionary does not list', () => {
  const en = makeSegmenter({
    ipa: parseTable([
      'high\thaɪ', 'availability\təˌveɪ.ləˈbɪl.ə.ti', 'architect\tˈɑːr.kəˌtɛkt',
      'well-known\tˈwɛlˈnoʊn', 're\treɪ', 'enter\tˈɛn.tɚ', 'self\tsɛlf', 'driving\tˈdraɪ.vɪŋ',
    ].join('\n')),
  });

  // The hyphen rides in the ruby before it: loose between two rubies, it let the line
  // break before it and open the next line on "-availability".
  it('reads a hyphenated compound part by part, each hyphen with the word before it', () => {
    expect(annotated(en, 'architecting high-availability systems'))
      .toEqual(['architecting=ˈɑːr.kəˌtɛk.tɪŋ', 'high-=haɪ', 'availability=əˌveɪ.ləˈbɪl.ə.ti']);
    expect(rebuilds(en, 'architecting high-availability systems')).toBe(true);
  });

  it('keeps a compound the dictionary lists as one reading', () => {
    expect(annotated(en, 'well-known')).toEqual(['well-known=ˈwɛlˈnoʊn']);
  });

  it('reads a hyphenated re- as /riː/, not the musical note', () => {
    expect(annotated(en, 're-enter')).toEqual(['re-=riː', 'enter=ˈɛn.tɚ']);
    expect(annotated(en, 'self-driving')).toEqual(['self-=sɛlf', 'driving=ˈdraɪ.vɪŋ']);
  });

  it('leaves a part it cannot read bare, hyphen and all, and still reads the rest', () => {
    expect(annotated(en, 'high-zorkability')).toEqual(['high-=haɪ']);
    expect(annotated(en, 'zork-availability')).toEqual(['availability=əˌveɪ.ləˈbɪl.ə.ti']);
    expect(en('zork-availability')[0].text).toBe('zork-');
    expect(rebuilds(en, 'high-zorkability')).toBe(true);
  });

  it('cues a part by its own word, not the hyphen it carries', () => {
    const [self] = en('self-driving');
    expect(self.parts.map((p) => p.text).join('')).toBe('sɛlf'); // the reading, without "-"
    expect(self.parts.at(-1).cue).toBe('final');
  });
});

describe('mixed scripts', () => {
  it('annotates English and Japanese in the same line', () => {
    expect(annotated(ja, 'phonics は 日本 です'))
      .toEqual(['phonics=ˈfɑnɪks', '日本=にほん']);
    expect(rebuilds(ja, 'phonics は 日本 です')).toBe(true);
  });

  it('annotates English inside Cantonese', () => {
    expect(annotated(yue, 'phonics 中國')).toEqual(['phonics=ˈfɑnɪks', '中=zung1', '國=gwok3']);
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

  it('reads a Cantonese block as Jyutping even inside a Japanese note', () => {
    // The reported bug: one note holding an English, a Japanese and a Chinese sentence
    // classified the whole note Japanese, so the Chinese line came out as kanji readings.
    const KANA_MIX = parseTable([
      '世界\tせかい', '言語\tげんご', '新しい\tあたら', '学ぶ\tまな', '広がる\tひろ',
      '学\tがく', '新\tしん', '言\tげん', '大\tだい', '会\tかい',
    ].join('\n'));
    const JYUTPING_MIX = parseTable([
      '佢\tkeoi5', '哋\tdei6', '學\thok6', '緊\tgan2', '新\tsan1', '語\tjyu5', '言\tjin4',
    ].join('\n'));
    const note = makeSegmenter({ kana: KANA_MIX, jyutping: JYUTPING_MIX, script: 'ja' });

    expect(annotated(note, '新しい言語')).toEqual(['新=あたら', '言語=げんご']);
    expect(annotated(note, '佢哋學緊新語言'))
      .toEqual(['佢=keoi5', '哋=dei6', '學=hok6', '緊=gan2', '新=san1', '語=jyu5', '言=jin4']);
  });

  it('survives empty and nullish input', () => {
    expect(ja('')).toEqual([]);
    expect(ja(null)).toEqual([]);
  });
});
