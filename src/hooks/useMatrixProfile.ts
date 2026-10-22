import { useEffect, useState } from 'react';
import { fetchMatrixProfile } from '../utils/matrixProfile';
import type { MatrixProfile } from '../types/listing';

/**
 * The profile of `userId` fetched from their homeserver (see fetchMatrixProfile), so views can show a face
 * and a name next to a Matrix ID. `null` while loading, without a user, or when the homeserver can't or
 * must not be reached.
 */
export function useMatrixProfile(userId: string | null | undefined): MatrixProfile | null {
  const [loaded, setLoaded] = useState<{ readonly userId: string; readonly profile: MatrixProfile | null } | null>(null);
  useEffect(() => {
    if (!userId) return undefined;
    let cancelled = false;
    void fetchMatrixProfile(userId).then((profile) => {
      if (!cancelled) setLoaded({ userId, profile });
    });
    return () => { cancelled = true; };
  }, [userId]);
  // Keyed by user so a previous user's profile never shows while the next one loads.
  return userId && loaded?.userId === userId ? loaded.profile : null;
}
