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

### 📖 The Story

I built **OWL‑Note** from a simple belief: **people have the right to take notes for free.**

Writing down thoughts is natural; it shouldn’t be over‑engineered or locked behind subscriptions.

So I set one constraint: **use only infrastructure people already have** and make the simplest, most private note app possible. That constraint shaped every design choice:

- Notes live as **browser bookmarks** — private, portable, and **synced automatically** by the Chrome or Edge account you already use.
- When a note exceeds bookmark limits, an **optional Google Drive** layer stores the overflow.
- AI features run **entirely on the browser’s on‑device model** — no servers, no API keys, no per‑question billing.

Every constraint made OWL‑Note lighter and more personal. It isn’t a cloud platform — it’s a notebook you actually own.

---

### 🦉 Overview

**OWL‑Note** is a local‑first Markdown notebook. Notes are stored in your browser bookmarks and sync across devices via Chrome or Edge. It supports photos, attachments, semantic search, on‑device AI, and full LLM chat reconstruction.

---

### ✨ Features

**Rebuild LLM Chats as Markdown**

Right‑click → **Rebuild LLM chat to OWL‑Note**

Convert ChatGPT, Claude, Gemini and similar conversations into clean, editable Markdown (not screenshots). Preserves:

- **User and assistant messages**
- **Headings, paragraphs, lists, links**
- **Tables**
- **Syntax‑highlighted code blocks**
- **KaTeX math**
- **Supported images as attachments**
- **Original source URL**

**Deterministic. Local‑only.** No API key, no tokens, no cloud conversion.

**Capture Entire Page**

Right‑click → **Capture entire page to OWL‑Note**

Scrolls and stitches the full page (including below the fold) into a single long image. Ideal for long articles, docs, receipts, dashboards, and complex layouts. All processing happens locally.

**Live Transcription save to OWL‑Note**

Right-click → **Live Transcription save to OWL‑Note**

Turn a playing tab's speech into a Markdown note with a draggable live-caption overlay. Right-click **Live Transcription save to OWL‑Note** to start — one right-click, first session included. Chrome 139+ uses its native on-device speech engine; the first session in a language pauses for a one-click confirmation while Chrome downloads that language's local model, then resumes on its own. Audio is never uploaded or stored, and OWL‑Note never falls back to cloud transcription.

**Smart Selection Capture**

Right‑click → **Save selection to OWL‑Note**

Save a selected region as structured Markdown while preserving headings, emphasis, lists, links, code blocks, tables, and supported visuals. The new note opens immediately for editing.

**Markdown Notebook**

- Live Markdown preview
- Automatic saving
- Code syntax highlighting
- KaTeX math
- Photos and file attachments
- Draggable image preview
- Nested notebooks and multi‑select organization
- Trash and permanent deletion
- Search (including from the browser address bar)
- Import: Word / Evernote / Markdown
- Export: Markdown / PDF / portable .owl‑note package

**Ask Owl Local Retrieval and AI**

Ask natural‑language questions and get answers grounded in your notes, with citations.

- Conversational Q&A and follow‑ups
- Keyword and optional semantic search
- One‑click summarization
- Deterministic Markdown tidying (no rewriting)
- AI title suggestions
- Chinese / Japanese / Korean support

Uses the browser’s built‑in on‑device model where available; retrieval still works without a local model.

---

### 🔒 Privacy and Sync

- **Notes stored in browser bookmarks** for privacy and portability.
- **Synced across devices** via your Chrome or Edge account — no new account required.
- **No OWL‑Note account, no backend, no telemetry, no ads.**
- All AI, capture, and semantic search operations run locally.
- Manifest V3 extension.
- Optional Google Drive support (off by default) for large notes and attachments.
- Open source under **GPL‑3.0**.

---

### 📦 Installation Import Export

**Installation**

Works with Chrome, Edge, and other Chromium‑based browsers. See Releases or the extension store listing for installation.

**Import**

- Markdown
- Markdown ZIP
- JSON backups
- Evernote ENEX
- Word DOCX
- .owl‑note packages

**Export**

- Plain Markdown
- Markdown ZIP
- JSON backups
- PDF
- .owl‑note portable packages

---

### 🆓 License

**GPL‑3.0**

Source code: **[https://github.com/hinagate/owl-note](https://github.com/hinagate/owl-note)**

#### Pronunciation data

The phonetic reading tables are generated at build time from third‑party dictionaries and
shipped as data files. They are not part of the program's source code, and each keeps its
own licence:

| Table | Source | Licence |
| --- | --- | --- |
| `ipa-en.tsv.gz` — English IPA | [CMU Pronouncing Dictionary](https://github.com/cmusphinx/cmudict) (Carnegie Mellon University) | ISC |
| `kana-ja.tsv.gz` — Japanese kanji readings | [yomi-dict](https://github.com/marmooo/yomi-dict) | Apache‑2.0 |
| `pinyin-zh.tsv.gz` — Mandarin pinyin | [CC‑CEDICT](https://www.mdbg.net/chinese/dictionary?page=cc-cedict), via [cedict-json](https://github.com/matt-tingen/cedict-json) | CC BY‑SA 4.0 |

`pinyin-zh.tsv.gz` is a derivative of CC‑CEDICT and is therefore itself distributed under
[CC BY‑SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
