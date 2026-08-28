import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

const identifier = z.string().trim().min(1).max(256);

const schedulerInput = z.object({
  workspaceId: identifier,
  parentAgentId: identifier,
  directory: z.string().trim().min(1).max(4096),
});

const dependency = z.object({
  id: identifier,
  title: z.string().max(500),
  status: z.string().max(80),
});

export const taskSchedulerTask = z.object({
  id: identifier,
  title: z.string().max(500),
  description: z.string().nullable(),
  status: z.string().max(80),
  assignee: z.string().max(256).nullable(),
  dependencies: z.array(dependency),
  agentId: z.string().max(256).nullable(),
  agentStatus: z.string().max(80).nullable(),
  error: z.string().max(2000).nullable(),
  updatedAt: z.string().max(80).nullable(),
});

export const taskSchedulerSnapshot = z.object({
  enableCycle: z.boolean(),
  running: z.boolean(),
  phase: z.enum([
    "stopped",
    "starting",
    "checking",
    "waiting",
    "dispatching",
    "executing",
    "error",
  ]),
  beadsAvailable: z.boolean(),
  tasks: z.array(taskSchedulerTask),
  activeTaskCount: z.number().int().nonnegative(),
  pendingNotificationCount: z.number().int().nonnegative(),
  parentAgentStatus: z.string().max(80).nullable(),
  lastError: z.string().max(2000).nullable(),
  lastUpdatedAt: z.string().max(80),
});

export const getTaskSchedulerSnapshot = defineRpc({
  name: "beads.scheduler.snapshot",
  input: schedulerInput,
  output: taskSchedulerSnapshot,
});

export const startTaskScheduler = defineRpc({
  name: "beads.scheduler.start",
  input: schedulerInput,
  output: taskSchedulerSnapshot,
});

export const stopTaskScheduler = defineRpc({
  name: "beads.scheduler.stop",
  input: schedulerInput,
  output: taskSchedulerSnapshot,
});

export type TaskSchedulerInput = z.infer<typeof schedulerInput>;
export type TaskSchedulerTask = z.infer<typeof taskSchedulerTask>;
export type TaskSchedulerSnapshot = z.infer<typeof taskSchedulerSnapshot>;
