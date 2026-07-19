<div align="center">

# 🦉 OWL-Note

### Your notes are browser bookmarks. Your AI runs on your device.

Free, private Markdown notes — with code and math — synced by your own browser account. No server, no account, no subscription. A lightweight alternative to Evernote.

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/hjkbpgkmiaeojfhkpnhmokgjipenhcfl?label=Chrome%20Web%20Store&logo=googlechrome&logoColor=white&color=2dbe60)](https://chromewebstore.google.com/detail/hjkbpgkmiaeojfhkpnhmokgjipenhcfl)
[![Users](https://img.shields.io/chrome-web-store/users/hjkbpgkmiaeojfhkpnhmokgjipenhcfl?color=2dbe60)](https://chromewebstore.google.com/detail/hjkbpgkmiaeojfhkpnhmokgjipenhcfl)
[![License: GPLv3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/hinagate/owl-note?style=social)](https://github.com/hinagate/owl-note)

#### [➜ Add to Chrome / Edge — free](https://chromewebstore.google.com/detail/hjkbpgkmiaeojfhkpnhmokgjipenhcfl)

<img src="assets/ask-owl.gif" alt="Ask Owl demo: asking a question in the Ask Owl panel — the on-device semantic index searches every note and answers from the right recipe note, with a citation that jumps to it" width="820">

<img src="assets/screenshot.png" alt="OWL-Note editor showing the welcome note in Markdown beside its live rendered preview, with notebooks and note tools" width="820">

</div>

---


## The story

I built this because of a simple belief: **human beings are born with the right to take notes for free.** Recording your thoughts is a natural act; it shouldn't be over-engineered, and it shouldn't sit behind a paywall.

So I set myself one constraint: build the simplest note app I could, using only infrastructure people already own. Every wall I hit turned into a design decision. Notes became browser bookmarks — personal, private, and synced for free by the account you already have. When a note outgrew what a bookmark can sync, an optional Google Drive layer caught the overflow. And when I wanted AI, I refused to route your notes through a server or bill you per question, so it runs entirely on the model your browser now ships. Constraints all the way down — and every one of them made OWL-Note lighter.

## Features

- **Notes are bookmarks** — they sync across your devices for free through your existing account, and because they're real bookmarks you can find them straight from the browser address bar.
- **Powerful Markdown** — live preview, syntax-highlighted code blocks, and KaTeX math (inline `$…$` and display `$$…$$`).
- **Ask Owl** — ask a question in plain language and get answers from your own notes and nothing else, with citations that jump to the source. On-device generation via Gemini Nano (Chrome) or Microsoft Phi (Edge); on devices without built-in browser AI, Ask runs in retrieval-only mode.
- **Hybrid search** — an always-on keyword index, plus an optional on-device semantic layer (a one-time ~130 MB model) that matches "what do I pay for housing?" to a note that only says "rent: $1,400." Recall on paraphrased questions went 0.455 → 1.000 ([measured, not vibes](eval/RESULTS.md)).
- **One-click note tools** — Summarize the open note, Tidy its Markdown (deterministic — it never rewrites your words), or suggest a title.
- **Import & export, no lock-in** — bring in Word (`.docx`), Evernote (`.enex`), and Markdown; export everything to a zip of plain `.md` files anytime.
- **Capture, organize, and recover** — right-click a page to capture its full length directly into a note, or save a selected fragment with headings, lists, links, code, and emphasis preserved. Includes nested notebooks, multi-select bulk actions, Trash recovery, and image/file attachments.
- **Private by design** — no server, no telemetry, no account; Manifest V3 with minimal permissions. Auto-save with a compressed local backup on every device. Optional Google Drive sync (off by default) parks oversized notes and attachments in an "OWL-Note Sync" folder in your own Drive. ([Full privacy policy](PRIVACY.md))

## Install

1. Install **OWL-Note** from the [Chrome Web Store](https://chromewebstore.google.com/detail/hjkbpgkmiaeojfhkpnhmokgjipenhcfl).
2. Pin the extension (optional but recommended).
3. Click the icon and start writing.

Works on Chrome, Edge, and other Chromium browsers. On Edge, first enable "Allow extensions from other stores" in `edge://extensions`.

## How it works

OWL-Note doesn't invent its own storage. You write clean Markdown; the note is compressed and saved as a bookmark in a dedicated folder; your browser's built-in account sync replicates it to your signed-in devices; and a local backup is kept on each. Ask Owl's whole AI stack — generation and semantic search — runs on-device, with no keys, no server, and no per-question cost, so it keeps working offline. Deep dive in [ARCHITECTURE.md](ARCHITECTURE.md).

## For developers

```bash
npm install
npm test
npm run build
```

Load the `dist/` folder as an unpacked extension at `chrome://extensions` (or `edge://extensions`).

Notes reference `chrome-extension://<ID>/…`, so the extension ID should stay consistent across installs; if it changes, the app self-heals note URLs on launch. `tools/sync-probe` measures the real bookmark-sync ceiling on your own devices.

---

<div align="center">

Because your notes should belong to you, not the other way around.

[ARCHITECTURE.md](ARCHITECTURE.md) · [PRIVACY.md](PRIVACY.md) · [eval/RESULTS.md](eval/RESULTS.md)

</div>
