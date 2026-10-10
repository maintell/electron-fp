// @fp-automation/browser — types. Namespace/method names mirror
// automation/automation.d.ts (the runtime permission surface).

export interface Transport {
  invoke(namespace: string, method: string, args: unknown[]): Promise<unknown>;
}

export interface Namespace {
  [method: string]: (...args: unknown[]) => Promise<unknown>;
}

export interface BrowserLayer {
  transport: Transport;
  browser: Namespace;
  page: Namespace;
  cookies: Namespace;
  storage: { local: Namespace; session: Namespace };
  network: Namespace;
  download: Namespace;
  upload: Namespace;
  dialog: Namespace;
}

export const METHODS: Record<string, string[]>;
export function methodCount(): number;
export function createNamespace(namespace: string, transport: Transport): Namespace;
export function createBrowserLayer(opts: { transport: Transport }): BrowserLayer;
export function recordTransport(): Transport & { calls: Array<{ ns: string; method: string; args: unknown[] }> };

export interface Composer extends Transport {
  ops: Array<{ ns: string; method: string; args: unknown[] }>;
  toScript(): string;
}
export function createComposer(): Composer;
export function submitVia(
  client: unknown,
  composer: Composer,
  opts?: { name?: string }
): Promise<{ scriptId: string; code: string; stored: unknown }>;
