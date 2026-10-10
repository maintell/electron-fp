// Type surface for Script IDE (Phase 3) — source of truth: docs/automation/script-sdk.md; keep in sync.
// Ambient declarations only (Monaco addExtraLib). No Electron/Node built-in types allowed here —
// the declaration surface IS the permission surface (script-sdk.md §5).

// ---------------------------------------------------------------------------
// Option / shared types
// ---------------------------------------------------------------------------

type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle';

interface NavOpts {
  timeout?: number;
  waitUntil?: WaitUntil;
}

interface ActionOpts {
  timeout?: number;
}

interface WaitOpts {
  timeout?: number;
}

type WaitSpec =
  | { selector: string; state: 'attached' | 'visible' | 'hidden'; timeout?: number }
  | { text: string | RegExp; selector?: string; timeout?: number }
  | { url: string | RegExp; timeout?: number }
  | { navigation: true; timeout?: number }
  | { networkIdle: { idleMs?: number }; timeout?: number }
  | { response: string | RegExp; timeout?: number }
  | { request: string | RegExp; timeout?: number }
  | { function: string | ((...args: unknown[]) => boolean); args?: unknown[]; timeout?: number };

interface ScreenshotOpts {
  path?: string;
  fullPage?: boolean;
  format?: 'png' | 'jpeg';
}

/** Minimal network shapes — script-sdk.md names Response/Request without further fields. */
interface Response {
  readonly url: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
}

interface Request {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
}

interface RouteFulfill {
  body?: Uint8Array | string;
  status?: number;
  headers?: Record<string, string>;
}

interface Route {
  abort(): Promise<void>;
  continue(): Promise<void>;
  fulfill(response?: RouteFulfill): Promise<void>;
}

interface Cookie {
  name: string;
  value: string;
  url?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expires?: number;
}

interface CookieFilter {
  name?: string;
  url?: string;
}

interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// §2.1 Browser
// ---------------------------------------------------------------------------

interface Browser {
  goto(url: string, opts?: NavOpts): Promise<void>;
  back(opts?: NavOpts): Promise<void>;
  forward(opts?: NavOpts): Promise<void>;
  reload(opts?: NavOpts): Promise<void>;
  /** Closes the window held by the current BrowserSession; does not destroy ProfileContext. */
  close(): Promise<void>;
  screenshot(opts?: ScreenshotOpts): Promise<Uint8Array>;
  getCurrentUrl(): Promise<string>;
  getTitle(): Promise<string>;
}

// ---------------------------------------------------------------------------
// §2.2 Page
// ---------------------------------------------------------------------------

interface Page {
  // positioning
  locator(selector: string): Locator;

  // quick actions (= page.locator(s).click() etc.)
  click(selector: string, opts?: ActionOpts): Promise<void>;
  fill(selector: string, value: string, opts?: ActionOpts): Promise<void>;
  type(selector: string, text: string, opts?: ActionOpts & { delay?: number }): Promise<void>;
  press(selector: string, key: string, opts?: ActionOpts): Promise<void>;
  getText(selector: string, opts?: { timeout?: number }): Promise<string>;
  getAttribute(selector: string, name: string, opts?: { timeout?: number }): Promise<string | null>;
  waitForSelector(
    selector: string,
    opts?: { state?: 'attached' | 'visible' | 'hidden'; timeout?: number }
  ): Promise<void>;
  /** Debug-only escape hatch — never the default wait strategy (script-sdk.md §2.2 hard rule). */
  waitForTimeout(ms: number): Promise<void>;

  // restricted evaluation: timeout + return-value truncation/scrubbing applied by Runtime
  evaluate<T = unknown>(fn: string | ((...args: unknown[]) => T), ...args: unknown[]): Promise<T>;

  // smart waits (all sugar over page.wait)
  waitForVisible(selector: string, opts?: WaitOpts): Promise<void>;
  waitForHidden(selector: string, opts?: WaitOpts): Promise<void>;
  waitForText(selector: string, text: string | RegExp, opts?: WaitOpts): Promise<void>;
  waitForURL(url: string | RegExp, opts?: WaitOpts): Promise<void>;
  waitForNavigation(opts?: NavOpts): Promise<void>;
  waitForNetworkIdle(opts?: { idleMs?: number; timeout?: number }): Promise<void>;
  waitForResponse(urlPattern: string | RegExp, opts?: WaitOpts): Promise<Response>;
  waitForRequest(urlPattern: string | RegExp, opts?: WaitOpts): Promise<Request>;
  waitForFunction(fn: string | ((...args: unknown[]) => boolean), ...args: unknown[]): Promise<void>;

