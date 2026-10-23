import { describe, it, expect } from 'vitest';
import { domainOf, formatUs, mechanismLabel, plural, short, utcText } from '../format';

describe('formatUs', () => {
  it('formats seconds, minutes, hours', () => {
    expect(formatUs(20_000_000)).toBe('20.0s');
    expect(formatUs(150_000_000)).toBe('2m 30s');
    expect(formatUs(7_500_000_000)).toBe('2h 5m');
    expect(formatUs(250_000)).toBe('250ms');
  });
  it('never prints a unit at the next one\'s boundary: rounding carries over, remainders floor', () => {
    expect(formatUs(999_600)).toBe('1.0s');
    expect(formatUs(59_960_000)).toBe('1m 0s');
    expect(formatUs(119_600_000)).toBe('1m 59s');
    expect(formatUs(3 * 3_600_000_000 + 59.6 * 60_000_000)).toBe('3h 59m');
  });
});

describe('utcText / plural / short', () => {
  it('cuts UTC text, counts and ids', () => {
    const us = Date.UTC(2026, 0, 15, 10, 0, 1, 620) * 1000;
    expect([utcText(us, 'day'), utcText(us, 'clock'), utcText(us, 'dateTime')]).toEqual(['2026-01-15', '10:00:01.620', '2026-01-15 10:00:01']);
    expect([plural(1, 'key'), plural(2, 'key')]).toEqual(['1 key', '2 keys']);
    expect([short('$abcdefghijklmnop'), short('$abc')]).toEqual(['$abcdefghijk…', '$abc']);
  });
});

describe('domainOf / mechanismLabel', () => {
  it('reads a user id domain and names a mechanism', () => {
    expect(domainOf('@a:matrix.org')).toBe('matrix.org');
    expect(domainOf(undefined)).toBeUndefined();
    expect(['late_key', 'backup', 'import', 'unknown'].map((m) => mechanismLabel(m as Parameters<typeof mechanismLabel>[0])))
      .toEqual(['late key', 'key backup', 'key import', 'unknown means']);
  });
});
