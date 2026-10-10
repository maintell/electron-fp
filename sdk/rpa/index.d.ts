// @fp-automation/rpa — types. The AST node schema is defined by the runtime
// (automation/runtime/rpa-ast.js); these types mirror it.

export interface Cond {
  op: '==' | '!=' | '>' | '<' | '>=' | '<=' | 'contains' | 'truthy';
  left: unknown;
  right?: unknown;
}
export interface AstNode {
  type: string;
  then?: AstNode[];
  else?: AstNode[];
  body?: AstNode[];
  catchBody?: AstNode[];
  [field: string]: unknown;
}
export interface Ast {
  nodes: AstNode[];
}
export interface ValidationResult {
  ok: boolean;
  errors: string[];
}
export interface CompileResult {
  code: string;
  metadata: { nodes: number; ceiling: string };
}

export function ref(x: unknown): unknown;
export function v(name: string): unknown;
export function p(name: string): unknown;

export class Flow {
  nodes: AstNode[];
  add(node: AstNode): this;
  goto(url: string): this;
  click(selector: string): this;
  clickText(text: string): this;
  clickRole(role: string): this;
  fill(selector: string, value: unknown): this;
  type(selector: string, text: string): this;
  press(selector: string, key: string): this;
  select(selector: string, value: unknown): this;
  wait(spec: Record<string, unknown>): this;
  readText(selector: string, outVar?: string): this;
  readAttr(selector: string, name: string, outVar?: string): this;
  scroll(opts: Record<string, unknown>): this;
  upload(selector: string, files: string[]): this;
  downloadWait(pattern: string): this;
  screenshot(outVar?: string): this;
  execJs(expression: string, outVar?: string): this;
  setVar(name: string, value: unknown): this;
  log(msg: string): this;
  throwError(message: string): this;
  label(name: string): this;
  gotoLabel(label: string): this;
  if(cond: Cond, thenFn?: (f: Flow) => void, elseFn?: (f: Flow) => void): this;
  loop(times: number, bodyFn?: (f: Flow) => void): this;
  forEach(expr: string, bodyFn?: (f: Flow) => void): this;
  try(bodyFn?: (f: Flow) => void, catchFn?: (f: Flow) => void, catchName?: string): this;
  toAst(): Ast;
  toJson(): string;
}

export function flow(): Flow;
export function createAst(): unknown;
export function validateAst(nodes: AstNode[]): ValidationResult;
export function astToScript(ast: Ast | AstNode[] | string): CompileResult;
export function runAst(...args: unknown[]): Promise<unknown>;
export class RpaError extends Error {}
