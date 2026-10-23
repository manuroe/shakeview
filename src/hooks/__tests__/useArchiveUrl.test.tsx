/**
 * Unit tests for the useArchiveUrl hook.
 *
 * The hook is a no-op without the `archive` param. With it, it fetches the
 * archive, unpacks it, opens every analyzable entry as one merged timeline, and
 * navigates to /logs with the param dropped and the rest (line, filter, start,
 * end) preserved. Any failure lands on the landing page instead.
 */
import { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const { mockParseTarGzArchive, mockLoadArchive, mockOpenMergedEntries, mockNavigate, mockLoadCryptoDevice, mockStartCase, mockDeviceFromFile } = vi.hoisted(() => ({
  mockParseTarGzArchive: vi.fn(),
  mockLoadArchive: vi.fn(),
  mockOpenMergedEntries: vi.fn(),
  mockNavigate: vi.fn(),
  mockLoadCryptoDevice: vi.fn(),
  mockStartCase: vi.fn(),
  mockDeviceFromFile: vi.fn(),
}));

vi.mock('../../utils/crypto/loadDevice', () => ({ deviceFromFile: mockDeviceFromFile }));

vi.mock('../../stores/cryptoStore', () => ({
  loadCryptoDevice: mockLoadCryptoDevice,
  startCase: mockStartCase,
}));

vi.mock('../../utils/tarGzArchive', () => ({
  parseTarGzArchive: mockParseTarGzArchive,
}));

vi.mock('../../utils/openMergedLogs', () => ({
  openMergedEntries: mockOpenMergedEntries,
}));

// The store is stateful here, not a bare spy: the hook skips the download when
// the archive it wants is the one in memory, so `archiveName`/`archiveEntries`
// have to actually change when something is loaded — including the hand-dropped
// archive of the "replaced in memory" test.
let storeName = '';
let storeEntries: readonly { name: string }[] = [];
function putInStore(name: string, entries: readonly { name: string }[]): void {
  storeName = name;
  storeEntries = entries;
}
vi.mock('../../stores/archiveStore', () => ({
  // Getters, not values: the factory runs at import time, when the bindings
  // above are still in their temporal dead zone.
  useArchiveStore: {
    getState: () => ({
      loadArchive: (name: string, entries: readonly { name: string }[]) => {
        putInStore(name, entries);
        mockLoadArchive(name, entries);
      },
      get archiveName() { return storeName; },
      get archiveEntries() { return storeEntries; },
    }),
  },
}));

let mockSearchParams: URLSearchParams;
let mockPathname = '/logs';
vi.mock('react-router-dom', () => ({
  useSearchParams: () => [mockSearchParams, vi.fn()],
  useNavigate: () => mockNavigate,
  useLocation: () => ({ pathname: mockPathname }),
}));

import { useArchiveUrl, ARCHIVE_URL_PARAM, ARCHIVE_FILE_PARAM } from '../useArchiveUrl';

const ARCHIVE_URL = 'http://127.0.0.1:7357/cases/ios-1-slug/shakes/2026-07-22_112505-FG4DKXZW.tar.gz';
const ENTRIES = [
  { name: 'details.json', data: new Uint8Array() },
  { name: 'console.2026-07-22-11.log.gz', data: new Uint8Array() },
  { name: 'crash.png', data: new Uint8Array() },
];

function mockFetchOk(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) })
  );
}

