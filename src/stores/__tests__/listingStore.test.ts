/**
 * Unit tests for listingStore.ts
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useListingStore } from '../listingStore';
import type { ListingEntry } from '../../types/listing';
import type { ArchiveSummary } from '../../utils/archiveSummary';

function makeEntry(name: string): ListingEntry {
  return { name, url: `https://rageshakes.example.com/api/listing/demo/${name}` };
}

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
    cryptoSteps: [],
  };
}

describe('listingStore', () => {
  beforeEach(() => {
    useListingStore.getState().clearListing();
    useListingStore.setState({ allVisited: {}, visitedEntries: new Set() });
  });

  it('stores listing URL and entries on load', () => {
    useListingStore.getState().loadListing('https://example.com/api/listing/demo/', [
      makeEntry('logs.log.gz'),
      makeEntry('details.json'),
    ]);

    const state = useListingStore.getState();
    expect(state.listingUrl).toBe('https://example.com/api/listing/demo/');
    expect(state.listingEntries).toHaveLength(2);
  });

  it('clears summaries when a new listing is loaded', () => {
    useListingStore.getState().loadListing('https://example.com/api/listing/first/', [makeEntry('a.log.gz')]);
    useListingStore.getState().setListingSummary('a.log.gz', makeSummary(42));

    useListingStore.getState().loadListing('https://example.com/api/listing/second/', [makeEntry('b.log.gz')]);

    expect(useListingStore.getState().listingSummaries.size).toBe(0);
  });

  it('stores summaries per entry', () => {
    useListingStore.getState().loadListing('https://example.com/api/listing/demo/', [makeEntry('a.log.gz')]);
    useListingStore.getState().setListingSummary('a.log.gz', makeSummary(7));

    expect(useListingStore.getState().listingSummaries.get('a.log.gz')?.totalLines).toBe(7);
  });

  it('marks entries as visited and persists them per listing URL', () => {
    const listingUrl = 'https://example.com/api/listing/demo/';
    useListingStore.getState().loadListing(listingUrl, [makeEntry('a.log.gz')]);
    useListingStore.getState().markVisited('a.log.gz');

    const state = useListingStore.getState();
    expect(state.visitedEntries.has('a.log.gz')).toBe(true);
    expect(state.allVisited[listingUrl]).toContain('a.log.gz');
  });

  it('restores visited entries when the same listing URL is loaded again', () => {
    const listingUrl = 'https://example.com/api/listing/demo/';
    useListingStore.getState().loadListing(listingUrl, [makeEntry('a.log.gz')]);
    useListingStore.getState().markVisited('a.log.gz');
    useListingStore.getState().clearListing();

    useListingStore.getState().loadListing(listingUrl, [makeEntry('a.log.gz')]);

    expect(useListingStore.getState().visitedEntries.has('a.log.gz')).toBe(true);
  });
});