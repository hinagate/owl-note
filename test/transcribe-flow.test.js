import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import * as sw from '../src/background/service-worker.js';
import * as bm from '../src/lib/bookmarks.js';
import { getSession } from '../src/lib/capture-session.js';
import { decode } from '../src/lib/codec.js';

const TAB = { id: 42, windowId: 7, title: 'Gradient Descent', url: 'https://example.test/watch?v=1' };

// Deliberately no chrome.permissions stub: tabCapture is a required permission,
// so nothing in this flow may consult or request it.
function stubTranscribeApis() {
  const injected = [];
  const windows = [];
  const captured = [];
  const runtimeMessages = [];
  const overlayMessages = [];
  chrome.scripting = { executeScript: async (opts) => { injected.push(opts); } };
  chrome.windows = { ...(chrome.windows || {}), create: async (opts) => { windows.push(opts); } };
  chrome.offscreen = {
    hasDocument: async () => false,
    createDocument: async () => {},
    closeDocument: async () => {},
  };
  chrome.tabCapture = {
    getMediaStreamId: async (opts) => {
      captured.push(opts);
      return 'stream-1';
    },
  };
  chrome.runtime.sendMessage = async (message) => { runtimeMessages.push(message); };
  chrome.tabs.create = async () => {};
  chrome.tabs.update = async () => {};
  chrome.tabs.sendMessage = async (tabId, message) => { overlayMessages.push({ tabId, message }); };
  return { injected, windows, captured, runtimeMessages, overlayMessages };
}

const cue = (text, at) => ({ text, videoTime: null, at });
const tokenFor = (session) => `${session.tabId}:${session.startedAt}`;
async function armAndStart(tab = TAB) {
  await sw.handleTranscribe({ menuItemId: 'owl-transcribe-video', pageUrl: tab.url }, tab);
}

// The one remaining first-run step: Chrome has no local model for the language,
// so the session parks itself while the setup window downloads one.
async function armViaLanguageDownload(tab = TAB) {
  await armAndStart(tab);
  await sw.handleCaptureMessage({
    type: 'owl-native-speech-install-required',
    lang: 'en-US',
    sessionToken: tokenFor(await getSession()),
  });
}

beforeEach(() => installFakeChrome());

