// The caption overlay, injected into the watched page. Deliberately modelled on
// Chrome's own Live Caption bubble: a small dark pill floating over the video
// that you read without looking away, rather than a panel that resizes the page
// and changes how the video is watched.
//
// Everything lives in a CLOSED shadow root — site CSS cannot reach in, and the
// page cannot read our text out. The host element is position:fixed and never
// participates in page layout, so nothing on the page moves because we exist.
//
// This file is an esbuild ENTRY (iife), injected with chrome.scripting.

(() => {
  if (window.__owlOverlay) {
    window.__owlOverlay.show();
    return;
  }

  const MAX_CHARS = 220; // roughly three lines; older text scrolls out of view
  const HEARTBEAT_MS = 1000;
  const HISTORY_REFRESH_MS = 700; // coalesce full-mode refreshes while following live
  const SCROLL_PIN_PX = 24;       // this close to the bottom still counts as following

  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;inset:auto;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .bubble {
        position: fixed;
        left: 50%;
        bottom: 12%;
        transform: translateX(-50%);
        width: min(640px, 78vw);
        box-sizing: border-box;
        padding: 12px 16px;
        border-radius: 14px;
        background: rgba(32, 33, 36, .92);
        color: #e8eaed;
        font: 400 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        box-shadow: 0 6px 24px rgba(0, 0, 0, .45);
        backdrop-filter: blur(6px);
        cursor: grab;
        user-select: none;
        transition: opacity .2s ease;
      }
      .bubble.dragging { cursor: grabbing; }
      .text {
        display: -webkit-box;
        -webkit-line-clamp: 3;
        -webkit-box-orient: vertical;
        overflow: hidden;
        min-height: 1.55em;
        overflow-wrap: anywhere;
      }
      .text .old { color: #9aa0a6; }

      /* Full mode: the same bubble grown into a readable, scrollable transcript.
         Not a separate surface — it keeps its drag position and its controls. */
      .bubble.full { width: min(860px, 92vw); cursor: default; }
      .bubble.full .text {
        display: block;
        max-height: min(56vh, 520px);
        overflow-y: auto;
        padding-right: 6px;
        /* Reading back means selecting and copying; the compact pill does not. */
        user-select: text;
        cursor: auto;
        overscroll-behavior: contain; /* scrolling the transcript must not scroll the page */
        /* The default scrollbar is a bright slab against a near-black bubble. */
        scrollbar-width: thin;
        scrollbar-color: rgba(255, 255, 255, .3) transparent;
      }
      .bubble.full .text::-webkit-scrollbar { width: 8px; }
      .bubble.full .text::-webkit-scrollbar-track { background: transparent; }
      .bubble.full .text::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, .3);
        border-radius: 4px;
      }
      .bubble.full .text::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, .45); }
      .bubble.full .text p { margin: 0 0 .7em; }
      .bubble.full .text p:last-child { margin-bottom: 0; }
      .bubble.full .text h4 {
        margin: 1.1em 0 .45em;
        font: 600 12px/1.4 inherit;
        letter-spacing: .06em;
        color: #8ab4f8;
      }
      .bubble.full .text h4:first-child { margin-top: 0; }
      .bubble.full .text .live { color: #fff; }
      .bubble.full .text .empty { color: #9aa0a6; }

      /* Top-right controls sit above the text in both modes, so the affordance
         to expand is visible without hovering (unlike the .meta row).
         A real layout row, not an absolute overlay — absolutely positioned it
         printed straight on top of the first line of captions. */
      .corner {
        display: flex;
        justify-content: flex-end;
        gap: 6px;
        margin-bottom: 5px;
      }
      /* Icon-only, so it reads as a corner affordance rather than a label. */
      .corner button {
        width: 22px;
        height: 22px;
        padding: 0;
        border-radius: 6px;
        font-size: 13px;
        line-height: 22px;
        text-align: center;
        opacity: .65;
      }
      .corner button:hover { opacity: 1; }
      /* Pinned to the newest line, the transcript follows along; scrolled back,
         it holds still and offers a way to return. */
      .jump {
        position: absolute;
        left: 50%;
        bottom: 46px;
        transform: translateX(-50%);
        display: none;
        white-space: nowrap;
      }
      .bubble.full .jump.show { display: block; }
      .meta {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 8px;
        font-size: 12px;
        color: #9aa0a6;
        opacity: 0;
        transition: opacity .15s ease;
      }
      .bubble:hover .meta { opacity: 1; }
      /* Full mode is read, not glanced at — the controls stay put rather than
         fading out from under a pointer that has moved into the transcript. */
      .bubble.full .meta { opacity: 1; }
      .spacer { flex: 1; }
      button {
        font: inherit;
        color: #e8eaed;
        background: rgba(255, 255, 255, .12);
        border: 0;
        border-radius: 999px;
        padding: 4px 12px;
        cursor: pointer;
      }
      button:hover { background: rgba(255, 255, 255, .22); }
      button.save { background: #2dbe60; color: #04150a; font-weight: 600; }
      .dot {
        width: 8px; height: 8px; border-radius: 50%;
        background: #ea4335; flex: none;
        animation: pulse 1.6s ease-in-out infinite;
      }
      .dot.idle { background: #9aa0a6; animation: none; }
      @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .25; } }
    </style>
    <div class="bubble" part="bubble">
      <div class="corner">
        <button id="full" title="Full mode — scroll back through what was said" aria-label="Full mode">⤢</button>
      </div>
      <div class="text" id="text">Starting…</div>
      <button id="jump" class="jump">↓ Live</button>
      <div class="meta">
        <span class="dot" id="dot"></span>
        <span id="state">listening</span>
        <span class="spacer"></span>
        <button id="save" class="save" hidden>Save note</button>
        <button id="stop">Cancel</button>
      </div>
    </div>
  `;

  const bubble = root.querySelector('.bubble');
  const els = {
    text: root.getElementById('text'),
    state: root.getElementById('state'),
    dot: root.getElementById('dot'),
    save: root.getElementById('save'),
    stop: root.getElementById('stop'),
    full: root.getElementById('full'),
    jump: root.getElementById('jump'),
  };
  let armedMode = true;
  let fullMode = false;
  let liveText = '';     // the tail the worker pushes on every cue
  let historyText = '';  // the whole session, pulled on demand in full mode
  let historyCues = 0;
  let liveState = 'listening';
  let pinned = true;     // following the newest line rather than reading back
  let historyPending = 0;

  function send(message) {
    try { chrome.runtime.sendMessage(message); } catch { detach(); }
  }

  root.getElementById('save').addEventListener('click', () => send({ type: 'owl-panel-save' }));
  root.getElementById('stop').addEventListener('click', () => send({
    type: armedMode ? 'owl-panel-cancel-arm' : 'owl-panel-discard',
  }));

  // Drag to move: captions sit where the user wants them, not where we guessed.
  let drag = null;
  bubble.addEventListener('pointerdown', (e) => {
    if (e.target.tagName === 'BUTTON') return;
    // In full mode the transcript is a scroll-and-select surface, so a drag
    // started inside it would fight both. The frame around it still drags.
    if (fullMode && els.text.contains(e.target)) return;
    const rect = bubble.getBoundingClientRect();
    drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    bubble.classList.add('dragging');
    bubble.setPointerCapture(e.pointerId);
  });
  bubble.addEventListener('pointermove', (e) => {
    if (!drag) return;
    bubble.style.left = `${e.clientX - drag.dx}px`;
    bubble.style.top = `${e.clientY - drag.dy}px`;
    bubble.style.bottom = 'auto';
    bubble.style.transform = 'none';
  });
  bubble.addEventListener('pointerup', () => { drag = null; bubble.classList.remove('dragging'); });

  // The compact pill: a clamped tail with everything but the newest sentence
  // dimmed, the way Live Caption does it.
  function renderCompact() {
    const trimmed = liveText.length > MAX_CHARS ? liveText.slice(-MAX_CHARS) : liveText;
    const split = Math.max(trimmed.lastIndexOf('. '), trimmed.lastIndexOf('。'));
    els.text.replaceChildren();
    if (split > 0) {
      const old = document.createElement('span');
      old.className = 'old';
      old.textContent = `${trimmed.slice(0, split + 1)} `;
      els.text.append(old);
    }
    els.text.append(document.createTextNode(split > 0 ? trimmed.slice(split + 2) : trimmed));
  }

  // Full mode: the session's markdown as paragraphs and `## mm:ss` headings.
  // Built with textContent throughout — this is recognized speech from an
  // arbitrary page, and it never becomes markup.
  function renderFull() {
    const body = historyText || liveText;
    els.text.replaceChildren();
    if (!body.trim()) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Nothing transcribed yet.';
      els.text.append(empty);
      return;
    }
    const blocks = body.split('\n\n');
    blocks.forEach((block, i) => {
      const heading = /^##\s+(.*)$/.exec(block.trim());
      if (heading) {
        const h = document.createElement('h4');
        h.textContent = heading[1];
        els.text.append(h);
        return;
      }
      const p = document.createElement('p');
      if (i === blocks.length - 1) p.className = 'live'; // the newest paragraph
      p.textContent = block;
      els.text.append(p);
    });
  }

  function paint() {
    const atBottom = pinned;
    if (fullMode) renderFull(); else renderCompact();
    if (fullMode && atBottom) els.text.scrollTop = els.text.scrollHeight;
  }

  function render({ text, state, canSave, armed }) {
    if (typeof text === 'string') {
      liveText = text;
      if (fullMode && pinned) requestHistory();
      paint();
    }
    if (state) {
      liveState = state;
      els.dot.classList.toggle('idle', state !== 'listening');
    }
    // In full mode the line count says at a glance whether there is anything
    // older to scroll back to — the pill alone cannot tell you that.
    els.state.textContent = fullMode && historyCues
      ? `${liveState} · ${historyCues} lines`
      : liveState;
    if (typeof canSave === 'boolean') els.save.hidden = !canSave;
    if (typeof armed === 'boolean') {
      armedMode = armed;
      els.stop.textContent = armed ? 'Cancel' : 'Discard';
    }
  }

  /* ----------------------------------------------------------- full mode */

  // Coalesced: cues arrive several times a second, and each refresh re-reads the
  // whole session. One in-flight request at a time is plenty to look live.
  function requestHistory() {
    if (historyPending) return;
    historyPending = setTimeout(() => {
      historyPending = 0;
      send({ type: 'owl-panel-history' });
    }, HISTORY_REFRESH_MS);
  }

  function setFullMode(next) {
    fullMode = next;
    bubble.classList.toggle('full', fullMode);
    // Icon only — the label lives in the tooltip, so the pill stays a pill.
    els.full.textContent = fullMode ? '⤡' : '⤢';
    els.full.title = fullMode
      ? 'Compact mode — back to the caption pill'
      : 'Full mode — scroll back through what was said';
    els.full.setAttribute('aria-label', fullMode ? 'Compact mode' : 'Full mode');
    if (fullMode) {
      pinned = true;
      send({ type: 'owl-panel-history' }); // first read is immediate, not throttled
      paint();
      fitOnScreen();
    } else {
      els.jump.classList.remove('show');
      paint();
    }
    els.state.textContent = fullMode && historyCues ? `${liveState} · ${historyCues} lines` : liveState;
  }

  // Growing a bubble the user dragged low can push it off the bottom. Nudge it
  // back into view rather than letting the controls become unreachable.
  function fitOnScreen() {
    const rect = bubble.getBoundingClientRect();
    const overflow = rect.bottom - (window.innerHeight - 8);
    if (overflow > 0 && bubble.style.top) {
      bubble.style.top = `${Math.max(8, parseFloat(bubble.style.top) - overflow)}px`;
    }
  }

  els.full.addEventListener('click', () => setFullMode(!fullMode));
  els.jump.addEventListener('click', () => {
    pinned = true;
    els.jump.classList.remove('show');
    els.text.scrollTop = els.text.scrollHeight;
  });

  // Scrolling away from the bottom means "I am reading" — stop moving the text
  // under them, and offer the way back.
  els.text.addEventListener('scroll', () => {
    if (!fullMode) return;
    const distance = els.text.scrollHeight - els.text.scrollTop - els.text.clientHeight;
    pinned = distance <= SCROLL_PIN_PX;
    els.jump.classList.toggle('show', !pinned);
  });

  // Fullscreen puts a different element on top of everything; the bubble has to
  // move into it or it vanishes exactly when the video gets most watchable.
  function attach() {
    const parent = document.fullscreenElement || document.body;
    if (host.parentNode !== parent) parent.append(host);
  }
  document.addEventListener('fullscreenchange', attach);

  function detach() {
    clearInterval(timer);
    clearTimeout(historyPending);
    document.removeEventListener('fullscreenchange', attach);
    host.remove();
    window.__owlOverlay = null;
  }

  // The biggest playing <video>, so `## mm:ss` headings point into the video
  // rather than at wall-clock time.
  function videoTime() {
    const videos = [...document.querySelectorAll('video')]
      .filter((v) => v.readyState > 0)
      .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
    const v = videos[0];
    return v && Number.isFinite(v.currentTime) ? v.currentTime : null;
  }

  const timer = setInterval(() => send({ type: 'owl-video-time', videoTime: videoTime() }), HEARTBEAT_MS);

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'owl-overlay-update') render(msg);
    if (msg.type === 'owl-overlay-history') {
      historyText = String(msg.text || '');
      historyCues = Number(msg.cueCount) || 0;
      if (fullMode) paint();
    }
    if (msg.type === 'owl-overlay-close') detach();
  });

  // A navigation revokes activeTab, so the worker can no longer reach or redraw
  // this bubble — anything it still says is frozen and wrong. Remove it here
  // while the page can still act (including when Chrome keeps it in BFCache)
  // rather than leaving stale state pinned over the new document.
  window.addEventListener('pagehide', () => {
    send({ type: 'owl-capture-paused' });
    detach();
  });

  window.__owlOverlay = { show: attach, hide: detach };
  attach();
  send({ type: 'owl-overlay-ready', videoTime: videoTime() });
})();
