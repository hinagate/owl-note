// src/lib/list-selection.js
// Pure helper for OS-style range selection over a flat list of handles.
export function rangeHandles(handles, a, b) {
  if (!Array.isArray(handles) || handles.length === 0 || a == null || b == null) return [];
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(handles.length - 1, Math.max(a, b));
  if (hi < lo) return [];
  return handles.slice(lo, hi + 1);
}
