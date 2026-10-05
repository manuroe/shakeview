import { describe, expect, it } from 'vitest';
import {
  extractCategory,
  extractDateKey,
  getEntryKind,
  getMimeType,
  sortEntries,
  stripEntryPrefix,
} from '../listingEntries';

describe('listingEntries', () => {
  it('strips the leading archive prefix from nested names', () => {
    expect(stripEntryPrefix('2026-04-14_ID/console.2026-04-14-09.log.gz')).toBe(
      'console.2026-04-14-09.log.gz'
    );
  });

  it('extracts datestamps from filenames only', () => {
    expect(extractDateKey('2026-04-14_ID/console.2026-04-14-09.log.gz')).toBe('2026-04-14-09');
  });

  it('groups Element Web page-load logs into one process', () => {
    expect(extractCategory('2026-04-14_ID/logs-0000.log.gz')).toBe('logs');
    expect(extractCategory('logs-0012.log.gz')).toBe('logs');
    expect(extractCategory('console.2026-04-14-09.log.gz')).toBe('console');
  });

  it('classifies dated logs, plain logs, and other files', () => {
    expect(getEntryKind('console.2026-04-14-09.log.gz')).toBe('dated-log');
    expect(getEntryKind('logcat.log.gz')).toBe('plain-log');
    expect(getEntryKind('logs-0000.log.gz')).toBe('dated-log');
    expect(getEntryKind('details.json')).toBe('other');
  });

  it('sorts dated entries newest-first within each category', () => {
    const sorted = sortEntries([
      { name: 'console.2026-04-14-08.log.gz' },
      { name: 'logs.2026-04-14-09.log.gz' },
      { name: 'console.2026-04-14-10.log.gz' },
      { name: 'details.json' },
    ]);

    expect(sorted.map((entry) => entry.name)).toEqual([
      'console.2026-04-14-10.log.gz',
      'console.2026-04-14-08.log.gz',
      'logs.2026-04-14-09.log.gz',
      'details.json',
    ]);
  });

  it('returns MIME types for common listing files', () => {
    expect(getMimeType('details.json')).toBe('application/json');
    expect(getMimeType('screenshot.png')).toBe('image/png');
    expect(getMimeType('logs.log')).toBe('text/plain');
  });
});