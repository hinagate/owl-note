// Minimal in-memory implementation of the chrome.* APIs this project uses.
function makeHub() {
  const listeners = [];
  return {
    addListener: (fn) => listeners.push(fn),
    dispatch: (...args) => listeners.forEach((fn) => fn(...args)),
  };
}

export function installFakeChrome(opts = {}) {
  let seq = 100;
  // Real browsers assign these permanent ids per-profile; stock Chrome uses '2'
  // for Other Bookmarks, but Edge/Brave/some profiles differ. Tests can override.
  const otherId = opts.otherBookmarksId || '2';
  const ft = opts.folderType === false; // set true to mimic legacy browsers w/o folderType
  const nodes = new Map(); // id -> { id, parentId, title, url, index, children? }
  nodes.set('0', { id: '0', title: '', children: ['1', otherId] });
  nodes.set('1', { id: '1', parentId: '0', title: 'Bookmarks Bar', index: 0, children: [], folderType: ft ? undefined : 'bookmarks-bar' });
  nodes.set(otherId, { id: otherId, parentId: '0', title: 'Other Bookmarks', index: 1, children: [], folderType: ft ? undefined : 'other' });

  const onCreated = makeHub();
  const onChanged = makeHub();
  const onRemoved = makeHub();
  const onMoved = makeHub();

  function toNode(n) {
    const out = { id: n.id, parentId: n.parentId, title: n.title, index: n.index };
    if (n.url !== undefined) out.url = n.url;
    if (n.folderType) out.folderType = n.folderType;
    if (n.children) out.children = n.children.map((cid) => toNode(nodes.get(cid)));
    if (n.dateAdded !== undefined) out.dateAdded = n.dateAdded;
    return out;
  }

  const bookmarks = {
    onCreated, onChanged, onRemoved, onMoved,
    async get(id) {
      const n = nodes.get(id);
      if (!n) throw new Error('not found: ' + id);
      return [toNode(n)];
    },
    async getChildren(id) {
      const n = nodes.get(id);
      return (n.children || []).map((cid) => toNode(nodes.get(cid)));
    },
    async getSubTree(id) { return [toNode(nodes.get(id))]; },
    async getTree() { return [toNode(nodes.get('0'))]; },
    async search(query) {
      const q = (typeof query === 'string' ? query : query.query || '').toLowerCase();
      const out = [];
      for (const n of nodes.values()) {
        if (n.id === '0') continue;
        if ((n.title || '').toLowerCase().includes(q) || (n.url || '').toLowerCase().includes(q)) out.push(toNode(n));
      }
      return out;
    },
    async create({ parentId, title = '', url, index }) {
      const id = String(++seq);
      const parent = nodes.get(parentId);
      const node = { id, parentId, title, index: parent.children.length, dateAdded: seq };
      if (url !== undefined) node.url = url; else node.children = [];
      nodes.set(id, node);
      if (index === undefined) parent.children.push(id);
      else parent.children.splice(index, 0, id);
      onCreated.dispatch(id, toNode(node));
      return toNode(node);
    },
    async update(id, changes) {
      const n = nodes.get(id);
      Object.assign(n, changes);
      onChanged.dispatch(id, { title: n.title, url: n.url });
      return toNode(n);
    },
    async move(id, dest) {
      const n = nodes.get(id);
      const old = nodes.get(n.parentId);
      old.children = old.children.filter((c) => c !== id);
      n.parentId = dest.parentId;
      nodes.get(dest.parentId).children.push(id);
      onMoved.dispatch(id, { parentId: dest.parentId });
      return toNode(n);
    },
    async remove(id) {
      const n = nodes.get(id);
      nodes.get(n.parentId).children = nodes.get(n.parentId).children.filter((c) => c !== id);
      nodes.delete(id);
      onRemoved.dispatch(id, { parentId: n.parentId, node: toNode(n) });
    },
    async removeTree(id) {
      const n = nodes.get(id);
      if (!n) return;
      for (const cid of (n.children || []).slice()) await bookmarks.removeTree(cid);
      const parent = nodes.get(n.parentId);
      if (parent) parent.children = parent.children.filter((c) => c !== id);
      nodes.delete(id);
      onRemoved.dispatch(id, { parentId: n.parentId, node: toNode(n) });
    },
  };

  const store = new Map();
  const storage = {
    local: {
      async get(keys) {
        if (keys == null) return Object.fromEntries(store);
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of list) if (store.has(k)) out[k] = store.get(k);
        return out;
      },
      async set(obj) { for (const [k, v] of Object.entries(obj)) store.set(k, v); },
      async remove(keys) { (Array.isArray(keys) ? keys : [keys]).forEach((k) => store.delete(k)); },
      async clear() { store.clear(); },
    },
  };

  const chrome = {
    runtime: { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', onInstalled: makeHub() },
    bookmarks,
    storage,
    extension: { isAllowedFileSchemeAccess: (cb) => cb(false) },
    tabs: { create: async () => ({}) },
    action: { onClicked: makeHub(), setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    contextMenus: { create: () => {}, removeAll: () => {}, onClicked: makeHub() },
  };
  globalThis.chrome = chrome;
  return chrome;
}
