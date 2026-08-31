import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

const identifier = z.string().trim().min(1).max(256);
const optionalAgentConfigValue = z.string().trim().min(1).max(256).nullable();

export const executionAgentConfig = z.object({
  provider: z.string().trim().min(1).max(512),
  modeId: optionalAgentConfigValue,
  thinkingOptionId: optionalAgentConfigValue,
});

const beadsTaskListInput = z.object({
  directory: z.string().trim().min(1).max(4096),
});

const dependency = z.object({
  id: identifier,
  title: z.string().max(500),
  status: z.string().max(80),
});

export const beadsTask = z.object({
  id: identifier,
  title: z.string().max(500),
  description: z.string().nullable(),
  status: z.string().max(80),
  assignee: z.string().max(256).nullable(),
  dependencies: z.array(dependency),
  updatedAt: z.string().max(80).nullable(),
});

export const beadsTaskList = z.object({
  beadsAvailable: z.boolean(),
  tasks: z.array(beadsTask),
  lastError: z.string().max(2000).nullable(),
  lastUpdatedAt: z.string().max(80),
});

export const getBeadsTaskList = defineRpc({
  name: "beads.tasks.list",
  input: beadsTaskListInput,
  output: beadsTaskList,
});

export const getExecutionAgentConfig = defineRpc({
  name: "beads.execution-agent-config.get",
  input: z.object({ agentId: identifier }),
  output: z.object({ config: executionAgentConfig.nullable() }),
});

export const saveExecutionAgentConfig = defineRpc({
  name: "beads.execution-agent-config.save",
  input: z.object({
    agentId: identifier,
    ...executionAgentConfig.shape,
  }),
  output: executionAgentConfig,
});

export type ExecutionAgentConfig = z.infer<typeof executionAgentConfig>;
export type BeadsTask = z.infer<typeof beadsTask>;
export type BeadsTaskList = z.infer<typeof beadsTaskList>;
