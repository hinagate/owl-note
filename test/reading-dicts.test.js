// The bakers run at build time, so a mistake here ships a silently wrong dictionary that
// no runtime test would catch. Both are pure functions over their source data.
import { describe, it, expect } from 'vitest';
import { buildKanaTable, toHiragana } from '../scripts/build-kana-dict.mjs';
import { buildJyutpingTable, dictRows, DEFAULT_READINGS } from '../scripts/build-jyutping-dict.mjs';
import { buildIpaTable } from '../scripts/build-ipa-dict.mjs';
import { MAX_SURFACE, MAX_PHRASE } from '../src/lib/segment.js';

const rows = (text) => new Map(text.trimEnd().split('\n').map((line) => line.split('\t')));

describe('buildIpaTable', () => {
  it('bakes explicit vowel length and syllable boundaries into the shipped lookup', () => {
    const table = rows(buildIpaTable({ scheming: 'S K IY1 M IH0 NG' }).text);
    expect(table.get('scheming')).toBe('ˈskiː.mɪŋ');
  });

  it('bakes function words as they are spoken in a sentence, not as citation forms', () => {
    const table = rows(buildIpaTable({
      to: 'T UW1', was: 'W AA1 Z', her: 'HH ER1', for: 'F AO1 R', he: 'HH IY1', have: 'HH AE1 V', speed: 'S P IY1 D',
    }).text);
    expect(table.get('to')).toBe('tə');
    expect(table.get('was')).toBe('wəz');
    expect(table.get('her')).toBe('hɚ');
    expect(table.get('for')).toBe('fɚ');
    expect(table.get('he')).toBe('hi');      // no schwa form: just loses the length mark
    expect(table.get('have')).toBe('hæv');   // strong as a main verb: left alone
    expect(table.get('speed')).toBe('spiːd'); // content words untouched
  });

  it('bakes the spoken form of words CMUdict gives in a careful one', () => {
    const table = rows(buildIpaTable({
      vehicle: 'V IY1 HH IH0 K AH0 L', vehicles: 'V IY1 HH IH0 K AH0 L Z',
      camera: 'K AE1 M ER0 AH0', cameras: 'K AE1 M ER0 AH0 Z', lead: 'L EH1 D',
    }).text);
    expect(table.get('vehicle')).toBe('ˈviː.ɪ.kəl'); // the h is silent
    expect(table.get('vehicles')).toBe('ˈviː.ɪ.kəlz');
    expect(table.get('camera')).toBe('ˈkæm.rə'); // two syllables
    expect(table.get('cameras')).toBe('ˈkæm.rəz');
    expect(table.get('lead')).toBe('liːd'); // not the metal
  });

  // The point of the weak forms: no function word tells the reader to hold it. The full
  // dictionary is the source, so a new entry or a changed reading is caught here.
  it('leaves no length mark on any function word, except the ones stressed on purpose', async () => {
    const { dictionary } = await import('cmu-pronouncing-dictionary');
    const { UNSTRESSED_WORDS } = await import('../src/lib/ipa-cues.js');
    const source = Object.fromEntries([...UNSTRESSED_WORDS].filter((w) => dictionary[w]).map((w) => [w, dictionary[w]]));
    const table = rows(buildIpaTable(source).text);
    const held = [...table].filter(([, ipa]) => ipa.includes('ː')).map(([word]) => word);
    // onto and being stress their first syllable even in running speech.
    expect(held.sort()).toEqual(['being', 'onto']);
  });
});

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

// A Rime dict.yaml: a YAML header closed by "...", then tab-separated rows.
const rimeDict = (rows) => `---\nname: test\nversion: "1"\n...\n${rows.join('\n')}\n`;
const chars = (...rows) => rimeDict(rows.map((r) => r.join('\t')));
const words = (...rows) => rimeDict(rows.map((r) => r.join('\t')));

describe('dictRows', () => {
  it('reads the rows after the header, skipping comments and blank lines', () => {
    const text = '# comment\n---\nname: x\n...\n# note\n中\tzung1\n\n國\tgwok3\t5%\n';
    expect(dictRows(text)).toEqual([['中', 'zung1'], ['國', 'gwok3', '5%']]);
  });
});

