import { describe, it, expect } from 'vitest';
import { buildNotebookTree, isSelfOrDescendant } from '../src/lib/notebook-tree.js';

describe('buildNotebookTree', () => {
  const nbs = [
    { id: 'a', title: 'A', parentId: 'root' },
    { id: 'a1', title: 'A1', parentId: 'a' },
    { id: 'a2', title: 'A2', parentId: 'a' },
    { id: 'a1x', title: 'A1X', parentId: 'a1' },
    { id: 'b', title: 'B', parentId: 'root' },
  ];

  it('nests children under their parent, preserving sibling order', () => {
    const tree = buildNotebookTree(nbs, 'root');
    expect(tree.map((n) => n.id)).toEqual(['a', 'b']); // top level
    const a = tree[0];
    expect(a.children.map((n) => n.id)).toEqual(['a1', 'a2']);
    expect(a.children[0].children.map((n) => n.id)).toEqual(['a1x']); // deep nesting
    expect(tree[1].children).toEqual([]); // leaf
  });

  it('returns [] when there are no notebooks', () => {
    expect(buildNotebookTree([], 'root')).toEqual([]);
  });
});

describe('isSelfOrDescendant', () => {
  const nbs = [
    { id: 'a', title: 'A', parentId: 'root' },
    { id: 'a1', title: 'A1', parentId: 'a' },
    { id: 'a1x', title: 'A1X', parentId: 'a1' },
    { id: 'b', title: 'B', parentId: 'root' },
  ];

  it('is true for the folder itself', () => {
    expect(isSelfOrDescendant(nbs, 'a', 'a')).toBe(true);
  });
  it('is true for a direct or deep descendant', () => {
    expect(isSelfOrDescendant(nbs, 'a', 'a1')).toBe(true);
    expect(isSelfOrDescendant(nbs, 'a', 'a1x')).toBe(true);
  });
  it('is false for unrelated folders and ancestors', () => {
    expect(isSelfOrDescendant(nbs, 'a', 'b')).toBe(false);
    expect(isSelfOrDescendant(nbs, 'a1', 'a')).toBe(false); // a is the parent, not a descendant
    expect(isSelfOrDescendant(nbs, 'a', 'root')).toBe(false);
  });
});
