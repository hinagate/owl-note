// [Task E18] The first-run Welcome note. A brand-new install has no notes, so the
// open-latest-note boot flow lands on a blank editor. app.js creates ONE ordinary note
// from this content on first run so the landing always shows something — and doubles as
// a live demo of the Markdown/code/math renderer and a pointer to Ask Owl.
//
// This module is the SINGLE source for the note's id: app.js creates the note with it,
// and the E17 sample-offer gate reuses it to keep offering samples while the corpus holds
// only this note (see maybeOfferSamples). No string is duplicated across the two features.
export const WELCOME_NOTE_ID = 'welcome-owl-note';
export const WELCOME_NOTE_TITLE = 'Welcome to OWL-Note 🦉';

// The note body — friendly, short, and matching the README's voice (no version numbers,
// no marketing fluff). Kept as joined lines rather than a template literal so the fenced
// code block's backticks and the inline math backslash need no escaping gymnastics.
export const WELCOME_NOTE_BODY = [
  '# Welcome to OWL-Note 🦉',
  '',
  "This is your first note, and it's yours to keep, edit, or delete. Nothing here is special: it's an ordinary note like any you'll write, so go ahead and make it your own.",
  '',
  'OWL-Note stays out of your way. Your notes are **browser bookmarks**, so they sync across your devices for free through the browser account you already use. No server, no account, no subscription.',
  '',
  '## A few things you can do',
  '',
  '- **Write in Markdown** with headings, lists, **bold**, `inline code`, and a live preview as you type.',
  '- **Clip from any page** by right-clicking a selection and choosing **"Save selection to OWL-Note"**.',
  '- **Bring your notes with you**: import from Evernote (`.enex`), Word (`.docx`), or Markdown, and export everything back to plain `.md` files anytime. No lock-in.',
  '- **Stay organized** with notebooks you can nest and drag to rearrange.',
  '',
  '## Code and math, rendered',
  '',
  'Fenced code keeps its formatting:',
  '',
  '```python',
  'def greet(name):',
  '    return f"Hello, {name}!"',
  '```',
  '',
  "And inline math works too, so Euler's identity reads as $e^{i\\pi} + 1 = 0$.",
  '',
  '## Ask Owl 🦉',
  '',
  'Look for the **🦉 button** in the toolbar. Ask Owl answers questions in plain language using **only your own notes**, and it runs entirely on your device, so nothing you write ever leaves it.',
  '',
  "Want something to try it on right away? While you're starting empty, OWL-Note offers to **load a handful of sample notes** — instant material to ask Owl about.",
  '',
  '---',
  '',
  'That is the whole tour. Delete this note whenever you like and start writing.',
  '',
].join('\n');