describe('buildJyutpingTable', () => {
  it('gives every character a default reading, the dictionary\'s favourite', () => {
    const table = rows(buildJyutpingTable({
      chars: chars(['中', 'zung1'], ['中', 'zung3', '5%'], ['國', 'gwok3']),
      words: words(),
    }).text);
    expect(table.get('中')).toBe('zung1'); // unweighted is the standard reading
    expect(table.get('國')).toBe('gwok3');
  });

  it('stores a word only when it deviates from the per-character defaults', () => {
    const built = buildJyutpingTable({
      chars: chars(['銀', 'ngan4'], ['路', 'lou6'], ['行', 'haang4'], ['行', 'hong4', '5%']),
      words: words(['行路', 'haang4 lou6'], ['銀行', 'ngan4 hong4']),
    });
    const table = rows(built.text);
    expect(table.has('行路')).toBe(false); // the defaults already read it right
    expect(table.get('銀行')).toBe('ngan4 hong4');
    expect(built.words).toBe(1);
  });

  it('picks a default by how the word list uses it, the favourite counting three times', () => {
    const favourite = chars(['長', 'coeng4', '5%'], ['長', 'zoeng2', '3%']);
    const grow = [['長大', 'zoeng2 daai6'], ['校長', 'haau6 zoeng2'], ['家長', 'gaa1 zoeng2']];
    // Three uses tie the favourite's weight of three, and the favourite keeps it ...
    expect(rows(buildJyutpingTable({ chars: favourite, words: words(...grow) }).text).get('長')).toBe('coeng4');
    // ... a fourth outvotes it.
    const more = words(...grow, ['部長', 'bou6 zoeng2']);
    expect(rows(buildJyutpingTable({ chars: favourite, words: more }).text).get('長')).toBe('zoeng2');
  });

  // The word list never shows a character standing alone, so 我會去 used to read 會 as the
  // wui2 of 開會. The commonest stand-alone readings are set by hand.
  it('sets the stand-alone readings the word list cannot see', () => {
    expect(DEFAULT_READINGS).toMatchObject({ 會: 'wui5', 呀: 'aa3' });
    const table = rows(buildJyutpingTable({
      chars: chars(['會', 'wui2', '3%'], ['會', 'wui5', '5%'], ['開', 'hoi1']),
      words: words(['開會', 'hoi1 wui2'], ['大會', 'daai6 wui2'], ['社會', 'se5 wui2']),
    }).text);
    expect(table.get('會')).toBe('wui5');
    expect(table.get('開會')).toBe('hoi1 wui2'); // the compound keeps its own reading
  });

  it('skips rows it cannot align or read, and non-Han surfaces', () => {
    const built = buildJyutpingTable({
      chars: chars(['中', 'zung1'], ['A', 'ei1'], ['國', 'gwok']),
      words: words(['中中', 'zung1'], ['中國', 'zung1 gwok3'], ['ab中', 'ei1 bi1 zung1']),
    });
    const table = rows(built.text);
    expect(table.has('A')).toBe(false); // not Han
    expect(table.get('國')).toBe('gwok3'); // its own row had no tone; 中國 supplies one
    expect(table.has('中中')).toBe(false); // two characters, one syllable
    expect(table.has('ab中')).toBe(false);
  });

  it('drops words longer than the cap the runtime matcher scans to', () => {
    const long = '中'.repeat(MAX_PHRASE + 1);
    const built = buildJyutpingTable({
      chars: chars(['中', 'zung1']),
      words: words([long, Array(MAX_PHRASE + 1).fill('zung3').join(' ')]),
    });
    expect(rows(built.text).has(long)).toBe(false);
  });

  it('builds from the vendored rime-cantonese, reading Cantonese as written', () => {
    const table = rows(buildJyutpingTable().text);
    for (const [surface, reading] of [
      ['銀行', 'ngan4 hong4'], ['廣東話', 'gwong2 dung1 waa2'], ['屋企', 'uk1 kei2'],
      ['佢', 'keoi5'], ['嘅', 'ge3'], ['咗', 'zo2'], ['冇', 'mou5'], ['會', 'wui5'],
    ]) expect(table.get(surface), surface).toBe(reading);
  });
});