describe('transcription flow', () => {
  it('starts directly from the right-clicked tab after setup', async () => {
    const { injected } = stubTranscribeApis();
    await armAndStart();

    const session = await getSession();
    expect(session).toMatchObject({ tabId: 42, state: 'recording', url: TAB.url });
    expect(injected[0]).toMatchObject({ target: { tabId: 42 }, files: ['overlay.js'] });
  });

  it('ignores a context-menu click that belongs to another feature', async () => {
    stubTranscribeApis();
    expect(await sw.handleTranscribe({ menuItemId: 'owl-capture-full-page' }, TAB)).toBe(null);
    expect(await getSession()).toBe(null);
  });

  it('does not capture invisibly when Chrome refuses the page overlay', async () => {
    const { captured } = stubTranscribeApis();
    chrome.scripting.executeScript = async () => { throw new Error('restricted page'); };

    expect(await sw.handleTranscribe({
      menuItemId: 'owl-transcribe-video',
      pageUrl: TAB.url,
    }, TAB)).toBe(null);
    expect(captured).toEqual([]);
    expect(await getSession()).toBe(null);
  });

  it('accumulates cues delivered by the native engine', async () => {
    stubTranscribeApis();
    await armAndStart();

    await sw.handleCaptureMessage({ type: 'owl-cue', cues: [cue('hello there', 1000)] });
    await sw.handleCaptureMessage({ type: 'owl-cue', cues: [cue('second line', 2000)] });

    expect((await getSession()).cues.map((item) => item.text)).toEqual(['hello there', 'second line']);
  });

  it('closing the captured tab saves the transcript instead of losing it', async () => {
    stubTranscribeApis();
    await armAndStart();
    await sw.handleCaptureMessage({ type: 'owl-cue', cues: [cue('words worth keeping', 1000)] });

    await sw.handleTabClosed(42);

    const root = await bm.ensureRoot();
    const notebook = (await bm.listNotebooks(root)).find((item) => item.title === 'Transcripts');
    expect(notebook).toBeTruthy();
    const notes = await bm.listNotes(notebook.id);
    expect(notes).toHaveLength(1);
    const saved = await decode(notes[0].payload);
    expect(saved.title).toBe('Gradient Descent');
    expect(saved.body).toContain('words worth keeping');
    expect(saved.body).toContain('Source: <https://example.test/watch?v=1>');
    expect(await getSession()).toBe(null);
  });

  it('leaves other tabs alone when they close', async () => {
    stubTranscribeApis();
    await armAndStart();
    expect(await sw.handleTabClosed(999)).toBe(null);
    expect((await getSession()).state).toBe('recording');
  });

  it('stops without saving, so Save and Discard stay the user choice', async () => {
    stubTranscribeApis();
    await armAndStart();
    await sw.handleCaptureMessage({ type: 'owl-cue', cues: [cue('spoken words', 1000)] });

    await sw.handleStopCapture();

    const session = await getSession();
    expect(session.state).toBe('stopped');
    expect(session.cues).toHaveLength(1);
    const root = await bm.ensureRoot();
    expect((await bm.listNotebooks(root)).find((item) => item.title === 'Transcripts')).toBeUndefined();
  });

  // Chrome finalizes only at a pause: what was mid-sentence at Save is interim text.
  it('keeps the sentence still being spoken when Save is pressed', async () => {
    stubTranscribeApis();
    await armAndStart();
    await sw.handleCaptureMessage({ type: 'owl-cue', cues: [cue('the talk so far.', Date.now())] });
    await sw.handleCaptureMessage({ type: 'owl-interim', text: 'and its very last words' });

    const { note } = await sw.handleSaveTranscript();
    expect(note.body).toContain('the talk so far. and its very last words');
  });

  it('does not add interim text a final result already replaced', async () => {
    stubTranscribeApis();
    await armAndStart();
    await sw.handleCaptureMessage({ type: 'owl-interim', text: 'half a sen' });
    await sw.handleCaptureMessage({ type: 'owl-cue', cues: [cue('half a sentence, finished.', 1000)] });

    const { note } = await sw.handleSaveTranscript();
    expect(note.body).toContain('half a sentence, finished.');
    expect(note.body).not.toContain('half a sen half');
    expect(note.body.match(/half a sen/g)).toHaveLength(1);
  });

  it('keeps it on Stop too, ready for a later Save', async () => {
    stubTranscribeApis();
    await armAndStart();
    await sw.handleCaptureMessage({ type: 'owl-interim', text: 'still talking' });
    await sw.handleStopCapture();
    expect((await getSession()).cues.map((c) => c.text)).toEqual(['still talking']);
  });

  it('drops cues that arrive after the session stopped', async () => {
    stubTranscribeApis();
    await armAndStart();
    await sw.handleStopCapture();
    await sw.handleCaptureMessage({ type: 'owl-cue', cues: [cue('too late', 5000)] });
    expect((await getSession()).cues).toEqual([]);
  });
});

