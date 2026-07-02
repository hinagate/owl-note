# OWL-Note privacy policy

_Last updated: 2026-07-02_

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

## "Ask your notes"

Search runs entirely on-device (no note data leaves the browser to find matches).
When an answer is generated, it's produced by your **browser's built-in,
on-device AI** — Gemini Nano on Chrome, Phi on Edge. Your question and the
matching note excerpts are processed **on your device** and are **not** sent to
Anthropic, Google, Microsoft, or any other external service.

The on-device model is downloaded once by the browser itself (shared across
sites/extensions that use it), and only after you explicitly opt in from the Ask
panel. No note data is included in that download.

*Not part of this version:* a "bring your own API key" option to use a cloud AI
service is not shipped in this build. If it's added later, it will clearly warn
you before anything is sent off-device.

## Optional Google Drive sync

Turn on the Google Drive sync toggle (off by default) and OWL-Note additionally
stores image/file attachments and any note too large to fit in a bookmark in an
`OWL-Note Sync` folder in **your own** Google Drive. This uses Google's
`drive.file` scope, so OWL-Note can only see files it created — never the rest
of your Drive. It's keyed to your Google account, and we never see it.

## Permissions

`bookmarks` (to store and read your notes), `storage` (for the local backup),
`contextMenus` (for "Save selection to OWL-Note"), and `identity` (only used to
sign in to your own Google account if you turn on Drive sync). Host access to
Google's APIs is optional and only requested when you enable Drive sync.

## No analytics

No analytics, no telemetry, no tracking — we don't collect usage data of any
kind.
