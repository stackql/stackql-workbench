import { useEffect, useState } from 'react';
import { host, type EngineStatus } from '../host';

const unknown: EngineStatus = {
  state: 'starting',
  location: null,
  locationSource: null,
  version: null,
  endpoint: null,
  error: null,
  logTail: [],
};

/** The engine status, kept current from host events. */
export function useEngineStatus(): EngineStatus {
  const [status, setStatus] = useState<EngineStatus>(unknown);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;

    // Subscribe first, then read, so a change between the two is not lost.
    void host
      .onEngineStatus((next) => {
        if (active) {
          setStatus(next);
        }
      })
      .then((stop) => {
        if (active) {
          unsubscribe = stop;
        } else {
          stop();
        }
        return host.engineStatus();
      })
      .then((current) => {
        if (active) {
          setStatus(current);
        }
      })
      .catch(() => {
        // Not running inside the app shell. Leave the placeholder status.
      });

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  return status;
}
