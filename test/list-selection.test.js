import { describe, it, expect } from 'vitest';
import { rangeHandles } from '../src/lib/list-selection.js';

const H = ['a', 'b', 'c', 'd', 'e'];

describe('rangeHandles', () => {
  it('inclusive forward range', () => expect(rangeHandles(H, 1, 3)).toEqual(['b', 'c', 'd']));
  it('inclusive backward range', () => expect(rangeHandles(H, 3, 1)).toEqual(['b', 'c', 'd']));
  it('single index', () => expect(rangeHandles(H, 2, 2)).toEqual(['c']));
  it('clamps out-of-bounds', () => expect(rangeHandles(H, -5, 99)).toEqual(H));
  it('returns [] for invalid input', () => {
    expect(rangeHandles(H, null, 2)).toEqual([]);
    expect(rangeHandles([], 0, 0)).toEqual([]);
  });
});
