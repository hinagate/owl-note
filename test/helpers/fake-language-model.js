// Configurable in-memory fake of the browser Prompt API's global
// `LanguageModel`, mirrored on `test/helpers/fake-chrome.js`. It implements ONLY
// the methods builtin.js actually calls (YAGNI): `availability()`, `create()`,
// and on the returned session `prompt()`, `destroy()`, and optional
// `measureInputUsage()`. `installFakeLanguageModel(config)` sets
// `globalThis.LanguageModel` and returns handles for assertions plus an
// `uninstall()` — tests MUST call uninstall in afterEach so the global never
// leaks into unrelated suites.

// A DOMException-shaped AbortError, matching what a real `session.prompt`
// rejects with when its AbortSignal is aborted. jsdom provides DOMException.
function makeAbortError() {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('The operation was aborted.', 'AbortError');
  }
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

// A valid ANSWER_SCHEMA-shaped JSON string, used as the default `prompt` result.
const DEFAULT_PROMPT_RESULT = JSON.stringify({ answer: 'ok', citations: [], grounded: true });

/**
 * @param {Object} [config]
 * @param {string} [config.availability]      What availability() resolves to (default 'available').
 * @param {string|((input:string, opts:any)=>string)} [config.promptResult]
 *        The session.prompt result, or a function computing it (default valid JSON).
 * @param {Error|boolean} [config.promptThrows]   Make session.prompt reject.
 * @param {boolean} [config.availabilityThrows]   Make availability() reject.
 * @param {Error|boolean} [config.createThrows]   Make create() reject.
 * @param {number[]} [config.downloadProgress]    0..1 values the monitor emits during create().
 * @param {number} [config.measureInputUsage]     If set, sessions expose measureInputUsage() -> this.
 */
export function installFakeLanguageModel(config = {}) {
  const {
    availability = 'available',
    promptResult = DEFAULT_PROMPT_RESULT,
    promptThrows,
    availabilityThrows,
    createThrows,
    downloadProgress,
    measureInputUsage,
  } = config;

  const handles = {
    availabilityCalls: 0,
    createCalls: [], // options objects passed to create()
    sessions: [], // every session create() handed out
    get lastSession() {
      return this.sessions[this.sessions.length - 1];
    },
  };

  function makeSession() {
    const session = {
      promptCalls: [], // { input, opts }
      measureCalls: [], // inputs passed to measureInputUsage
      destroyCount: 0,
      async prompt(input, opts = {}) {
        session.promptCalls.push({ input, opts });
        // Abort takes precedence: a real session rejects when its signal is
        // already aborted, so builtin.js can map it to AskError('aborted').
        if (opts.signal && opts.signal.aborted) throw makeAbortError();
        if (promptThrows) {
          throw promptThrows instanceof Error ? promptThrows : new Error('prompt failed');
        }
        return typeof promptResult === 'function' ? promptResult(input, opts) : promptResult;
      },
      // destroy() is a spy so tests can assert destroy-in-finally on every path.
      destroy() {
        session.destroyCount += 1;
      },
    };
    // measureInputUsage is OPTIONAL on the real API; only expose it when the
    // test opts in, so builtin.js's feature-detect can be exercised both ways.
    if (measureInputUsage !== undefined) {
      session.measureInputUsage = async (input) => {
        session.measureCalls.push(input);
        return measureInputUsage;
      };
    }
    handles.sessions.push(session);
    return session;
  }

  const LanguageModel = {
    async availability() {
      handles.availabilityCalls += 1;
      if (availabilityThrows) throw new Error('availability failed');
      return availability;
    },
    async create(options = {}) {
      handles.createCalls.push(options);
      if (createThrows) {
        throw createThrows instanceof Error ? createThrows : new Error('create failed');
      }
      // Drive download progress through the monitor exactly as the real API
      // does: create({ monitor(m){ m.addEventListener('downloadprogress', ...) } }).
      if (typeof options.monitor === 'function' && Array.isArray(downloadProgress)) {
        const listeners = [];
        const m = { addEventListener: (type, fn) => type === 'downloadprogress' && listeners.push(fn) };
        options.monitor(m);
        for (const loaded of downloadProgress) {
          listeners.forEach((fn) => fn({ loaded }));
        }
      }
      return makeSession();
    },
  };

  const had = 'LanguageModel' in globalThis;
  const prev = globalThis.LanguageModel;
  globalThis.LanguageModel = LanguageModel;

  handles.LanguageModel = LanguageModel;
  handles.uninstall = () => {
    // Restore exactly what was there before (usually nothing) — a leaked fake
    // global would corrupt other suites.
    if (had) globalThis.LanguageModel = prev;
    else delete globalThis.LanguageModel;
  };

  return handles;
}

/**
 * Ensure no Prompt API global is present — used to test the missing-global path
 * (availability -> 'unavailable', answer -> AskError('unavailable')).
 * @returns {() => void} restore function
 */
export function uninstallLanguageModel() {
  const had = 'LanguageModel' in globalThis;
  const prev = globalThis.LanguageModel;
  delete globalThis.LanguageModel;
  return () => {
    if (had) globalThis.LanguageModel = prev;
  };
}