  /** Unified entry — every waitFor* above is named sugar over this. */
  wait(spec: WaitSpec): Promise<void>;
}

// ---------------------------------------------------------------------------
// §2.3 Locator (ElementHandle)
// ---------------------------------------------------------------------------

interface Locator {
  click(opts?: ActionOpts): Promise<void>;
  fill(value: string, opts?: ActionOpts): Promise<void>;
  type(text: string, opts?: ActionOpts & { delay?: number }): Promise<void>;
  text(): Promise<string>;
  attribute(name: string): Promise<string | null>;
  visible(): Promise<boolean>;
  /** CSS pixels; null = not laid out / not visible. */
  boundingBox(): Promise<BoundingBox | null>;
}

// ---------------------------------------------------------------------------
// §2.4 cookies / storage / network / download / upload / dialog
// ---------------------------------------------------------------------------

interface CookieManager {
  get(filter?: CookieFilter): Promise<Cookie[]>;
  set(cookies: Cookie[]): Promise<void>;
  delete(filter: CookieFilter): Promise<void>;
  /** Scoped to the current ProfileContext partition only. */
  clear(): Promise<void>;
}

interface StorageArea {
  get(key?: string): Promise<Record<string, unknown> | unknown>;
  set(items: Record<string, unknown>): Promise<void>;
}

interface StorageManager {
  local: StorageArea;
  session: StorageArea;
}

type InterceptHandler = (
  route: Route
) => Promise<void | RouteFulfill>;

interface NetworkManager {
  intercept(
    pattern: string | RegExp,
    handler: InterceptHandler,
    opts?: { times?: number }
  ): Promise<void>;
  waitForRequest(urlPattern: string | RegExp, opts?: WaitOpts): Promise<Request>;
  waitForResponse(urlPattern: string | RegExp, opts?: WaitOpts): Promise<Response>;
}

interface DownloadItem {
  suggestedFilename: string;
  path: string;
}

interface DownloadManager {
  wait(pattern: string | RegExp, opts?: WaitOpts): Promise<DownloadItem>;
  /** Path must pass the fence, else PermissionError. */
  save(target: DownloadItem, destPath: string): Promise<string>;
}

interface UploadManager {
  /** File paths must be inside an authorized directory (trusted-script fence). */
  setFiles(selector: string, files: string[]): Promise<void>;
}

interface DialogManager {
  accept(promptText?: string): Promise<void>;
  dismiss(): Promise<void>;
}

// ---------------------------------------------------------------------------
// §4 fingerprint.update gate
// ---------------------------------------------------------------------------

type FingerprintPlane = 'blink' | 'ua' | 'tls' | 'h2';

type FingerprintUpdateResult =
  | { ok: true; planes: FingerprintPlane[]; restartRequired: boolean }
  | { ok: false; plane?: string; error: string };

interface FingerprintHandle {
  /** Read-only snapshot — mutations only via update() (five-gate path, script-sdk.md §4). */
  readonly [key: string]: unknown;
  update(
    config: Record<string, unknown>,
    opts?: { bearerToken?: string }
  ): Promise<FingerprintUpdateResult>;
}

// ---------------------------------------------------------------------------
// §2.5 context — ProfileContext (in-script identity handle)
// ---------------------------------------------------------------------------

interface ProfileInfo {
  readonly id: string;
  readonly name: string;
  readonly groupId: string | null;
  readonly proxy: string | null;
  readonly platform: string;
  readonly browserVersion: string;
  readonly fingerprint: FingerprintHandle;
  readonly sessionId: string;
}

interface ProfileSnapshot {
  readonly id: string;
  readonly name: string;
  /** Redacted: no proxy password, no fingerprint carrier payloads. */
  readonly [key: string]: unknown;
}

type ProfilePatch = Record<string, unknown>;

type ProfileUpdateResult =
  | { ok: true; [key: string]: unknown }
  | { ok: false; error: string; [key: string]: unknown };

interface AutomationContext {
  readonly profile: ProfileInfo;
  get(): Promise<ProfileSnapshot>;
  /** Routed through Profile Manager + gates; never a direct write. */
  update(patch: ProfilePatch): Promise<ProfileUpdateResult>;
  cookies: CookieManager;
  storage: StorageManager;
  screenshot(opts?: { fullPage?: boolean }): Promise<Uint8Array>;
}