describe('Chrome-native capture', () => {
  it('starts on the very first right-click, with no permission prompt', async () => {
    const { windows, captured, injected, runtimeMessages } = stubTranscribeApis();
    await armAndStart();

    expect(windows).toEqual([]);
    expect(injected[0]).toMatchObject({ target: { tabId: 42 }, files: ['overlay.js'] });
    expect(await getSession()).toMatchObject({ tabId: 42, state: 'recording' });
    // Audio waits for the offscreen engine to confirm a local model, not for a
    // reload or a second gesture.
    expect(captured).toEqual([]);
    expect(runtimeMessages).toContainEqual(expect.objectContaining({
      target: 'offscreen',
      type: 'owl-offscreen-prepare',
      lang: 'en-US',
    }));
  });

  it('never consults chrome.permissions to start a capture', async () => {
    const calls = [];
    stubTranscribeApis();
    chrome.permissions = {
      contains: async () => { calls.push('contains'); return false; },
      request: async () => { calls.push('request'); return false; },
    };

    await armAndStart();

    expect(calls).toEqual([]);
    expect(await getSession()).toMatchObject({ tabId: 42, state: 'recording' });
  });

  it('returns to the video and resumes the session once the language installs', async () => {
    const { overlayMessages, runtimeMessages } = stubTranscribeApis();
    const tabUpdates = [];
    const windowUpdates = [];
    chrome.tabs.update = async (...args) => { tabUpdates.push(args); };
    chrome.windows.update = async (...args) => { windowUpdates.push(args); };

    await armViaLanguageDownload();
    expect(await getSession()).toBe(null);

    await sw.handleCaptureMessage({ type: 'owl-transcribe-setup-complete' });

    expect(tabUpdates).toContainEqual([42, { active: true }]);
    expect(windowUpdates).toContainEqual([7, { focused: true }]);
    expect(await getSession()).toMatchObject({ tabId: 42, state: 'recording', url: TAB.url });
    // No reload and no repeated gesture: the source tab never navigated, so its
    // activeTab grant — capture access included — is still the original one.
    expect(runtimeMessages.filter((m) => m.type === 'owl-offscreen-prepare')).toHaveLength(2);
    expect(overlayMessages.map((m) => m.message.state)).not.toContain('needs another right-click');
  });

  it('keeps the setup message alive until the source tab has been restored', async () => {
    stubTranscribeApis();
    await armViaLanguageDownload();

    const response = new Promise((resolve) => {
      expect(sw.handleRuntimeMessage(
        { type: 'owl-transcribe-setup-complete' },
        {},
        resolve,
      )).toBe(true);
    });

    await expect(response).resolves.toEqual({ ok: true });
  });

  it('abandons the armed session when the source tab reloads and revokes activeTab', async () => {
    const { overlayMessages } = stubTranscribeApis();
    await armViaLanguageDownload();

    expect(await sw.handleTranscribeTabUpdated(42, { status: 'loading' })).toBe(true);
    expect(overlayMessages.at(-1)).toEqual({
      tabId: 42,
      message: { type: 'owl-overlay-close' },
    });
    expect(await sw.handleTranscribeTabUpdated(42, { status: 'complete' })).toBe(null);
    // A late setup-complete must not auto-start into a grant the reload killed.
    expect(await sw.handleCaptureMessage({ type: 'owl-transcribe-setup-complete' })).toBe(null);
    expect(await getSession()).toBe(null);
  });

  it('ignores reloads from tabs that were not armed for transcription', async () => {
    const { overlayMessages } = stubTranscribeApis();
    await armViaLanguageDownload();

    expect(await sw.handleTranscribeTabUpdated(99, { status: 'loading' })).toBe(null);
    expect(overlayMessages.at(-1).message.type).toBe('owl-overlay-update');
  });

  it('clears the armed session when the language download is cancelled', async () => {
    const { overlayMessages } = stubTranscribeApis();
    await armViaLanguageDownload();

    await sw.handleCaptureMessage({ type: 'owl-transcribe-setup-cancelled' });

    expect(overlayMessages.at(-1)).toEqual({
      tabId: 42,
      message: { type: 'owl-overlay-close' },
    });
    expect(await sw.handleCaptureMessage({ type: 'owl-transcribe-setup-complete' })).toBe(null);
    expect(await getSession()).toBe(null);
  });

  it('captures audio after the language download without a second right-click', async () => {
    const { captured, overlayMessages } = stubTranscribeApis();
    await armViaLanguageDownload();

    await sw.handleCaptureMessage({ type: 'owl-transcribe-setup-complete' });
    await sw.handleCaptureMessage({
      type: 'owl-native-speech-ready',
      lang: 'en-US',
      sessionToken: tokenFor(await getSession()),
    });

    expect(captured).toEqual([{ targetTabId: 42 }]);
    expect(overlayMessages.map((m) => m.message.state)).not.toContain('needs another right-click');
  });

  it('starts from the right-click alone when the language is already installed', async () => {
    const { captured, windows } = stubTranscribeApis();
    await armAndStart();
    expect(captured).toEqual([]);
    expect(windows).toEqual([]);
    expect(await getSession()).toMatchObject({ tabId: 42, state: 'recording' });

    await sw.handleCaptureMessage({
      type: 'owl-native-speech-ready',
      lang: 'en-US',
      sessionToken: tokenFor(await getSession()),
    });
    expect(captured).toEqual([{ targetTabId: 42 }]);
  });

  it('pauses for a missing language resource and keeps the page untouched', async () => {
    const { captured, windows, overlayMessages } = stubTranscribeApis();
    await armAndStart();
    await sw.handleCaptureMessage({
      type: 'owl-native-speech-install-required',
      lang: 'en-US',
      sessionToken: tokenFor(await getSession()),
    });

    expect(captured).toEqual([]);
    expect(windows.at(-1).url).toContain('enable.html?lang=en-US');
    expect(overlayMessages).toContainEqual({
      tabId: 42,
      message: expect.objectContaining({
        type: 'owl-overlay-update',
        state: 'one-time setup',
        canSave: false,
      }),
    });
    expect(await getSession()).toBe(null);

    await sw.handleCaptureMessage({ type: 'owl-transcribe-setup-complete' });
    expect(await getSession()).toMatchObject({
      tabId: 42,
      state: 'recording',
      title: 'Gradient Descent',
    });
  });

  it('asks for one more right-click when the page navigated mid-start', async () => {
    const { overlayMessages } = stubTranscribeApis();
    chrome.tabCapture.getMediaStreamId = async () => {
      throw new Error('Extension has not been invoked for the current page (see activeTab permission).');
    };
    await armAndStart();

    await sw.handleCaptureMessage({
      type: 'owl-native-speech-ready',
      lang: 'en-US',
      sessionToken: tokenFor(await getSession()),
    });

    expect(await getSession()).toBe(null);
    expect(overlayMessages.at(-1)).toEqual({
      tabId: 42,
      message: expect.objectContaining({
        type: 'owl-overlay-update',
        state: 'needs another right-click',
        text: expect.stringContaining('Right-click'),
        armed: true,
      }),
    });
  });

  it('ignores a readiness message left over from an older capture session', async () => {
    const { captured } = stubTranscribeApis();
    await armAndStart();
    await sw.handleCaptureMessage({
      type: 'owl-native-speech-ready',
      lang: 'en-US',
      sessionToken: '42:stale',
    });
    expect(captured).toEqual([]);
  });

  it('shows interim captions without writing them into the stored session', async () => {
    const { overlayMessages } = stubTranscribeApis();
    await armAndStart();
    await sw.handleCaptureMessage({ type: 'owl-interim', text: 'words still changing' });

    expect(overlayMessages.at(-1)).toEqual({
      tabId: 42,
      message: expect.objectContaining({
        type: 'owl-overlay-update',
        text: 'words still changing',
        state: 'listening',
      }),
    });
    expect((await getSession()).status).not.toHaveProperty('interim');
  });

  it('stamps native speech cues with the player position reported by the overlay', async () => {
    stubTranscribeApis();
    await armAndStart();
    await sw.handleCaptureMessage({ type: 'owl-video-time', videoTime: 754 });
    await sw.handleCaptureMessage({ type: 'owl-cue', cues: [cue('mid lecture words', 1000)] });

    expect((await getSession()).cues[0].videoTime).toBe(754);
  });

  it('leaves a cue that already knows its position alone', async () => {
    stubTranscribeApis();
    await armAndStart();
    await sw.handleCaptureMessage({ type: 'owl-video-time', videoTime: 754 });
    await sw.handleCaptureMessage({
      type: 'owl-cue',
      cues: [{ text: 'exact', videoTime: 12, at: 1000 }],
    });

    expect((await getSession()).cues[0].videoTime).toBe(12);
  });
});

