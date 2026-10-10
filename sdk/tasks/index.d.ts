// @fp-automation/tasks — types.
import { Client } from '@fp-automation/core';

export type TaskStatus =
  | 'CREATED' | 'QUEUED' | 'STARTING' | 'RUNNING' | 'PAUSED' | 'STOPPING'
  | 'RETRYING' | 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'TIMEOUT' | 'CRASHED';

export interface TaskItem {
  id: string;
  scriptId: string;
  version?: number;
  params?: Record<string, unknown>;
  profileContext?: { id: string };
  status: TaskStatus;
  attempts: number;
  maxAttempts: number;
  nextRunAt: number;
  lastError: unknown;
  createdAt: number;
  updatedAt: number;
  priority?: number;
  result?: unknown;
}

export interface SubmitSpec {
  scriptId: string;
  version?: number;
  params?: Record<string, unknown>;
  profileContext?: { id: string };
  maxAttempts?: number;
  priority?: number;
  taskPlanId?: string;
}

export const TERMINAL: string[];
export const ACTIVE: string[];

export interface TaskClient {
  TERMINAL: string[];
  ACTIVE: string[];
  submit(spec: SubmitSpec): Promise<TaskItem>;
  get(id: string): Promise<TaskItem>;
  list(q?: Record<string, unknown>): Promise<unknown>;
  cancel(id: string): Promise<unknown>;
  pause(id: string, interrupt?: boolean): Promise<unknown>;
  resume(id: string): Promise<unknown>;
  wait(id: string, opts?: { pollMs?: number; timeoutMs?: number }): Promise<{ item: TaskItem; states: string[] }>;
  runToTerminal(spec: SubmitSpec, opts?: { pollMs?: number; timeoutMs?: number }): Promise<{ id: string; item: TaskItem; states: string[] }>;
  schedules: {
    add(spec: unknown): Promise<unknown>;
    list(q?: Record<string, unknown>): Promise<unknown>;
    pause(id: string): Promise<unknown>;
    resume(id: string): Promise<unknown>;
    trigger(id: string): Promise<unknown>;
    remove(id: string): Promise<unknown>;
  };
}

export function createTaskClient(
  client: Client,
  opts?: { pollMs?: number; timeoutMs?: number }
): TaskClient;
