// Types that cross IPC. They mirror the serialised Rust types in
// src-tauri/src. Keep the two in step.

export type EngineState = 'stopped' | 'starting' | 'running' | 'failed';

export interface EngineStatus {
  state: EngineState;
  /** Where the engine is. For a local engine, the path of the binary. */
  location: string | null;
  /** How the location was found, for example "PATH" or "settings". */
  locationSource: string | null;
  version: string | null;
  /** The address statements are sent to. */
  endpoint: string | null;
  /** Where the engine keeps its provider cache, when that is on this machine. */
  dataFolder: string | null;
  /** How the data folder was chosen, for example "settings". */
  dataFolderSource: string | null;
  /** Set when the data folder is not the expected one, with the reason. */
  dataFolderNote: string | null;
  error: string | null;
  /** The last lines the engine wrote to stderr. */
  logTail: string[];
}

/** What the agent may do without asking. The engine enforces it. */
export type SafetyMode = 'read_only' | 'safe' | 'delete_safe' | 'full_access';

export type BackendKind = 'gemini' | 'anthropic' | 'openai_compatible' | 'github_copilot';

/** Which model the chat uses. The API key is never part of this. */
export interface InferenceSettings {
  kind: BackendKind;
  /** Empty means the backend's default model. */
  model: string;
  /** Null means the backend's default address. */
  baseUrl: string | null;
  /** For a delegated agent: where its program is. Null searches PATH. */
  program: string | null;
  /** For a delegated agent: whether it may split work across subagents. */
  subagents: boolean;
}

export interface Settings {
  /** Explicit location of the stackql binary. Null means search for it. */
  enginePath: string | null;
  /** A dotenv file the engine sources at startup. The app never reads it. */
  envFile: string | null;
  /** The engine's data folder, its --approot. Null means the default. */
  approot: string | null;
  safetyMode: SafetyMode;
  /** Null means chat is not configured. */
  inference: InferenceSettings | null;
}

export interface SettingsView {
  settings: Settings;
  warning: string | null;
}

/** One row. Values are text, or null for a protocol NULL. */
export type Row = (string | null)[];

export interface Notice {
  severity: string;
  code: string;
  message: string;
  /** For this engine the useful text is here. */
  detail: string | null;
}

export interface QueryError {
  severity: string | null;
  code: string | null;
  message: string;
  connectionLost: boolean;
}

export type QueryEvent =
  | { event: 'statementStarted'; data: { index: number; total: number; sql: string } }
  | { event: 'columns'; data: { index: number; columns: string[] } }
  | { event: 'rows'; data: { index: number; rows: Row[] } }
  | { event: 'notice'; data: { index: number; notice: Notice } }
  | { event: 'engineLog'; data: { index: number; lines: string[] } }
  | { event: 'statementFinished'; data: { index: number; rowCount: number; elapsedMs: number } }
  | { event: 'statementFailed'; data: { index: number; error: QueryError; elapsedMs: number } };

export interface RunSummary {
  statements: number;
  completed: number;
  failed: boolean;
  /** The operator stopped waiting. The statement may still complete in the engine. */
  abandoned: boolean;
  elapsedMs: number;
}

/** One entry of the query library, as its index describes it. */
export interface LibraryEntry {
  /** For example github/repos/org-repos-list. */
  id: string;
  title: string;
  description: string;
  providers: string[];
  services: string[];
  tags: string[];
  keywords: string[];
  intentKeywords: string[];
  /** The library's own word on whether the statement changes anything. */
  mutation: boolean;
  verb: string;
  /** For example stable or draft. */
  status: string;
  requiredParams: string[];
}

export interface LibraryIndex {
  entries: LibraryEntry[];
  buildId: string;
  /** The library could not be reached. This is the copy kept from an earlier time. */
  fromCache: boolean;
}

export interface LibraryDocument {
  id: string;
  /** The entry's document, without its front matter. */
  markdown: string;
  /** The entry's statement, a template with {{name}} where a value goes. */
  statement: string | null;
}

/** One of the app's own links. The host holds the address. */
export type AppLink = 'docs' | 'queryLibrary' | 'issues';

/** What a rejected host call carries. */
export interface HostError {
  kind: string;
  message: string;
}

export interface Provider {
  name: string;
  version: string;
}

export interface ProviderIcon {
  /** The image as a data: URL. */
  dataUrl: string;
  /** The icon is dark on a transparent background and needs inverting on a dark surface. */
  invertOnDark: boolean;
  /** For example "Amazon Web Services". */
  displayName: string;
}

export interface Service {
  name: string;
  id: string;
  title: string;
  description: string;
}

export interface Resource {
  name: string;
  /** The fully qualified name. */
  id: string;
  description: string;
}

export interface Method {
  name: string;
  sqlVerb: string;
  requiredParams: string[];
  description: string;
}

export interface Field {
  name: string;
  type: string;
  description: string;
}

export interface MethodField {
  name: string;
  type: string;
  /** input_required, input_optional or output. */
  paramType: string;
  shape: string;
  description: string;
}

