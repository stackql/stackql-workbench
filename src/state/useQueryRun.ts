import { useCallback, useReducer, useRef } from 'react';
import { host, toHostError, type HostError, type QueryEvent, type RunSummary } from '../host';
import { applyEvent, emptyRun, failRun, finishRun, startRun, type RunState } from '../lib/results';

type Action =
  | { type: 'start'; runId: string }
  | { type: 'event'; runId: string; event: QueryEvent }
  | { type: 'finish'; runId: string; summary: RunSummary }
  | { type: 'fail'; runId: string; error: HostError };

function reducer(state: RunState, action: Action): RunState {
  if (action.type === 'start') {
    return startRun(action.runId);
  }
  // Drop anything that belongs to a run that is no longer on screen.
  if (state.runId !== action.runId) {
    return state;
  }
  switch (action.type) {
    case 'event':
      return applyEvent(state, action.event);
    case 'finish':
      return finishRun(state, action.summary);
    case 'fail':
      return failRun(state, action.error);
  }
}

let counter = 0;
function nextRunId(): string {
  counter += 1;
  return `run-${Date.now().toString(36)}-${counter}`;
}

export interface QueryRun {
  state: RunState;
  /** Runs the statements in `sql`. Resolves with the summary, or null if the call failed. */
  run: (sql: string) => Promise<RunSummary | null>;
  /** Stops waiting for the current run. The engine has no cancel. */
  stopWaiting: () => void;
}

/** Runs statements on the operator's session and tracks the result. */
export function useQueryRun(): QueryRun {
  const [state, dispatch] = useReducer(reducer, emptyRun);
  const current = useRef<string | null>(null);

  const run = useCallback(async (sql: string): Promise<RunSummary | null> => {
    const runId = nextRunId();
    current.current = runId;
    dispatch({ type: 'start', runId });
    try {
      const summary = await host.runQuery(runId, sql, (event) => {
        dispatch({ type: 'event', runId, event });
      });
      dispatch({ type: 'finish', runId, summary });
      return summary;
    } catch (error) {
      dispatch({ type: 'fail', runId, error: toHostError(error) });
      return null;
    } finally {
      if (current.current === runId) {
        current.current = null;
      }
    }
  }, []);

  const stopWaiting = useCallback(() => {
    const runId = current.current;
    if (runId) {
      void host.abandonQuery(runId).catch(() => undefined);
    }
  }, []);

  return { state, run, stopWaiting };
}
