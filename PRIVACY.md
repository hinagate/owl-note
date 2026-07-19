# OWL-Note privacy policy

_Last updated: 2026-07-19_

OWL-Note stores your notes **as bookmarks in your own browser**. A note's text
is compressed and placed inside the bookmark's URL. A local backup copy is kept
in the extension's `chrome.storage.local` on each device.

- **We do not run any server.** Your notes never leave your browser through us.
- **Syncing** happens only via *your own* Chrome Sync / Microsoft account, under
  that provider's terms — we never receive your data.
- **Local file links** are stored as text only; the extension never reads file
  contents.
- **Cross-device:** your notes appear on another computer only after you install
  OWL-Note there too — the synced bookmark needs this extension installed to open it.

## What data OWL-Note handles

Even though everything is processed locally, we disclose it plainly. OWL-Note
handles only:

- **Your note content** (titles, body text, attachments you add, web content
  you explicitly select, and full-page images you explicitly capture) — stored
  in your browser's bookmarks and its local backup, and, if you turn on Drive
  sync, in your own Google Drive. Never sent to us.
- **A Google sign-in token** — only if you turn on Drive sync, only to access the
  files OWL-Note created in your own Drive (see below). Never sent to us.

We collect **no** analytics, telemetry, usage data, browsing history, or personal
identifiers of any kind, and we transfer your data to no one.

## "Ask Owl" — asking your notes

Search runs entirely on-device (no note data leaves the browser to find matches).
When an answer is generated, it's produced by your **browser's built-in,
on-device AI** — Gemini Nano on Chrome, Phi on Edge. Your question and the
matching note excerpts are processed **on your device** and are **not** sent to
Anthropic, Google, Microsoft, or any other external service.

The on-device answer model is downloaded once by the browser itself (shared
across sites/extensions that use it), and only after you explicitly opt in from
the Ask panel. No note data is included in that download.

### Optional semantic search (one-time model download)

If you turn on the semantic index (off by default; a single opt-in button in the
Ask panel), OWL-Note downloads a small open-source embedding model
(`multilingual-e5-small`, ~130 MB) **once** from Hugging Face (`huggingface.co`
and its content-delivery network), then caches it in your browser and runs it
entirely on-device from then on.

This is a plain, one-time download of **model data** — like downloading an image
or a font file. It contains **none of your notes and none of your questions**,
and nothing about you is sent to Hugging Face beyond the ordinary network request
needed to fetch the file. After this download, semantic search works fully
offline.

*Not part of this version:* a "bring your own API key" option to use a cloud AI
service is not shipped in this build. If it's added later, it will clearly warn
you before anything is sent off-device.

## Optional Google Drive sync

Turn on the Google Drive sync toggle (off by default) and OWL-Note additionally
stores image/file attachments and any note too large to fit in a bookmark in an
`OWL-Note Sync` folder in **your own** Google Drive. This uses Google's
`drive.file` scope, so OWL-Note can only see files it created — never the rest
of your Drive. It's keyed to your Google account, and we never see it.

OWL-Note's use of information received from Google APIs adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements.

## Explicit export and sharing

- **Share with PDF** creates the PDF entirely on your device and opens the
  operating system's share panel. OWL-Note does not send it anywhere; it leaves
  the device only if you choose a share target, whose own privacy terms then
  apply.
- **Create Drive share link** is available only when Drive sync is enabled. After
  you confirm the warning, OWL-Note uploads a PDF copy to your own Google Drive
  and makes that one file readable by anyone who has its link. You can revoke
  access or delete the file in Google Drive at any time.
- Download and `.owl-note` export create local files only.

## Permissions

- `bookmarks` — to store and read your notes.
- `storage` and `unlimitedStorage` — for the local backup copy of your notes and
  the cached on-device semantic-search model.
- `contextMenus` — for the "Save selection to OWL-Note" and "Capture full page
  to OWL-Note" right-click items.
- `activeTab` and `scripting` — only after you click one of those right-click
  items. Selection capture reads the selected fragment's formatting and converts
  it to Markdown. Full-page capture temporarily measures and scrolls that page,
  captures its visible tiles with Chrome's screenshot API, stitches them locally,
  and restores the original scroll position. OWL-Note does not receive persistent
  page access or access pages you did not explicitly capture from.
- `identity` — only used to sign in to your own Google account if you turn on
  Drive sync.

Host access to Google's APIs is **optional** and only requested when you enable
Drive sync.

## Changes to this policy

If OWL-Note ever changes how it handles your data, we'll update this policy and
the Chrome Web Store listing's privacy disclosures before the change ships, and
note it here with a new date above.

## Contact

Questions about privacy? Open an issue at
<https://github.com/hinagate/owl-note/issues>.
