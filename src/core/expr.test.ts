import { describe, expect, it } from 'vitest';
import { evalArithmetic } from './expr';

describe('evalArithmetic', () => {
  it('evaluates', () => {
    expect(evalArithmetic('1920/2')).toBe(960);
    expect(evalArithmetic('(3 + 4) * 2')).toBe(14);
    expect(evalArithmetic('-5+2*3')).toBe(1);
    expect(evalArithmetic('.5')).toBe(0.5);
  });
  it('rejects junk', () => {
    expect(evalArithmetic('alert(1)')).toBeNull();
    expect(evalArithmetic('1/0')).toBeNull();
    expect(evalArithmetic('2*')).toBeNull();
  });
});
