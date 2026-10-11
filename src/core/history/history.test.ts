import { describe, expect, it } from 'vitest';
import { History } from './history';

describe('History', () => {
  it('undoes and redoes', () => {
    const h = new History<number>();
    h.push(1, 'a');
    h.push(2, 'b');
    expect(h.undo(3)).toBe(2);
    expect(h.undo(2)).toBe(1);
    expect(h.undo(1)).toBeNull();
    expect(h.redo(1)).toBe(2);
    expect(h.redo(2)).toBe(3);
  });
  it('coalesces a transaction into one step', () => {
    const h = new History<number>();
    h.begin(1, 'drag');
    h.push(1, 'x');
    h.push(2, 'x');
    h.end(5);
    expect(h.undoLabel).toBe('drag');
    expect(h.undo(5)).toBe(1);
    expect(h.canUndo).toBe(false);
  });
  it('drops no-op transactions', () => {
    const h = new History<number>();
    h.begin(1, 'click');
    h.end(1);
    expect(h.canUndo).toBe(false);
  });
});
