import { describe, expect, it } from 'vitest';

import { formatOffset, formatUtc, parseDuration, parseOffset, parseUtc } from '../../src/time.js';

describe('parseUtc', () => {
  it('keeps sub-millisecond digits as a fraction', () => {
    expect(parseUtc('2026-10-11T12:27:02.0694725Z')).toBeCloseTo(Date.parse('2026-10-11T12:27:02.069Z') + 0.4725, 6);
  });

  it('accepts timestamps without fraction or Z', () => {
    expect(parseUtc('2026-10-11T12:27:02Z')).toBe(Date.parse('2026-10-11T12:27:02Z'));
    expect(parseUtc('2026-10-11T20:00:00')).toBe(Date.parse('2026-10-11T20:00:00Z'));
  });

  it('rejects other strings', () => {
    expect(() => parseUtc('yesterday')).toThrow(TypeError);
  });
});

describe('formatUtc', () => {
  it('formats with millisecond precision', () => {
    expect(formatUtc(Date.parse('2026-10-11T11:07:35.580Z') + 0.4)).toBe('2026-10-11T11:07:35.580Z');
  });
});

describe('stream offsets', () => {
  it('parses and formats HH:MM:SS.mmm', () => {
    expect(parseOffset('02:40:17.955')).toBe(((2 * 60 + 40) * 60 + 17) * 1000 + 955);
    expect(formatOffset(((2 * 60 + 40) * 60 + 17) * 1000 + 955)).toBe('02:40:17.955');
  });

  it('clamps negative offsets to zero', () => {
    expect(formatOffset(-5)).toBe('00:00:00.000');
  });

  it('rejects malformed offsets', () => {
    expect(() => parseOffset('1:2:3')).toThrow(TypeError);
  });
});

describe('parseDuration', () => {
  it.each([
    ['1:36.224', 96_224],
    ['01:59:57', 7_197_000],
    ['28.631', 28_631],
    ['0:00:42.123', 42_123],
    ['45', 45_000],
  ])('parses %s', (text, ms) => {
    expect(parseDuration(text)).toBeCloseTo(ms, 6);
  });

  it.each(['', 'LAP 1', '+1 LAP'])('returns null for %j', (text) => {
    expect(parseDuration(text)).toBeNull();
  });
});
