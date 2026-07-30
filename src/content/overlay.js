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
      <div class="text" id="text">Starting…</div>
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
  };
  let armedMode = true;

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

  function render({ text, state, canSave, armed }) {
    if (typeof text === 'string') {
      const trimmed = text.length > MAX_CHARS ? text.slice(-MAX_CHARS) : text;
      // Dim everything but the newest sentence, the way Live Caption does.
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
    if (state) {
      els.state.textContent = state;
      els.dot.classList.toggle('idle', state !== 'listening');
    }
    if (typeof canSave === 'boolean') els.save.hidden = !canSave;
    if (typeof armed === 'boolean') {
      armedMode = armed;
      els.stop.textContent = armed ? 'Cancel' : 'Discard';
    }
  }

  // Fullscreen puts a different element on top of everything; the bubble has to
  // move into it or it vanishes exactly when the video gets most watchable.
  function attach() {
    const parent = document.fullscreenElement || document.body;
    if (host.parentNode !== parent) parent.append(host);
  }
  document.addEventListener('fullscreenchange', attach);

  function detach() {
    clearInterval(timer);
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
