import { useEffect, useRef, useState } from 'react';
import { editor } from '../../state/store';
import type { Color } from '../../core/model/types';
import { evalArithmetic } from '../../core/expr';

interface NumberFieldProps {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  decimals?: number;
  animated?: boolean;
  /** Undo label for the drag gesture. */
  label?: string;
  title?: string;
}

function clampTo(v: number, min?: number, max?: number) {
  if (min !== undefined && v < min) return min;
  if (max !== undefined && v > max) return max;
  return v;
}

/**
 * After Effects-style "hot text": drag horizontally to scrub (Shift ×10,
 * Alt ×0.1), click to type. A whole drag is one undo step.
 */
export function NumberField({ value, onChange, step = 1, min, max, unit, decimals = 1, animated, label = 'Scrub Value', title }: NumberFieldProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const drag = useRef<{ x: number; start: number; moved: boolean } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const fmt = (v: number) => {
    const r = Number(v.toFixed(decimals));
    return Object.is(r, -0) ? '0' : String(r);
  };

  if (editing) {
    const commit = () => {
      setEditing(false);
      // Allow simple arithmetic like "100*1.5" or "+20".
      let expr = text.trim();
      if (/^[+\-*/]/.test(expr) && !/^-\d/.test(expr)) expr = `${value}${expr}`;
      const v = evalArithmetic(expr);
      if (v !== null) onChange(clampTo(v, min, max));
    };
    return (
      <input
        ref={inputRef}
        className="num-input"
        type="text"
        value={text}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setEditing(false);
        }}
      />
    );
  }

  return (
    <span
      className={'num' + (animated ? ' animated' : '')}
      title={title}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, start: value, moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        if (!d.moved && Math.abs(dx) < 3) return;
        if (!d.moved) {
          d.moved = true;
          editor().beginGesture(label);
        }
        const mul = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
        onChange(clampTo(d.start + dx * step * mul, min, max));
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        if (d.moved) editor().endGesture();
        else {
          setText(fmt(value));
          setEditing(true);
        }
      }}
    >
      {fmt(value)}
      {unit && <span className="unit">{unit}</span>}
    </span>
  );
}

export function colorToHex(c: Color): string {
  const h = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}

export function hexToColor(hex: string, alpha = 1): Color {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, alpha];
}

export function ColorField({ value, onChange, label = 'Change Color' }: { value: Color; onChange: (c: Color) => void; label?: string }) {
  const open = useRef(false);
  return (
    <span className="row" style={{ gap: 4 }}>
      <span className="color-swatch" style={{ background: colorToHex(value) }}>
        <input
          type="color"
          value={colorToHex(value)}
          onFocus={() => {
            if (!open.current) editor().beginGesture(label);
            open.current = true;
          }}
          onBlur={() => {
            open.current = false;
            editor().endGesture();
          }}
          onChange={(e) => onChange(hexToColor(e.target.value, value[3]))}
        />
      </span>
      <NumberField value={value[3] * 100} min={0} max={100} step={0.5} unit="%" decimals={0} title="Alpha" onChange={(a) => onChange([value[0], value[1], value[2], a / 100])} />
    </span>
  );
}

export interface MenuItem {
  label: string;
  hint?: string;
  action?: () => void;
  separator?: boolean;
  disabled?: boolean;
}

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  useEffect(() => {
    const close = () => onClose();
    const t = setTimeout(() => {
      window.addEventListener('pointerdown', close);
      window.addEventListener('blur', close);
    });
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('blur', close);
    };
  }, [onClose]);
  const left = Math.min(x, window.innerWidth - 220);
  const top = Math.min(y, window.innerHeight - items.length * 28 - 12);
  return (
    <div className="menu" style={{ left, top }} onPointerDown={(e) => e.stopPropagation()}>
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="menu-sep" />
        ) : (
          <div
            key={i}
            className="menu-item"
            style={it.disabled ? { opacity: 0.4, pointerEvents: 'none' } : undefined}
            onClick={() => {
              onClose();
              it.action?.();
            }}
          >
            <span>{it.label}</span>
            {it.hint && <span className="k">{it.hint}</span>}
          </div>
        ),
      )}
    </div>
  );
}
