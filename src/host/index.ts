// The only module in the webview that touches Tauri. Panes call these typed
// wrappers. An ESLint rule keeps Tauri imports out of everything else.

import { Channel, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type {
  Activity,
  AgentConfig,
  AgentEvent,
  ApprovalDecision,
  DelegateInfo,
  EngineStatus,
  Field,
  HostError,
  InferenceSettings,
  Method,
  MethodField,
  Provider,
  ProviderIcon,
  QueryEvent,
  Resource,
  RunSummary,
  SafetyMode,
  Service,
  Settings,
  SettingsView,
  TurnSummary,
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

  /**
   * Icons for the named providers, keyed by provider name. A provider with no
   * icon is absent from the result.
   */
  providerIcons: (providers: string[]) =>
    invoke<Record<string, ProviderIcon>>('provider_icons', { providers }),

  agent: {
    config: () => invoke<AgentConfig>('agent_config_get'),

    /**
     * Saves the chat backend. A key, when given, goes to the OS keychain.
     * Leaving it out keeps the key that is already stored.
     */
    saveConfig: (inference: InferenceSettings, apiKey: string | null) =>
      invoke<AgentConfig>('agent_config_save', { inference, apiKey }),

    /** Removes the chat backend and its stored key. */
    clearConfig: () => invoke<AgentConfig>('agent_config_clear'),

    setSafetyMode: (mode: SafetyMode) => invoke<SafetyMode>('agent_set_safety_mode', { mode }),

    /**
     * Sends a message to the assistant. Events arrive through `onEvent`
     * while the returned promise is pending.
     */
    send(text: string, onEvent: (event: AgentEvent) => void): Promise<TurnSummary> {
      const channel = new Channel<AgentEvent>();
      channel.onmessage = onEvent;
      return invoke<TurnSummary>('agent_send', { text, onEvent: channel });
    },

    /** Delivers the operator's answer to an approval prompt. */
    approve: (approvalId: string, decision: ApprovalDecision) =>
      invoke<boolean>('agent_approve', { approvalId, decision }),

    /** Stops the running turn. A statement already started is not interrupted. */
    stop: () => invoke<boolean>('agent_stop'),

    /** Starts a new conversation. */
    reset: () => invoke('agent_reset'),

    /**
     * Asks a delegated agent for its version and models. This starts the
     * agent and sends no prompt. `program` is where the agent is, or null
     * to search PATH.
     */
    delegateInfo: (program: string | null) =>
      invoke<DelegateInfo>('agent_delegate_info', { program }),
  },

  /** Closes the window, which ends the app and stops the engine. */
  closeWindow: () => getCurrentWindow().close(),

  /** What was run recently, by the operator and by the agent. */
  activity: (limit?: number) => invoke<Activity>('activity_list', { limit }),

  explorer: {
    providers: () => invoke<Provider[]>('explorer_providers'),
    /** What the registry offers, with the version of each. Needs the network. */
    registry: () => invoke<Provider[]>('explorer_registry'),
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
