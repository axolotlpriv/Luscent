/**
 * Tiny arithmetic evaluator for numeric fields ("1920/2", "100*1.5", "(3+4)*2").
 * Supports + - * / parentheses and unary minus. Returns null on bad input.
 */
export function evalArithmetic(input: string): number | null {
  const src = input.replace(/\s+/g, '');
  let i = 0;
  const peek = () => src[i];
  function number(): number | null {
    const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
    if (!m) return null;
    i += m[0].length;
    return parseFloat(m[0]);
  }
  function factor(): number | null {
    if (peek() === '-') {
      i++;
      const v = factor();
      return v === null ? null : -v;
    }
    if (peek() === '+') {
      i++;
      return factor();
    }
    if (peek() === '(') {
      i++;
      const v = expr();
      if (peek() !== ')') return null;
      i++;
      return v;
    }
    return number();
  }
  function term(): number | null {
    let v = factor();
    while (v !== null && (peek() === '*' || peek() === '/')) {
      const op = src[i++];
      const r = factor();
      if (r === null) return null;
      v = op === '*' ? v * r : v / r;
    }
    return v;
  }
  function expr(): number | null {
    let v = term();
    while (v !== null && (peek() === '+' || peek() === '-')) {
      const op = src[i++];
      const r = term();
      if (r === null) return null;
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  const v = expr();
  if (v === null || i !== src.length || !Number.isFinite(v)) return null;
  return v;
}
