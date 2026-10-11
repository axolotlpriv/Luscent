/** Frame/time helpers. Model time is seconds; editing snaps to frames. */

export function frameDuration(fps: number): number {
  return 1 / fps;
}

export function timeToFrame(t: number, fps: number): number {
  // Small epsilon so 0.1 * 30 = 2.9999999 rounds down to the right frame.
  return Math.floor(t * fps + 1e-6);
}

export function frameToTime(frame: number, fps: number): number {
  return frame / fps;
}

/** Round a time to the nearest frame boundary. */
export function quantize(t: number, fps: number): number {
  return Math.round(t * fps) / fps;
}

/** Format as HH:MM:SS:FF (AE-style timecode). Drops hours when zero. */
export function formatTimecode(t: number, fps: number): string {
  const sign = t < 0 ? '-' : '';
  const total = Math.round(Math.abs(t) * fps);
  const rate = Math.round(fps);
  const ff = total % rate;
  const totalSec = Math.floor(total / rate);
  const ss = totalSec % 60;
  const mm = Math.floor(totalSec / 60) % 60;
  const hh = Math.floor(totalSec / 3600);
  const p2 = (n: number) => n.toString().padStart(2, '0');
  const body = `${hh > 0 ? p2(hh) + ':' : ''}${p2(mm)}:${p2(ss)}:${p2(ff)}`;
  return sign + body;
}

/**
 * Parse timecode ("MM:SS:FF", "HH:MM:SS:FF"), seconds ("1.5s", "1.5"), or a
 * bare frame count ("45f"). Returns null when unparseable.
 */
export function parseTimecode(input: string, fps: number): number | null {
  const s = input.trim();
  if (!s) return null;
  if (/^-?\d+f$/i.test(s)) return parseInt(s, 10) / fps;
  if (/^-?\d*\.?\d+s?$/i.test(s)) {
    const v = parseFloat(s);
    return Number.isFinite(v) ? v : null;
  }
  const parts = s.split(/[:;]/).map((p) => p.trim());
  if (parts.some((p) => !/^\d+$/.test(p))) return null;
  const nums = parts.map(Number);
  while (nums.length < 4) nums.unshift(0);
  const [hh, mm, ss, ff] = nums.slice(-4);
  return hh * 3600 + mm * 60 + ss + ff / fps;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