describe('transcription language', () => {
  const prepares = (runtimeMessages) => runtimeMessages
    .filter((m) => m.type === 'owl-offscreen-prepare')
    .map((m) => m.lang);
  const ready = async (lang) => sw.handleCaptureMessage({
    type: 'owl-native-speech-ready',
    lang,
    sessionToken: tokenFor(await getSession()),
  });

  // Chrome offers zh-HK as downloadable, then hangs on "downloading" forever while
  // it fetches the Simplified pack. It must never reach Chrome.
  it('starts a Hong Kong browser in Traditional Mandarin, never zh-HK', async () => {
    const { runtimeMessages } = stubTranscribeApis();
    chrome.i18n = { getUILanguage: () => 'zh-HK' };
    await armAndStart();
    expect(prepares(runtimeMessages)).toEqual(['zh-TW']);
  });

  it('reads a Simplified choice saved by an older version as Traditional Mandarin', async () => {
    const { runtimeMessages } = stubTranscribeApis();
    await chrome.storage.local.set({ 'owl:speechLang': 'zh-CN' });
    await armAndStart();
    expect(prepares(runtimeMessages)).toEqual(['zh-TW']);
  });

  // Starting in the ARMED language sent a reader who picked another one on the
  // setup page straight back to the setup page.
  it('starts in the language the setup page installed, not the one it was armed with', async () => {
    const { runtimeMessages } = stubTranscribeApis();
    await armViaLanguageDownload();
    await sw.handleCaptureMessage({ type: 'owl-transcribe-setup-complete', lang: 'zh-TW' });
    expect((await getSession()).lang).toBe('zh-TW');
    expect(prepares(runtimeMessages).at(-1)).toBe('zh-TW');
  });

  it('switches language mid-video and keeps what was already said', async () => {
    const { runtimeMessages, captured } = stubTranscribeApis();
    await armAndStart();
    await ready('en-US');
    await sw.handleCaptureMessage({ type: 'owl-cue', cues: [cue('said in English', 1000)] });

    await sw.handleCaptureMessage({ type: 'owl-panel-language', lang: 'zh-TW' });
    expect(prepares(runtimeMessages).at(-1)).toBe('zh-TW');
    await ready('zh-TW');

    const session = await getSession();
    expect(session).toMatchObject({ lang: 'zh-TW', state: 'recording' });
    expect(session.cues.map((c) => c.text)).toEqual(['said in English']);
    // The same tab is captured again on the original grant, with no second click.
    expect(captured).toEqual([{ targetTabId: 42 }, { targetTabId: 42 }]);
    expect((await chrome.storage.local.get('owl:speechLang'))['owl:speechLang']).toBe('zh-TW');
  });

  it('does not blank the captions while the switch checks the new language', async () => {
    const { overlayMessages } = stubTranscribeApis();
    await armAndStart();
    await ready('en-US');
    await sw.handleCaptureMessage({ type: 'owl-cue', cues: [cue('keep showing this', 1000)] });
    const before = overlayMessages.length;

    await sw.handleCaptureMessage({ type: 'owl-panel-language', lang: 'zh-TW' });
    await ready('zh-TW');

    const texts = overlayMessages.slice(before).map((m) => m.message.text).filter((t) => t !== undefined);
    expect(texts).toEqual([]);
  });

  it('offers the overlay only the languages this machine has installed', async () => {
    const { overlayMessages } = stubTranscribeApis();
    await armAndStart();
    await sw.handleCaptureMessage({ type: 'owl-native-speech-languages', languages: ['en-US', 'zh-TW'] });

    expect(overlayMessages.at(-1).message).toMatchObject({
      type: 'owl-overlay-update',
      lang: 'en-US',
      langName: 'English',
      languages: [
        { tag: 'en-US', name: 'English', label: 'English (United States)' },
        { tag: 'zh-TW', name: '中文', label: 'Chinese, Mandarin (Traditional)' },
      ],
    });
  });

  it('keeps the transcript when a switch lands on a language that needs a download', async () => {
    const { runtimeMessages, windows } = stubTranscribeApis();
    await armAndStart();
    await ready('en-US');
    await sw.handleCaptureMessage({ type: 'owl-cue', cues: [cue('worth keeping', 1000)] });
    await sw.handleCaptureMessage({ type: 'owl-panel-language', lang: 'zh-TW' });

    await sw.handleCaptureMessage({
      type: 'owl-native-speech-install-required',
      lang: 'zh-TW',
      sessionToken: tokenFor(await getSession()),
    });

    const session = await getSession();
    expect(session).toMatchObject({ state: 'recording', lang: 'en-US' });
    expect(session.cues.map((c) => c.text)).toEqual(['worth keeping']);
    expect(windows.at(-1).url).toContain('enable.html?lang=zh-TW');
    expect(prepares(runtimeMessages).at(-1)).toBe('en-US'); // carried on in English
  });

  it('adds a language beside the running capture and switches once it is installed', async () => {
    const { windows } = stubTranscribeApis();
    await armAndStart();
    await ready('en-US');
    await sw.handleCaptureMessage({ type: 'owl-cue', cues: [cue('first part', 1000)] });

    await sw.handleCaptureMessage({ type: 'owl-panel-add-language' });
    expect(windows.at(-1).url).toContain('enable.html?lang=en-US');
    expect((await getSession()).state).toBe('recording');

    await sw.handleCaptureMessage({ type: 'owl-transcribe-setup-complete', lang: 'ja-JP' });
    const session = await getSession();
    expect(session.lang).toBe('ja-JP');
    expect(session.cues.map((c) => c.text)).toEqual(['first part']);
  });
});

