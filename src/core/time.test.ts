import { describe, expect, it } from 'vitest';
import { formatTimecode, parseTimecode, quantize, timeToFrame } from './time';

describe('time', () => {
  it('formats timecode', () => {
    expect(formatTimecode(0, 30)).toBe('00:00:00');
    expect(formatTimecode(1.5, 30)).toBe('00:01:15');
    expect(formatTimecode(61 + 29 / 30, 30)).toBe('01:01:29');
    expect(formatTimecode(3600, 30)).toBe('01:00:00:00');
  });
  it('parses several formats', () => {
    expect(parseTimecode('00:01:15', 30)).toBeCloseTo(1.5);
    expect(parseTimecode('45f', 30)).toBeCloseTo(1.5);
    expect(parseTimecode('2.5s', 30)).toBeCloseTo(2.5);
    expect(parseTimecode('1:00', 30)).toBeCloseTo(1);
    expect(parseTimecode('abc', 30)).toBeNull();
  });
  it('quantizes to frames', () => {
    expect(quantize(0.51, 30)).toBeCloseTo(15 / 30);
    expect(timeToFrame(0.1, 30)).toBe(3);
  });
});
