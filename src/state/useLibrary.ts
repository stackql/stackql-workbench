import { useCallback, useEffect, useState } from 'react';
import { host, toHostError, type LibraryIndex } from '../host';

export interface LibraryState {
  /** Null until the index has been read. */
  index: LibraryIndex | null;
  /** Why there is no index, when there is none. */
  error: string | null;
  loading: boolean;
  /** Asks the host for a new copy of the index. */
  refresh: () => void;
}

/** The query library's index. The host fetches it and keeps a copy. */
export function useLibrary(): LibraryState {
  const [index, setIndex] = useState<LibraryIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Counts requests. Zero is the first, which takes a kept copy if there is one.
  const [request, setRequest] = useState(0);
  const [settled, setSettled] = useState(-1);

  useEffect(() => {
    let active = true;
    host.library
      .index(request > 0)
      .then(
        (loaded) => {
          if (active) {
            setIndex(loaded);
            setError(null);
          }
        },
        (reason: unknown) => {
          if (active) {
            setError(toHostError(reason).message);
          }
        },
      )
      .finally(() => {
        if (active) {
          setSettled(request);
        }
      });
    return () => {
      active = false;
    };
  }, [request]);

  const refresh = useCallback(() => {
    setRequest((current) => current + 1);
  }, []);

  return { index, error, loading: settled !== request, refresh };
}