describe('YouTube subtitles', () => {
  const YT = { id: 77, windowId: 7, title: 'A Mandarin talk - YouTube', url: 'https://www.youtube.com/watch?v=abc' };
  const JSON3 = JSON.stringify({
    events: [
      { tStartMs: 120, dDurationMs: 600, segs: [{ utf8: '大家好 我參老' }] },
      { tStartMs: 720, dDurationMs: 1720, segs: [{ utf8: '今天來說一下新30年戰爭' }] },
      { tStartMs: 1180000, dDurationMs: 2000, segs: [{ utf8: '我們下次再見' }] },
    ],
  });
  const TRACKS = [{ baseUrl: 'https://www.youtube.com/api/timedtext?v=abc&lang=zh-Hant', languageCode: 'zh-Hant', kind: '', name: '中文（繁體字）' }];

  // Each page function answers as YouTube's page would.
  function youtubePage({ tracks = TRACKS, text = JSON3 } = {}) {
    const apis = stubTranscribeApis();
    const pageCalls = [];
    chrome.scripting.executeScript = async (opts) => {
      apis.injected.push(opts);
      if (!opts.func) return [{ result: undefined }];
      pageCalls.push({ name: opts.func.name, world: opts.world, args: opts.args });
      if (opts.func.name === 'youtubeSubtitleInfo') {
        return [{ result: { videoId: 'abc', tracks, defaultIndex: 0, playerUrl: 'https://www.youtube.com/api/timedtext?v=abc&lang=zh-Hant&pot=T&c=WEB' } }];
      }
      return [{ result: text }];
    };
    return { ...apis, pageCalls };
  }
  const transcribe = (tab = YT) => sw.handleTranscribe({ menuItemId: 'owl-transcribe-video', pageUrl: tab.url }, tab);
  const savedNotes = async () => {
    const root = await bm.ensureRoot();
    const notebook = (await bm.listNotebooks(root)).find((item) => item.title === 'Transcripts');
    return notebook ? Promise.all((await bm.listNotes(notebook.id)).map((n) => decode(n.payload))) : [];
  };

  it('saves the whole video from its subtitles, without listening to it', async () => {
    const { captured, runtimeMessages, pageCalls } = youtubePage();
    await transcribe();

    expect(pageCalls.map((c) => [c.name, c.world])).toEqual([
      ['youtubeSubtitleInfo', 'MAIN'],
      ['fetchPageText', 'MAIN'],
    ]);
    expect(pageCalls[1].args[0]).toContain('pot=T');
    const [note] = await savedNotes();
    expect(note.body).toContain('大家好 我參老 今天來說一下新30年戰爭');
    expect(note.body).toContain('## 15:00');
    expect(note.body.split('\n\n')[0]).toContain('· 19 min · YouTube subtitles: 中文（繁體字）');
    // Nothing captured, nothing prepared, no session left behind.
    expect(captured).toEqual([]);
    expect(runtimeMessages.filter((m) => m.type === 'owl-offscreen-prepare')).toEqual([]);
    expect(await getSession()).toBe(null);
  });

  it('leaves a live transcription running in another tab alone', async () => {
    youtubePage();
    await armAndStart();
    await sw.handleCaptureMessage({ type: 'owl-cue', cues: [cue('another tab, still going', 1000)] });

    await transcribe();

    expect(await getSession()).toMatchObject({ tabId: 42, state: 'recording' });
    expect((await getSession()).cues.map((c) => c.text)).toEqual(['another tab, still going']);
  });

  it('asks before listening when the video has no subtitles', async () => {
    const { captured, overlayMessages } = youtubePage({ tracks: [] });
    await transcribe();

    expect(captured).toEqual([]);
    expect(await getSession()).toBe(null);
    expect(await savedNotes()).toEqual([]);
    expect(overlayMessages.at(-1).message).toMatchObject({
      state: 'no subtitles',
      text: expect.stringContaining('no subtitles'),
      offerLive: true,
      armed: true,
    });

    await sw.handleCaptureMessage({ type: 'owl-panel-start-live' });
    expect(await getSession()).toMatchObject({ tabId: 77, state: 'recording', url: YT.url });
  });

  it('offers live transcription when the subtitles cannot be read', async () => {
    const { overlayMessages } = youtubePage({ text: '' });
    await transcribe();
    expect(await savedNotes()).toEqual([]);
    expect(overlayMessages.at(-1).message).toMatchObject({
      text: expect.stringContaining('could not be read'),
      offerLive: true,
    });
  });

  it('cancelling the question closes the overlay and captures nothing', async () => {
    const { captured, overlayMessages } = youtubePage({ tracks: [] });
    await transcribe();
    await sw.handleCaptureMessage({ type: 'owl-panel-cancel-arm' });
    expect(overlayMessages.at(-1).message).toEqual({ type: 'owl-overlay-close' });
    expect(await sw.handleCaptureMessage({ type: 'owl-panel-start-live' })).toBe(null);
    expect(captured).toEqual([]);
  });

  it('starts live at once on other sites, where there are no subtitles to read', async () => {
    const { pageCalls, runtimeMessages } = youtubePage();
    await armAndStart();
    expect(pageCalls).toEqual([]);
    expect(runtimeMessages.some((m) => m.type === 'owl-offscreen-prepare')).toBe(true);
  });
});

