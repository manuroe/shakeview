/**
 * Unit tests for archiveStore.ts
 *
 * Tests store actions and state transitions for archive loading, summary
 * tracking, visited-entry persistence, and clearing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useArchiveStore } from '../archiveStore';
import type { ArchiveEntry } from '../archiveStore';
import type { ArchiveSummary } from '../../utils/archiveSummary';

/** Minimal ArchiveEntry factory — only name and data are needed by the store. */
function makeEntry(name: string): ArchiveEntry {
  return { name, data: new Uint8Array([0]) };
}

/** Minimal ArchiveSummary for store tests. */
function makeSummary(totalLines = 10): ArchiveSummary {
  return {
    totalLines,
    errorCount: 0,
    warnCount: 0,
    sentryCount: 0,
    httpCount: 0,
    totalUploadBytes: 0,
    totalDownloadBytes: 0,
    statusCodes: {},
    utdCount: 0,
    utdReasons: {},
    cryptoSteps: [], rooms: { seenIds: [], lists: {} },
  };
}

describe('archiveStore', () => {
  beforeEach(() => {
    useArchiveStore.getState().clearArchive();
    // Reset allVisited between tests
    useArchiveStore.setState({ allVisited: {}, visitedEntries: new Set() });
  });

  describe('initial state', () => {
    it('starts with empty archive', () => {
      const state = useArchiveStore.getState();
      expect(state.archiveName).toBe('');
      expect(state.archiveEntries).toHaveLength(0);
      expect(state.archiveSummaries.size).toBe(0);
      expect(state.visitedEntries.size).toBe(0);
    });
  });

  describe('loadArchive', () => {
    it('stores name and entries', () => {
      const entries = [makeEntry('a/logs.log.gz'), makeEntry('a/details.json')];
      useArchiveStore.getState().loadArchive('logs.tar.gz', entries);

      const state = useArchiveStore.getState();
      expect(state.archiveName).toBe('logs.tar.gz');
      expect(state.archiveEntries).toHaveLength(2);
    });

    it('clears previously computed summaries on load', () => {
      useArchiveStore.getState().loadArchive('a.tar.gz', [makeEntry('a/f.log.gz')]);
      useArchiveStore.getState().setArchiveSummary('a/f.log.gz', makeSummary());

      useArchiveStore.getState().loadArchive('b.tar.gz', [makeEntry('b/g.log.gz')]);
      expect(useArchiveStore.getState().archiveSummaries.size).toBe(0);
    });

    it('restores visitedEntries from allVisited for the same archive name', () => {
      const entries = [makeEntry('a/f.log.gz')];
      useArchiveStore.getState().loadArchive('a.tar.gz', entries);
      useArchiveStore.getState().markVisited('a/f.log.gz');

      // Simulate navigating away and coming back
      useArchiveStore.getState().clearArchive();
      useArchiveStore.getState().loadArchive('a.tar.gz', entries);

      expect(useArchiveStore.getState().visitedEntries.has('a/f.log.gz')).toBe(true);
    });

    it('starts with empty visitedEntries for a new (unseen) archive name', () => {
      useArchiveStore.getState().loadArchive('new.tar.gz', [makeEntry('new/f.log.gz')]);
      expect(useArchiveStore.getState().visitedEntries.size).toBe(0);
    });
  });

  describe('setArchiveSummary', () => {
    it('stores a summary for an entry', () => {
      useArchiveStore.getState().loadArchive('a.tar.gz', [makeEntry('a/f.log.gz')]);
      useArchiveStore.getState().setArchiveSummary('a/f.log.gz', makeSummary(42));

      const summary = useArchiveStore.getState().archiveSummaries.get('a/f.log.gz');
      expect(summary?.totalLines).toBe(42);
    });

    it('stores summaries for multiple entries independently', () => {
      useArchiveStore.getState().loadArchive('a.tar.gz', [
        makeEntry('a/f.log.gz'),
        makeEntry('a/g.log.gz'),
      ]);
      useArchiveStore.getState().setArchiveSummary('a/f.log.gz', makeSummary(10));
      useArchiveStore.getState().setArchiveSummary('a/g.log.gz', makeSummary(20));

      expect(useArchiveStore.getState().archiveSummaries.get('a/f.log.gz')?.totalLines).toBe(10);
      expect(useArchiveStore.getState().archiveSummaries.get('a/g.log.gz')?.totalLines).toBe(20);
    });
  });

  describe('markVisited', () => {
    it('adds an entry to visitedEntries', () => {
      useArchiveStore.getState().loadArchive('a.tar.gz', [makeEntry('a/f.log.gz')]);
      useArchiveStore.getState().markVisited('a/f.log.gz');
      expect(useArchiveStore.getState().visitedEntries.has('a/f.log.gz')).toBe(true);
    });

    it('persists the visited entry in allVisited keyed by archiveName', () => {
      useArchiveStore.getState().loadArchive('a.tar.gz', [makeEntry('a/f.log.gz')]);
      useArchiveStore.getState().markVisited('a/f.log.gz');

      const allVisited = useArchiveStore.getState().allVisited;
      expect(allVisited['a.tar.gz']).toContain('a/f.log.gz');
    });

    it('does not add duplicate entries', () => {
      useArchiveStore.getState().loadArchive('a.tar.gz', [makeEntry('a/f.log.gz')]);
      useArchiveStore.getState().markVisited('a/f.log.gz');
      useArchiveStore.getState().markVisited('a/f.log.gz');

      expect(useArchiveStore.getState().allVisited['a.tar.gz']).toHaveLength(1);
    });

    it('keeps visited history for different archives independent', () => {
      useArchiveStore.getState().loadArchive('a.tar.gz', [makeEntry('a/f.log.gz')]);
      useArchiveStore.getState().markVisited('a/f.log.gz');

      useArchiveStore.getState().loadArchive('b.tar.gz', [makeEntry('b/g.log.gz')]);
      useArchiveStore.getState().markVisited('b/g.log.gz');

      const allVisited = useArchiveStore.getState().allVisited;
      expect(allVisited['a.tar.gz']).toContain('a/f.log.gz');
      expect(allVisited['b.tar.gz']).toContain('b/g.log.gz');
    });
  });

  describe('clearArchive', () => {
    it('resets transient state but preserves allVisited', () => {
      useArchiveStore.getState().loadArchive('a.tar.gz', [makeEntry('a/f.log.gz')]);
      useArchiveStore.getState().markVisited('a/f.log.gz');

      useArchiveStore.getState().clearArchive();

      const state = useArchiveStore.getState();
      expect(state.archiveName).toBe('');
      expect(state.archiveEntries).toHaveLength(0);
      expect(state.archiveSummaries.size).toBe(0);
      expect(state.visitedEntries.size).toBe(0);
      // History is preserved
      expect(state.allVisited['a.tar.gz']).toContain('a/f.log.gz');
    });
  });
});
