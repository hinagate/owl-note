// Pure helpers for the nested-notebook sidebar tree.

// Build a nested tree from a flat notebook list (each { id, title, parentId }).
// Returns the top-level nodes (parentId === rootId), each with a `children` array,
// preserving the input sibling order.
export function buildNotebookTree(notebooks, rootId) {
  const byParent = new Map();
  for (const nb of notebooks) {
    if (!byParent.has(nb.parentId)) byParent.set(nb.parentId, []);
    byParent.get(nb.parentId).push(nb);
  }
  const build = (parentId) => (byParent.get(parentId) || []).map((nb) => ({
    id: nb.id,
    title: nb.title,
    parentId: nb.parentId,
    children: build(nb.id),
  }));
  return build(rootId);
}

// True when `targetId` is `folderId` itself or any descendant of it — used to
// forbid dropping a notebook into its own subtree (which would orphan it).
export function isSelfOrDescendant(notebooks, folderId, targetId) {
  if (folderId === targetId) return true;
  const byId = new Map(notebooks.map((n) => [n.id, n]));
  let cur = byId.get(targetId);
  while (cur) {
    if (cur.parentId === folderId) return true; // folderId is an ancestor of targetId
    cur = byId.get(cur.parentId);
  }
  return false;
}
