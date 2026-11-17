// The only module in the webview that touches Tauri. Panes call these typed
// wrappers. An ESLint rule keeps Tauri imports out of everything else.

import { Channel, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  EngineStatus,
  Field,
  HostError,
  Method,
  MethodField,
  Provider,
  QueryEvent,
  Resource,
  RunSummary,
  Service,
  Settings,
  SettingsView,
} from './types';

export type * from './types';

const ENGINE_STATUS_EVENT = 'engine-status';

/** Turns whatever a host call rejected with into a `HostError`. */
export function toHostError(value: unknown): HostError {
  if (typeof value === 'object' && value !== null) {
    const candidate = value as { kind?: unknown; message?: unknown };
    if (typeof candidate.kind === 'string' && typeof candidate.message === 'string') {
      return { kind: candidate.kind, message: candidate.message };
    }
    if (value instanceof Error) {
      return { kind: 'internal', message: value.message };
    }
  }
  return { kind: 'internal', message: typeof value === 'string' ? value : 'Unknown error.' };
}

export const host = {
  engineStatus: () => invoke<EngineStatus>('engine_status'),

  /** Stops and starts the engine. Also the only way to stop a running statement. */
  engineRestart: () => invoke<EngineStatus>('engine_restart'),

  /** Calls `handler` on every status change. Returns a function that unsubscribes. */
  async onEngineStatus(handler: (status: EngineStatus) => void): Promise<() => void> {
    return listen<EngineStatus>(ENGINE_STATUS_EVENT, (event) => {
      handler(event.payload);
    });
  },

  settingsGet: () => invoke<SettingsView>('settings_get'),

  /** Saves settings. The engine restarts if a setting it depends on changed. */
  settingsSave: (settings: Settings) => invoke<Settings>('settings_save', { settings }),

  /**
   * Runs the statements in `sql` on the operator's session. Events arrive
   * through `onEvent` while the returned promise is pending.
   */
  runQuery(runId: string, sql: string, onEvent: (event: QueryEvent) => void): Promise<RunSummary> {
    const channel = new Channel<QueryEvent>();
    channel.onmessage = onEvent;
    return invoke<RunSummary>('query_run', { runId, sql, onEvent: channel });
  },

  /** Stops waiting for a run. The engine has no cancel. */
  abandonQuery: (runId: string) => invoke<boolean>('query_abandon', { runId }),

  explorer: {
    providers: () => invoke<Provider[]>('explorer_providers'),
    services: (provider: string) => invoke<Service[]>('explorer_services', { provider }),
    resources: (provider: string, service: string) =>
      invoke<Resource[]>('explorer_resources', { provider, service }),
    methods: (provider: string, service: string, resource: string) =>
      invoke<Method[]>('explorer_methods', { provider, service, resource }),
    fields: (provider: string, service: string, resource: string) =>
      invoke<Field[]>('explorer_fields', { provider, service, resource }),
    methodFields: (provider: string, service: string, resource: string, method: string) =>
      invoke<MethodField[]>('explorer_method_fields', { provider, service, resource, method }),
  },
};

export type Host = typeof host;
