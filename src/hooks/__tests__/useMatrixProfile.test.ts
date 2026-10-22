import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useMatrixProfile } from '../useMatrixProfile';
import { clearMatrixProfiles } from '../../utils/matrixProfile';

const ok = (body: object) => new Response(JSON.stringify(body), { status: 200 });

describe('useMatrixProfile', () => {
  afterEach(() => {
    clearMatrixProfiles();
    vi.restoreAllMocks();
  });

  it('fetches the profile from the user homeserver', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(ok({ displayname: 'Alice', avatar_url: 'mxc://example.com/abc' }));
    const { result } = renderHook(() => useMatrixProfile('@alice:example.com'));
    await waitFor(() => expect(result.current?.displayName).toBe('Alice'));
    expect(result.current?.avatarHttpUrl).toContain('https://example.com/_matrix/media/v3/thumbnail/example.com/abc');
    expect(fetchSpy).toHaveBeenCalledWith('https://example.com/_matrix/client/v3/profile/%40alice%3Aexample.com');
  });

  it('fetches a user once across hooks', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(ok({ displayname: 'Alice' }));
    const first = renderHook(() => useMatrixProfile('@alice:example.com'));
    await waitFor(() => expect(first.result.current?.displayName).toBe('Alice'));
    const second = renderHook(() => useMatrixProfile('@alice:example.com'));
    await waitFor(() => expect(second.result.current?.displayName).toBe('Alice'));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('retries a user after a network failure', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('offline')).mockResolvedValue(ok({ displayname: 'Alice' }));
    const first = renderHook(() => useMatrixProfile('@alice:example.com'));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(first.result.current).toBeNull();
    const second = renderHook(() => useMatrixProfile('@alice:example.com'));
    await waitFor(() => expect(second.result.current?.displayName).toBe('Alice'));
  });

  it('never shows the previous user while the next one loads', async () => {
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(ok({ displayname: 'Alice' }))
      .mockReturnValueOnce(new Promise(() => {}));
    const { result, rerender } = renderHook(({ userId }) => useMatrixProfile(userId), { initialProps: { userId: '@alice:example.com' } });
    await waitFor(() => expect(result.current?.displayName).toBe('Alice'));
    rerender({ userId: '@bob:example.com' });
    expect(result.current).toBeNull();
  });

  it('gives no profile when the homeserver refuses', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 403 }));
    const { result } = renderHook(() => useMatrixProfile('@alice:example.com'));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(result.current).toBeNull();
  });

  it('gives null fields for a profile without name or avatar', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(ok({}));
    const { result } = renderHook(() => useMatrixProfile('@alice:example.com'));
    await waitFor(() => expect(result.current).toEqual({ displayName: null, avatarHttpUrl: null }));
  });

  it('ignores a profile that arrives after unmount', async () => {
    let resolve: (r: Response) => void = () => {};
    vi.spyOn(global, 'fetch').mockReturnValue(new Promise((r) => { resolve = r; }));
    const { result, unmount } = renderHook(() => useMatrixProfile('@alice:example.com'));
    unmount();
    resolve(ok({ displayname: 'Alice' }));
    await Promise.resolve();
    expect(result.current).toBeNull();
  });

  it('does not fetch without a user or from a non-public homeserver', () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    renderHook(() => useMatrixProfile(undefined));
    renderHook(() => useMatrixProfile('@alice:localhost'));
    renderHook(() => useMatrixProfile('alice'));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