// Full mode reads the whole session back. The live overlay only ever receives a
// TAIL (one sealed block plus the open one), so anything older is unreachable
// from the pill — which is exactly what scrolling back has to recover.
describe('full-mode transcript history', () => {
  it('returns cues the live tail has already dropped', async () => {
    const { overlayMessages } = stubTranscribeApis();
    await armAndStart();
    await sw.handleCaptureMessage({
      type: 'owl-native-speech-ready',
      lang: 'en-US',
      sessionToken: tokenFor(await getSession()),
    });

    // Past two sealed blocks, so block 0 falls out of the tail entirely.
    const many = Array.from({ length: 401 }, (_, i) => cue(`line ${i}`, 1000 + i * 10));
    await sw.handleCaptureMessage({ type: 'owl-cue', cues: many });

    const tail = [...overlayMessages].reverse()
      .find((m) => m.message.type === 'owl-overlay-update' && typeof m.message.text === 'string');
    expect(tail.message.text).not.toContain('line 0 ');

    await sw.handleCaptureMessage({ type: 'owl-panel-history' });
    const history = [...overlayMessages].reverse()
      .find((m) => m.message.type === 'owl-overlay-history');
    expect(history).toBeTruthy();
    expect(history.tabId).toBe(TAB.id);
    expect(history.message.text).toContain('line 0');
    expect(history.message.text).toContain('line 400');
    expect(history.message.cueCount).toBe(401);
  });

  // The pill flattens newlines to keep three lines readable; full mode has the
  // room for the structure the saved note will carry.
  it('keeps paragraph and timestamp structure the pill flattens away', async () => {
    const { overlayMessages } = stubTranscribeApis();
    await armAndStart();
    await sw.handleCaptureMessage({
      type: 'owl-native-speech-ready',
      lang: 'en-US',
      sessionToken: tokenFor(await getSession()),
    });
    await sw.handleCaptureMessage({
      type: 'owl-cue',
      cues: [
        { text: 'opening remarks', videoTime: 0, at: 1000 },
        { text: 'much later on', videoTime: 600, at: 900000 },
      ],
    });

    await sw.handleCaptureMessage({ type: 'owl-panel-history' });
    const history = [...overlayMessages].reverse()
      .find((m) => m.message.type === 'owl-overlay-history');
    expect(history.message.text).toContain('\n\n'); // a real paragraph break
    expect(history.message.text).toMatch(/## \d+:\d\d/);
  });

  it('is a no-op when there is no session rather than throwing', async () => {
    stubTranscribeApis();
    await expect(sw.handleCaptureMessage({ type: 'owl-panel-history' })).resolves.toBeNull();
  });
});