describe('useArchiveUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockSearchParams = new URLSearchParams();
    mockPathname = '/logs';
    putInStore('', []);
    mockParseTarGzArchive.mockReturnValue(ENTRIES);
    mockOpenMergedEntries.mockResolvedValue('/summary');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is a no-op when the archive param is absent', () => {
    mockFetchOk();
    renderHook(() => useArchiveUrl());
    expect(fetch).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('on /decryption: opens the first archive, adds the others as devices, stays on /decryption', async () => {
    mockFetchOk();
    mockPathname = '/decryption';
    mockSearchParams = new URLSearchParams(`?${ARCHIVE_URL_PARAM}=${ARCHIVE_URL}&${ARCHIVE_URL_PARAM}=http://127.0.0.1:7357/sender.tar.gz&session=S`);

    renderHook(() => useArchiveUrl());

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith({ pathname: '/decryption', search: 'session=S' }, { replace: true }));
    expect(fetch).toHaveBeenCalledWith(ARCHIVE_URL);
    expect(mockStartCase).toHaveBeenCalledTimes(1);
    expect(mockLoadCryptoDevice).toHaveBeenCalledWith('sender.tar.gz', expect.any(Function));
  });

  it('on /decryption: the same archive again still adds the other archives as devices', async () => {
    mockFetchOk();
    mockSearchParams = new URLSearchParams(`?${ARCHIVE_URL_PARAM}=${ARCHIVE_URL}`);
    const { rerender } = renderHook(() => useArchiveUrl());
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledTimes(1));

    act(() => {
      mockPathname = '/decryption';
      mockSearchParams = new URLSearchParams(`?${ARCHIVE_URL_PARAM}=${ARCHIVE_URL}&${ARCHIVE_URL_PARAM}=http://127.0.0.1:7357/sender.tar.gz`);
    });
    rerender();

    await waitFor(() => expect(mockLoadCryptoDevice).toHaveBeenCalledWith('sender.tar.gz', expect.any(Function)));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenLastCalledWith({ pathname: '/decryption', search: '' }, { replace: true });
  });

  it('on /decryption: each added device is fetched from its URL, and an HTTP error is reported', async () => {
    mockFetchOk();
    mockPathname = '/decryption';
    mockSearchParams = new URLSearchParams(`?${ARCHIVE_URL_PARAM}=${ARCHIVE_URL}&${ARCHIVE_URL_PARAM}=http://127.0.0.1:7357/sender.tar.gz`);
    mockDeviceFromFile.mockResolvedValue({ archiveName: 'sender.tar.gz' });
    renderHook(() => useArchiveUrl());
    await waitFor(() => expect(mockLoadCryptoDevice).toHaveBeenCalled());
    const load = mockLoadCryptoDevice.mock.calls[0][1] as () => Promise<unknown>;

    await expect(load()).resolves.toEqual({ archiveName: 'sender.tar.gz' });
    expect(fetch).toHaveBeenLastCalledWith('http://127.0.0.1:7357/sender.tar.gz');
    expect(mockDeviceFromFile).toHaveBeenCalledWith('sender.tar.gz', expect.any(Uint8Array));

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    await expect(load()).rejects.toThrow('fetch failed with HTTP 404');
  });

  it('fetches the archive, opens the analyzable entries merged, and lands on /logs', async () => {
    mockFetchOk();
    mockSearchParams = new URLSearchParams(`?${ARCHIVE_URL_PARAM}=${ARCHIVE_URL}&line=1234&filter=sync`);

    renderHook(() => useArchiveUrl());

    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());
    expect(fetch).toHaveBeenCalledWith(ARCHIVE_URL);
    // Store name is the URL's last segment, not the whole URL.
    expect(mockLoadArchive).toHaveBeenCalledWith('2026-07-22_112505-FG4DKXZW.tar.gz', ENTRIES);
    // details.json and the screenshot are not logs; only the log file is opened.
    expect(mockOpenMergedEntries).toHaveBeenCalledWith(['console.2026-07-22-11.log.gz']);
    // /logs regardless of the route openMergedEntries returned ('/summary' here):
    // the link is pointing at a log line.
    const [{ pathname, search }] = mockNavigate.mock.calls[0] as [{ pathname: string; search: string }];
    expect(pathname).toBe('/logs');
    const nextParams = new URLSearchParams(search);
    expect(nextParams.has(ARCHIVE_URL_PARAM)).toBe(false);
    expect(nextParams.get('line')).toBe('1234');
    expect(nextParams.get('filter')).toBe('sync');
  });

  it('opens only the entry named by file=, matched on its basename', async () => {
    mockFetchOk();
    // The link cites the bare filename; the entry carries no prefix here, but a
    // real archive nests everything under its archive-id directory.
    mockSearchParams = new URLSearchParams(
      `?${ARCHIVE_URL_PARAM}=${ARCHIVE_URL}&${ARCHIVE_FILE_PARAM}=console.2026-07-22-11.log.gz&line=1234`
    );

    renderHook(() => useArchiveUrl());

    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());
    expect(mockOpenMergedEntries).toHaveBeenCalledWith(['console.2026-07-22-11.log.gz']);
    const [{ pathname, search }] = mockNavigate.mock.calls[0] as [{ pathname: string; search: string }];
    expect(pathname).toBe('/logs');
    // file= stays in the URL: it says what `line=` is relative to.
    expect(new URLSearchParams(search).get(ARCHIVE_FILE_PARAM)).toBe('console.2026-07-22-11.log.gz');
  });

  it('refuses an unknown file= instead of opening everything', async () => {
    // Falling back to the merged view would read `line=` as a merged number and
    // highlight an unrelated line — worse than no highlight at all.
    mockFetchOk();
    mockSearchParams = new URLSearchParams(
      `?${ARCHIVE_URL_PARAM}=${ARCHIVE_URL}&${ARCHIVE_FILE_PARAM}=nse.2026-07-22-11.log.gz&line=1234`
    );

    renderHook(() => useArchiveUrl());

    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());
    expect(mockOpenMergedEntries).not.toHaveBeenCalled();
    expect((mockNavigate.mock.calls[0][0] as { pathname: string }).pathname).toBe('/');
  });

  it('reuses the archive already in memory for a second link, without re-fetching', async () => {
    mockFetchOk();
    mockSearchParams = new URLSearchParams(
      `?${ARCHIVE_URL_PARAM}=${ARCHIVE_URL}&${ARCHIVE_FILE_PARAM}=console.2026-07-22-11.log.gz&line=10`
    );

    const { rerender } = renderHook(() => useArchiveUrl());
    await waitFor(() => expect(mockOpenMergedEntries).toHaveBeenCalledTimes(1));

    // Same archive, no file → the merged view, still no second download.
    act(() => {
      mockSearchParams = new URLSearchParams(`?${ARCHIVE_URL_PARAM}=${ARCHIVE_URL}&line=20`);
    });
    rerender();

    await waitFor(() => expect(mockOpenMergedEntries).toHaveBeenCalledTimes(2));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mockLoadArchive).toHaveBeenCalledTimes(1);
    expect(mockOpenMergedEntries).toHaveBeenLastCalledWith(['console.2026-07-22-11.log.gz']);
  });

  it('re-opens the very same link when its archive is no longer in memory', async () => {
    mockFetchOk();
    mockSearchParams = new URLSearchParams(`?${ARCHIVE_URL_PARAM}=${ARCHIVE_URL}`);
    const { rerender } = renderHook(() => useArchiveUrl());
    await waitFor(() => expect(mockLoadArchive).toHaveBeenCalledTimes(1));

    // A /decryption step link re-opened another device's archive in between.
    act(() => {
      putInStore('sender.tar.gz', []);
      mockSearchParams = new URLSearchParams(`?${ARCHIVE_URL_PARAM}=${ARCHIVE_URL}`);
    });
    rerender();

    await waitFor(() => expect(mockLoadArchive).toHaveBeenCalledTimes(2));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('re-fetches when another archive has replaced the one in memory', async () => {
    mockFetchOk();
    mockSearchParams = new URLSearchParams(
      `?${ARCHIVE_URL_PARAM}=${ARCHIVE_URL}&${ARCHIVE_FILE_PARAM}=console.2026-07-22-11.log.gz`
    );

    const { rerender } = renderHook(() => useArchiveUrl());
    await waitFor(() => expect(mockLoadArchive).toHaveBeenCalledTimes(1));

    // The user drops a different rageshake in by hand, so the store now holds its
    // entries. A link into the first archive naming another of its files must
    // re-fetch: hourly log names repeat across archives, so resolving `file=`
    // against what happens to be in memory would open the wrong rageshake's log.
    act(() => {
      putInStore('other.tar.gz', [{ name: 'nse.2026-07-22-11.log.gz', data: new Uint8Array() }]);
      mockSearchParams = new URLSearchParams(
        `?${ARCHIVE_URL_PARAM}=${ARCHIVE_URL}&${ARCHIVE_FILE_PARAM}=nse.2026-07-22-11.log.gz`
      );
    });
    rerender();

    await waitFor(() => expect(mockLoadArchive).toHaveBeenCalledTimes(2));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(mockLoadArchive).toHaveBeenLastCalledWith('2026-07-22_112505-FG4DKXZW.tar.gz', ENTRIES);
  });

  it('honours a file= that changed while the archive was still downloading', async () => {
    // A second link into the same rageshake mid-download must not start its own
    // download of it, and must not lose to the file the first link named.
    let releaseFetch: (value: unknown) => void = () => {};
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise((resolve) => { releaseFetch = resolve; })));
    mockSearchParams = new URLSearchParams(
      `?${ARCHIVE_URL_PARAM}=${ARCHIVE_URL}&${ARCHIVE_FILE_PARAM}=nse.2026-07-22-11.log.gz&line=10`
    );

    const { rerender } = renderHook(() => useArchiveUrl());

    act(() => {
      mockSearchParams = new URLSearchParams(
        `?${ARCHIVE_URL_PARAM}=${ARCHIVE_URL}&${ARCHIVE_FILE_PARAM}=console.2026-07-22-11.log.gz&line=20`
      );
    });
    rerender();
    releaseFetch({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) });

    await waitFor(() => expect(mockOpenMergedEntries).toHaveBeenCalled());
    expect(fetch).toHaveBeenCalledTimes(1);
    // The first link named a file ENTRIES does not even hold, so opening it would
    // have failed to the landing page. What the URL names when the archive lands
    // is what opens.
    expect(mockOpenMergedEntries).toHaveBeenCalledTimes(1);
    expect(mockOpenMergedEntries).toHaveBeenCalledWith(['console.2026-07-22-11.log.gz']);
    const [{ pathname }] = mockNavigate.mock.calls[0] as [{ pathname: string }];
    expect(pathname).toBe('/logs');
  });

  it('falls back to the landing page when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    mockSearchParams = new URLSearchParams(`?${ARCHIVE_URL_PARAM}=${ARCHIVE_URL}&line=1234`);

    renderHook(() => useArchiveUrl());

    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());
    const [{ pathname, search }] = mockNavigate.mock.calls[0] as [{ pathname: string; search: string }];
    expect(pathname).toBe('/');
    expect(new URLSearchParams(search).has(ARCHIVE_URL_PARAM)).toBe(false);
    expect(mockOpenMergedEntries).not.toHaveBeenCalled();
  });

  it('falls back to the landing page when the archive holds no analyzable log', async () => {
    mockFetchOk();
    mockOpenMergedEntries.mockResolvedValue(null);
    mockSearchParams = new URLSearchParams(`?${ARCHIVE_URL_PARAM}=${ARCHIVE_URL}`);

    renderHook(() => useArchiveUrl());

    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());
    expect((mockNavigate.mock.calls[0][0] as { pathname: string }).pathname).toBe('/');
  });

  it('drops an empty ?archive= instead of leaving the loading gate up', async () => {
    // App.tsx shows "Loading archive…" while the param is present at all, so an
    // empty value must still be stripped even though there is nothing to fetch.
    mockFetchOk();
    mockSearchParams = new URLSearchParams(`?${ARCHIVE_URL_PARAM}=`);

    renderHook(() => useArchiveUrl());

    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());
    expect(fetch).not.toHaveBeenCalled();
    const [{ pathname, search }] = mockNavigate.mock.calls[0] as [{ pathname: string; search: string }];
    expect(pathname).toBe('/');
    expect(new URLSearchParams(search).has(ARCHIVE_URL_PARAM)).toBe(false);
  });

  it('keeps params that changed while the archive was still downloading', async () => {
    let releaseFetch: (value: unknown) => void = () => {};
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise((resolve) => { releaseFetch = resolve; })));
    mockSearchParams = new URLSearchParams(`?${ARCHIVE_URL_PARAM}=${ARCHIVE_URL}&line=1234`);

    const { rerender } = renderHook(() => useArchiveUrl());

    // The URL gains a filter mid-download; the redirect must not revert it.
    act(() => {
      mockSearchParams = new URLSearchParams(`?${ARCHIVE_URL_PARAM}=${ARCHIVE_URL}&line=1234&filter=sync`);
    });
    rerender();
    releaseFetch({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) });

    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());
    expect(fetch).toHaveBeenCalledTimes(1);
    const [{ search }] = mockNavigate.mock.calls[0] as [{ search: string }];
    const nextParams = new URLSearchParams(search);
    expect(nextParams.get('filter')).toBe('sync');
    expect(nextParams.get('line')).toBe('1234');
  });

  it('still loads the archive under StrictMode, exactly once', async () => {
    // The app runs inside StrictMode, so effects go mount → cleanup → mount in
    // dev. Cancelling the first run's fetch on that cleanup would strand the app
    // on the loading screen, because the second run skips the fetch entirely.
    mockFetchOk();
    mockSearchParams = new URLSearchParams(`?${ARCHIVE_URL_PARAM}=${ARCHIVE_URL}&line=1234`);

    renderHook(() => useArchiveUrl(), { wrapper: StrictMode });

    await waitFor(() => expect(mockLoadArchive).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((mockNavigate.mock.calls[0][0] as { pathname: string }).pathname).toBe('/logs');
  });

  it('drops the param without re-fetching when a second link names the archive already open', async () => {
    // A report cites several lines in one rageshake. Following the second link
    // must not leave the app on the loading screen waiting for a fetch that
    // already happened — the param has to be dropped either way.
    mockFetchOk();
    mockSearchParams = new URLSearchParams(`?${ARCHIVE_URL_PARAM}=${ARCHIVE_URL}&line=1234`);

    const { rerender } = renderHook(() => useArchiveUrl());
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledTimes(1));

    act(() => {
      mockSearchParams = new URLSearchParams(`?${ARCHIVE_URL_PARAM}=${ARCHIVE_URL}&line=5678`);
    });
    rerender();

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledTimes(2));
    expect(fetch).toHaveBeenCalledTimes(1);
    const [{ pathname, search }] = mockNavigate.mock.calls[1] as [{ pathname: string; search: string }];
    expect(pathname).toBe('/logs');
    const nextParams = new URLSearchParams(search);
    expect(nextParams.has(ARCHIVE_URL_PARAM)).toBe(false);
    expect(nextParams.get('line')).toBe('5678');
  });

  it('does not re-fetch the same archive on re-render, but does process a different one', async () => {
    mockFetchOk();
    mockSearchParams = new URLSearchParams(`?${ARCHIVE_URL_PARAM}=${ARCHIVE_URL}`);

    const { rerender } = renderHook(() => useArchiveUrl());
    await waitFor(() => expect(mockLoadArchive).toHaveBeenCalledTimes(1));
    rerender();
    expect(fetch).toHaveBeenCalledTimes(1);

    act(() => {
      mockSearchParams = new URLSearchParams(`?${ARCHIVE_URL_PARAM}=${ARCHIVE_URL}.other`);
    });
    rerender();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });
});
