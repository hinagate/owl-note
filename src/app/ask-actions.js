// src/app/ask-actions.js
//
// [Task E12] Pluggable quick-action registry for the Ask context chip.
//
// The chip row's quick actions (Summarize, Tidy, and any future skill) are DATA, not
// bespoke buttons: each is an AskAction descriptor { id, label, ariaLabel, run }. The
// panel (ask-panel.js) renders one chip-row button per descriptor it is handed via its
// `actions` prop and knows NOTHING about what any of them do; app.js composes the list
// with builtinAskActions() and injects the host deps each action closes over.
//
// Adding a skill = append ONE descriptor here (or app.js concatenates extras); removing
// one = delete it. No new panel prop, no new button, no new wiring per skill.

/**
 * @typedef {Object} AskAction
 * @prop {string} id         unique, e.g. 'summarize'
 * @prop {string} label      button text, e.g. 'Summarize'
 * @prop {string} ariaLabel  accessible name
 * @prop {(ctx: { noteId: string, ask: (question: string, opts?: object) => void,
 *                notice: (text: string) => void }) => void} run
 *   Invoked on click with the CHIP's note id resolved AT CLICK TIME. `ask` is
 *   PANEL-PROVIDED — it is the same internal record-then-onAsk path that the input's
 *   fire() uses, so an action that asks (Summarize) records lastQuestion/lastAskOpts
 *   and the panel's enable→re-ask flow keeps working with zero per-skill plumbing.
 *   `notice` (also panel-provided) appends a lightweight feedback row to the thread —
 *   for actions whose effect happens OUTSIDE the panel (the editor sits behind the
 *   drawer, so without a notice the action looks like a no-op from the drawer).
 *   Everything else an action needs (e.g. tidyNote) is closed over at composition
 *   time in builtinAskActions() below — the panel never sees those deps.
 */

// [Task E9] The fixed question the one-click "Summarize" quick action asks. It becomes
// the exchange's question bubble AND the model's QUESTION line — the Ask grounding
// prompt summarizes fine, so no dedicated summarize prompt is needed (YAGNI).
const SUMMARIZE_QUESTION = 'Summarize this note.';

/**
 * Compose the built-in quick actions with their host dependencies.
 * @param {Object} deps
 * @param {(noteId: string) => void} deps.tidyNote  [Task E11] Run the deterministic
 *   markdown tidy on the note and apply it (the host does a synchronous
 *   read→tidy→replaceBody and toasts the result). Injected so ask-actions.js stays
 *   free of ui/toast/editor internals.
 * @returns {AskAction[]}
 */
export function builtinAskActions({ tidyNote }) {
  return [
    {
      id: 'summarize',
      label: 'Summarize',
      ariaLabel: 'Summarize this note',
      // [Task E9] Fire a NORMAL exchange for the WHOLE note (pinAll) via the panel's
      // ask(): it records lastQuestion/lastAskOpts so an enable→re-ask re-runs it AS a
      // summarize (not a plain keyword search). No typing — a follow-up question then
      // composes naturally in the thread.
      run: ({ noteId, ask }) => ask(SUMMARIZE_QUESTION, { pinnedNoteId: noteId, pinAll: true }),
    },
    {
      id: 'tidy',
      label: 'Tidy',
      ariaLabel: 'Tidy the note formatting',
      // [Task E11] Deterministic markdown tidy on the chip's note — no model, no
      // proposal, no exchange (this replaced E10's async Format flow, which the model
      // made unreadable). Uses the injected host routine; ignores ctx.ask. The edit
      // lands in the editor BEHIND the drawer, so the panel notice is the feedback
      // the user actually sees (a toast alone hid under the drawer).
      run: ({ noteId, notice }) => {
        const status = tidyNote(noteId);
        if (status === 'tidied') notice('Note tidied — Ctrl+Z in the editor undoes it.');
        else if (status === 'unchanged') notice('Already tidy — nothing to change.');
        // 'no-note' (or legacy undefined): the host already toasted the guard failure.
      },
    },
  ];
}
