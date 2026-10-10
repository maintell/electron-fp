// @fp-automation/core — ambient types. Capability surface mirrors
// automation/automation.d.ts (the runtime's permission surface). This file is
// the type truth source for the external SDK (doc 14 / doc 12 N2).

export const SDK_VERSION: string;

export interface Capabilities {
  store: boolean;
  queue: boolean;
  scheduler: boolean;
  profiles: boolean;
}

export interface Envelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
  created?: boolean;
}

export interface ConnectOptions {
  url: string;
  token: string;
  wsUrl?: string;
  required?: Array<keyof Capabilities>;
}

export class SdkError extends Error {
  code: string | null;
  status: number | null;
}
export class ConfigError extends SdkError {}
export class HttpError extends SdkError {}
export class WsError extends SdkError {}
export class CapabilityError extends SdkError {}
export class ValidationError extends SdkError {}
export class NotFoundError extends SdkError {}
export class LimitError extends SdkError {}
export class PermissionError extends SdkError {}
export class NotImplementedError extends SdkError {}
export class InternalError extends SdkError {}

export interface ScriptMeta {
  name?: string;
  description?: string;
  parameters?: unknown[];
  permissions?: Record<string, boolean>;
  trusted?: boolean;
}

export interface RunOpts {
  version?: number;
  params?: Record<string, unknown>;
  profileContext?: { id: string };
}

export class Client {
  version: string;
  capabilities: Capabilities | null;
  handshake(opts?: { required?: Array<keyof Capabilities> }): Promise<Capabilities>;
  status(): Promise<{ service: string; components: Record<string, unknown>; uptimeSec: number }>;
  readonly scripts: {
    list(): Promise<unknown>;
    get(id: string): Promise<unknown>;
    create(meta: ScriptMeta): Promise<unknown>;
    update(id: string, patch: Partial<ScriptMeta>): Promise<unknown>;
    remove(id: string): Promise<unknown>;
    run(id: string, opts?: RunOpts): Promise<{ executionId: string }>;
    saveVersion(id: string, code: string, version?: number): Promise<unknown>;
    exportOne(id: string): Promise<unknown>;
    importOne(doc: unknown): Promise<unknown>;
  };
  readonly executions: {
    list(q?: Record<string, unknown>): Promise<unknown>;
    get(id: string): Promise<unknown>;
    logs(id: string): Promise<unknown>;
    cancel(id: string): Promise<unknown>;
  };
  readonly tasks: {
    list(q?: Record<string, unknown>): Promise<unknown>;
    get(id: string): Promise<unknown>;
    enqueue(body: unknown): Promise<unknown>;
    pause(id: string, interrupt?: boolean): Promise<unknown>;
    resume(id: string): Promise<unknown>;
    cancel(id: string): Promise<unknown>;
  };
  readonly schedules: {
    list(q?: Record<string, unknown>): Promise<unknown>;
    add(body: unknown): Promise<unknown>;
    remove(id: string): Promise<unknown>;
    pause(id: string): Promise<unknown>;
    resume(id: string): Promise<unknown>;
    trigger(id: string): Promise<unknown>;
  };
  readonly profiles: {
    list(q?: Record<string, unknown>): Promise<unknown>;
    get(id: string): Promise<unknown>;
    status(id: string): Promise<unknown>;
    start(id: string): Promise<unknown>;
    stop(id: string): Promise<unknown>;
  };
  on(event: string, fn: (msg: unknown) => void): () => void;
  call(method: string, params?: Record<string, unknown>): Promise<unknown>;
  subscribe(executionId: string): Promise<unknown>;
  close(): Promise<void>;
}

export function connect(opts: ConnectOptions): Promise<Client>;
export function deriveCapabilities(statusEnvelope: Envelope): Capabilities;
export const errors: Record<string, typeof SdkError>;
