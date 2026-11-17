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
  error: string | null;
  /** The last lines the engine wrote to stderr. */
  logTail: string[];
}

export interface Settings {
  /** Explicit location of the stackql binary. Null means search for it. */
  enginePath: string | null;
  /** A dotenv file the engine sources at startup. The app never reads it. */
  envFile: string | null;
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

/** What a rejected host call carries. */
export interface HostError {
  kind: string;
  message: string;
}

export interface Provider {
  name: string;
  version: string;
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
