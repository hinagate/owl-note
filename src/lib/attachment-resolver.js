// Recover attachment metadata/bytes when an owl-img/owl-file short reference is
// copied from one note into another. Mirrors are checked first because they keep
// full inline bytes; bookmark payloads cover notes whose local mirror was cleared.
import * as bm from './bookmarks.js';
import * as mirror from './mirror.js';
import { decode } from './codec.js';
import { inheritReferencedAttachments, referencedAttachmentIds } from './note-images.js';

function hasMissingReference(note) {
  const referenced = referencedAttachmentIds(note && note.body);
  if (!referenced.size) return false;
  const present = new Set(((note && note.attachments) || []).map((a) => a.id));
  for (const id of referenced) if (!present.has(id)) return true;
  return false;
}

function inherit(note, sources) {
  const attachments = inheritReferencedAttachments(note.body, note.attachments, sources);
  return attachments.length === ((note.attachments || []).length) ? note : { ...note, attachments };
}

// Best-effort by design: an unavailable/corrupt source note must never prevent the
// user from pasting or saving ordinary text. Unknown refs remain visible as refs.
export async function resolveReferencedAttachments(note, { rootId, sourceNotes } = {}) {
  if (!hasMissingReference(note)) return note;
  let resolved = note;

  try {
    resolved = inherit(resolved, sourceNotes || await mirror.allBackups());
  } catch { /* local recovery is best-effort */ }
  if (!hasMissingReference(resolved)) return resolved;

  try {
    const root = rootId || await bm.ensureRoot();
    const decoded = [];
    for (const row of await bm.allNotes(root)) {
      try {
        const source = await decode(row.payload);
        // Oversized-note stubs have no attachments. Their full version is normally
        // present in the mirror and was already checked above.
        if (source && source.attachments) decoded.push(source);
      } catch { /* skip one malformed bookmark and continue searching */ }
    }
    resolved = inherit(resolved, decoded);
  } catch { /* bookmark recovery is best-effort */ }

  return resolved;
}