/** Cross-profile is explicit-only: profiles.get(id) + bidirectional ACL (script-sdk.md §3). */
interface ForeignProfileContext extends AutomationContext {}

interface ProfilesApi {
  get(id: string): Promise<ForeignProfileContext>;
}

// ---------------------------------------------------------------------------
// §2.6 params / script metadata (script-store.js shapes)
// ---------------------------------------------------------------------------

type ParamType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'select'
  | 'multi-select'
  | 'secret'
  | 'file'
  | 'textarea'
  | 'JSON';

type ParamValue = string | number | boolean | string[] | Record<string, unknown>;

interface ScriptParameter {
  name: string;
  type: ParamType;
  required: boolean;
  default?: unknown;
  /** Required non-empty for select / multi-select; forbidden otherwise. */
  options?: string[];
  /** true => stored as reference only, scrubbed from logs, never echoed. */
  secret?: boolean;
}

/** script-store.js CAP_KEYS — capability / permission key union. */
type PermissionKey =
  | 'browser'
  | 'cookies'
  | 'storage'
  | 'network'
  | 'filesystem'
  | 'process'
  | 'profile'
  | 'screenshot'
  | 'upload'
  | 'clipboard';

type Permissions = Partial<Record<PermissionKey, boolean>>;

interface ScriptMetadata {
  id?: string;
  name: string;
  author?: string;
  description?: string;
  category?: string;
  /** Entry file, default 'main.js'. */
  entry?: string;
  /** Latest/newest version string (store keeps versions newest-first). */
  version?: string;
  permissions: Permissions;
  parameters: ScriptParameter[];
  code?: string;
  versions?: Array<{ version: string; createdAt: string }>;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string;
}

// ---------------------------------------------------------------------------
// §6.1 error taxonomy (script-runner.js — 9 exported classes)
// ---------------------------------------------------------------------------

declare class ScriptError extends Error {
  constructor(message: string);
  readonly code: string;
  readonly retriable: boolean;
}

declare class TimeoutError extends ScriptError {
  constructor(message: string);
  readonly retriable: true;
}

declare class SelectorError extends ScriptError {
  constructor(message: string);
  readonly retriable: boolean;
}

declare class BrowserError extends ScriptError {
  constructor(message: string);
  readonly retriable: boolean;
}

declare class NetworkError extends ScriptError {
  constructor(message: string);
  readonly retriable: true;
}

declare class PermissionError extends ScriptError {
  constructor(message: string);
  readonly retriable: false;
}

declare class ProfileError extends ScriptError {
  constructor(message: string);
  readonly retriable: false;
}

declare class DownloadError extends ScriptError {
  constructor(message: string);
  readonly retriable: boolean;
}

declare class UploadError extends ScriptError {
  constructor(message: string);
  readonly retriable: false;
}

// ---------------------------------------------------------------------------
// Execution record (script-runner.js run() record shape)
// ---------------------------------------------------------------------------

type ExecutionStatus = 'RUNNING' | 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'CANCELLED' | 'CRASHED';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

interface ExecutionLogEntry {
  ts: number;
  level: LogLevel;
  args: unknown[];
}

interface ExecutionRecord {
  executionId: string;
  scriptId?: string;
  scriptVersion?: string;
  profileId: string | null;
  status: ExecutionStatus;
  startTime: number;
  endTime: number | null;
  durationMs: number | null;
  error: { name: string; message: string; stack: string | null } | null;
  currentStep: string | null;
  currentUrl: string | null;
  logs: ExecutionLogEntry[];
  result?: unknown;
}

// ---------------------------------------------------------------------------
// Injected script globals (script-sdk.md §5)
// ---------------------------------------------------------------------------

declare const browser: Browser;
declare const page: Page;
declare const context: AutomationContext;
declare const cookies: CookieManager;
declare const storage: StorageManager;
declare const network: NetworkManager;
declare const download: DownloadManager;
declare const upload: UploadManager;
declare const dialog: DialogManager;
declare const params: Readonly<Record<string, unknown>>;
declare const profiles: ProfilesApi;

interface ScriptConsole {
  log(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}
declare const console: ScriptConsole;

/** Marks current step on the ExecutionRecord (currentStep + info log). */
declare function step(name: string): void;

// filesystem/process: default deny (script-store.js DEFAULT_PERMISSIONS); injected only when
// permissions bit true AND script trusted === true (signed + audited + fenced — script-runner.js capAllowed).
declare const filesystem: unknown;
declare const process: unknown;