export interface BackendOption {
  kind: BackendKind;
  defaultModel: string;
  defaultBaseUrl: string;
  /** A local server usually needs no key. */
  keyOptional: boolean;
  /** Whether a key for this backend is in the keychain. Each backend keeps its own. */
  keyStored: boolean;
  /**
   * An agent the operator installed runs the model. There is no key and no
   * address to enter, and no approval prompt.
   */
  delegated: boolean;
}

/** A model an API key backend offers, as its provider lists it. */
export interface ModelOption {
  /** What goes in the settings and on the wire. */
  id: string;
  /** What the provider calls it. The id when it gives no name. */
  name: string;
}

/** What a path in the settings is for. The host picks the dialog to match. */
export type PathPurpose = 'engine' | 'dataFolder' | 'envFile' | 'agent';

/** A model a delegated agent offers. */
export interface AgentModel {
  id: string;
  name: string;
  description: string;
  /** What a request costs against the operator's plan, for example "1x". */
  usage: string | null;
}

/** What a delegated agent says about itself. */
export interface DelegateInfo {
  version: string;
  currentModel: string | null;
  models: AgentModel[];
}

/** What the webview may know about the chat setup. Never the key itself. */
export interface AgentConfig {
  /** Null means no model backend is set up yet. */
  inference: InferenceSettings | null;
  safetyMode: SafetyMode;
  backends: BackendOption[];
  /** False when keys cannot be kept in the OS keychain on this machine. */
  keychainAvailable: boolean;
}

/** The engine asks the operator before it runs something. */
export interface ApprovalRequest {
  id: string;
  /** The engine's message, exactly as sent. */
  message: string;
  tool: string | null;
  /** The engine's classification, for example mutation_delete. */
  queryClass: string | null;
  /** The exact SQL. */
  sql: string | null;
}

export type ApprovalDecision = 'accept' | 'decline' | 'cancel';

/** A row result from a tool, in the shape the grid uses. */
export interface AgentTable {
  columns: string[];
  rows: Row[];
  /** Rows the tool returned, which can be more than were sent on. */
  totalRows: number;
  truncated: boolean;
}

export type AgentEvent =
  | {
      event: 'sessionStarted';
      data: { mode: SafetyMode; protocolVersion: string; tools: number };
    }
  | {
      event: 'delegateStarted';
      data: {
        mode: SafetyMode;
        /** The agent's name, for example "GitHub Copilot CLI". */
        agent: string;
        version: string;
        /** The protocol it is driven over, for example "ACP 1". */
        protocol: string;
        model: string | null;
        tools: number;
      };
    }
  | { event: 'assistantText'; data: { text: string } }
  /** A piece of the reply as it is written. Pieces with one id are one message. */
  | { event: 'assistantDelta'; data: { id: string; text: string } }
  | {
      event: 'toolCallStarted';
      data: {
        id: string;
        tool: string;
        arguments: unknown;
        sql: string | null;
        /** The subagent that made the call. Absent for the main agent. */
        agent?: string;
        /** Which of the model's steps in this turn asked for the call. */
        step: number;
      };
    }
  | { event: 'approvalRequested'; data: { request: ApprovalRequest } }
  | {
      event: 'toolCallFinished';
      data: {
        id: string;
        isError: boolean;
        text: string;
        table: AgentTable | null;
        /** Provider API failures the engine reported while the tool ran. */
        engineNotes: string[];
        elapsedMs: number;
      };
    }
  | { event: 'notice'; data: { message: string } };

export type StopReason =
  | { kind: 'endTurn' }
  | { kind: 'toolUse' }
  | { kind: 'maxTokens' }
  | { kind: 'refused'; detail: string }
  | { kind: 'other'; detail: string };

export interface TurnSummary {
  /** Calls made to the model. */
  steps: number;
  toolCalls: number;
  /** The operator stopped the turn. */
  stopped: boolean;
  stop: StopReason;
  usage: TokenUsage;
}

/**
 * What a turn used, added up over every call to the model in it. A count is
 * null when the provider did not report it, which is not the same as zero.
 */
export interface TokenUsage {
  /** Everything the model was sent, what was read from a cache included. */
  inputTokens: number | null;
  /** Everything the model wrote, with its thinking where the provider counts it. */
  outputTokens: number | null;
  /** The part of the input the provider read from its cache. */
  cachedInputTokens: number | null;
}

/** One statement the operator ran. */
export interface HistoryEntry {
  timestampMs: number;
  sql: string;
  /** ok, error or abandoned. */
  outcome: string;
  rows: number | null;
  elapsedMs: number;
  error: string | null;
}

/** One record from the engine's agent audit log. */
export interface AuditRecord {
  /** RFC 3339. */
  timestamp: string;
  tool: string;
  mode: string;
  /** For example allow, refuse_immediate or needs_approval_declined. */
  decision: string;
  queryClass: string;
  sql: string | null;
  durationMs: number | null;
  error: string | null;
}

export interface Activity {
  operator: HistoryEntry[];
  agent: AuditRecord[];
}
