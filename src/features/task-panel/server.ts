import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { z } from "zod";
import {
  executionAgentConfig,
  getBeadsTaskList as getBeadsTaskListContract,
  getExecutionAgentConfig as getExecutionAgentConfigContract,
  saveExecutionAgentConfig as saveExecutionAgentConfigContract,
  type BeadsTask,
  type ExecutionAgentConfig,
} from "./shared";

const execFileAsync = promisify(execFile);
const MAX_EXEC_BUFFER = 4 * 1024 * 1024;
const MAX_ERROR_LENGTH = 2_000;
const storageDirectory = join(
  process.env.PASEO_HOME ?? join(homedir(), ".paseo"),
  "plugins",
  "paseo-plugin",
);
// Keep the established filename so saved execution choices survive the removal
// of the scheduler implementation.
const agentConfigsFile = join(storageDirectory, "task-scheduler-agent-configs.json");

type BeadsApiIssue = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  assignee: string | null;
  dependencies: Array<{ id: string; title: string; status: string }>;
  updatedAt: string | null;
};

type CommandFailure = {
  message?: unknown;
  stderr?: unknown;
};

type AgentConfigs = Record<string, ExecutionAgentConfig>;

function nowIso() {
  return new Date().toISOString();
}

function truncate(value: string, maxLength: number) {
  const normalized = value.trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function errorMessage(cause: unknown) {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return "未知错误";
}

function isMissingFile(cause: unknown) {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

function commandFailureMessage(cause: unknown, args: readonly string[]) {
  const record = (cause && typeof cause === "object" ? cause : {}) as CommandFailure;
  const stderr = typeof record.stderr === "string" ? record.stderr.trim() : "";
  const message = stderr || errorMessage(record.message ?? cause);
  return truncate(`bd ${args.join(" ")}：${message}`, MAX_ERROR_LENGTH);
}

function isNoBeadsWorkspaceError(cause: unknown) {
  const message = errorMessage(cause).toLowerCase();
  return (
    message.includes("no active beads workspace") ||
    message.includes("not a beads workspace") ||
    message.includes("no beads workspace") ||
    message.includes("no beads database")
  );
}

function isMissingBeadError(cause: unknown) {
  const message = errorMessage(cause).toLowerCase();
  return (
    message.includes("no issue found") ||
    message.includes("no issues found") ||
    message.includes("issue not found") ||
    message.includes("issues not found")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringField(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function nullableStringField(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value.trim() || null;
    if (value === null) return null;
  }
  return null;
}

function extractRecords(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];

  for (const key of ["issues", "items", "results", "data"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  if (isRecord(value.issue)) return [value.issue];
  return [];
}

function normalizeDependency(value: unknown) {
  if (!isRecord(value)) return null;
  const id = stringField(value, "id", "depends_on_id", "issue_id");
  if (!id) return null;
  return {
    id,
    title: stringField(value, "title") ?? id,
    status: stringField(value, "status") ?? "unknown",
  };
}

function normalizeIssue(value: unknown): BeadsApiIssue | null {
  if (!isRecord(value)) return null;
  const id = stringField(value, "id", "issue_id");
  if (!id) return null;

  const dependencyValues = Array.isArray(value.dependencies) ? value.dependencies : [];
  const dependencies = dependencyValues
    .map(normalizeDependency)
    .filter((dependency): dependency is NonNullable<ReturnType<typeof normalizeDependency>> => {
      return dependency !== null;
    });

  return {
    id,
    title: stringField(value, "title", "name") ?? id,
    description: nullableStringField(value, "description", "body", "notes"),
    status: stringField(value, "status") ?? "unknown",
    assignee: nullableStringField(value, "assignee", "assigned_to"),
    dependencies,
    updatedAt: nullableStringField(value, "updated_at", "updatedAt"),
  };
}

async function runBdJson(directory: string, args: readonly string[]): Promise<unknown> {
  try {
    const result = await execFileAsync("bd", args, {
      cwd: directory,
      encoding: "utf8",
      maxBuffer: MAX_EXEC_BUFFER,
    });
    const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
    if (!stdout) return [];
    try {
      return JSON.parse(stdout) as unknown;
    } catch (cause) {
      throw new Error(`bd 返回了无法解析的 JSON：${errorMessage(cause)}`);
    }
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("bd 返回了无法解析的 JSON")) {
      throw cause;
    }
    throw new Error(commandFailureMessage(cause, args));
  }
}

async function ensureDirectory(directory: string) {
  let directoryStat;
  try {
    directoryStat = await stat(directory);
  } catch (cause) {
    throw new Error(`当前工作目录不可访问：${errorMessage(cause)}`);
  }
  if (!directoryStat.isDirectory()) throw new Error("当前工作目录不是目录");
}

async function readBeadList(directory: string) {
  try {
    const raw = await runBdJson(directory, [
      "list",
      "--all",
      "--flat",
      "--limit",
      "0",
      "--no-pager",
      "--json",
    ]);
    return {
      available: true,
      issues: extractRecords(raw)
        .map(normalizeIssue)
        .filter((issue): issue is BeadsApiIssue => issue !== null),
    };
  } catch (cause) {
    if (isNoBeadsWorkspaceError(cause)) return { available: false, issues: [] };
    throw cause;
  }
}

async function readBeadDetails(directory: string, ids: readonly string[]) {
  const details = new Map<string, BeadsApiIssue>();
  const chunkSize = 40;
  for (let index = 0; index < ids.length; index += chunkSize) {
    const chunk = ids.slice(index, index + chunkSize);
    try {
      const raw = await runBdJson(directory, ["show", ...chunk, "--long", "--json"]);
      for (const issue of extractRecords(raw)) {
        const normalized = normalizeIssue(issue);
        if (normalized) details.set(normalized.id, normalized);
      }
    } catch (cause) {
      // A bead can disappear between list and show. Keep the list snapshot in that case.
      if (!isNoBeadsWorkspaceError(cause) && !isMissingBeadError(cause)) throw cause;
    }
  }
  return details;
}

function taskSnapshot(issue: BeadsApiIssue): BeadsTask {
  return {
    id: issue.id,
    title: truncate(issue.title, 500),
    description: issue.description ? truncate(issue.description, 4_000) : null,
    status: truncate(issue.status, 80),
    assignee: issue.assignee ? truncate(issue.assignee, 256) : null,
    dependencies: issue.dependencies.map((dependency) => ({
      id: truncate(dependency.id, 256),
      title: truncate(dependency.title, 500),
      status: truncate(dependency.status, 80),
    })),
    updatedAt: issue.updatedAt ? truncate(issue.updatedAt, 80) : null,
  };
}

async function readAgentConfigs(): Promise<AgentConfigs> {
  try {
    const raw = await readFile(agentConfigsFile, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};

    const configs: AgentConfigs = {};
    for (const [agentId, value] of Object.entries(parsed)) {
      const result = executionAgentConfig.safeParse(value);
      if (agentId.trim() && result.success) configs[agentId] = result.data;
    }
    return configs;
  } catch (cause) {
    if (isMissingFile(cause)) return {};
    throw cause;
  }
}

async function writeAgentConfigs(configs: AgentConfigs) {
  await mkdir(storageDirectory, { recursive: true });
  await writeFile(agentConfigsFile, `${JSON.stringify(configs, null, 2)}\n`, "utf8");
}

export async function getBeadsTaskList(input: z.infer<typeof getBeadsTaskListContract.input>) {
  await ensureDirectory(input.directory);
  try {
    const listed = await readBeadList(input.directory);
    if (!listed.available) {
      return {
        beadsAvailable: false,
        tasks: [],
        lastError: null,
        lastUpdatedAt: nowIso(),
      };
    }

    const details = await readBeadDetails(
      input.directory,
      listed.issues.map((issue) => issue.id),
    );
    const tasks = listed.issues.map((issue) => {
      const detailedIssue = details.get(issue.id);
      return taskSnapshot(
        detailedIssue
          ? {
              ...issue,
              ...detailedIssue,
            }
          : issue,
      );
    });
    return {
      beadsAvailable: true,
      tasks,
      lastError: null,
      lastUpdatedAt: nowIso(),
    };
  } catch (cause) {
    return {
      beadsAvailable: true,
      tasks: [],
      lastError: truncate(errorMessage(cause), MAX_ERROR_LENGTH),
      lastUpdatedAt: nowIso(),
    };
  }
}

export async function getExecutionAgentConfig(
  input: z.infer<typeof getExecutionAgentConfigContract.input>,
) {
  const configs = await readAgentConfigs();
  return { config: configs[input.agentId] ?? null };
}

export async function saveExecutionAgentConfig(
  input: z.infer<typeof saveExecutionAgentConfigContract.input>,
) {
  const configs = await readAgentConfigs();
  const config = {
    provider: input.provider,
    modeId: input.modeId,
    thinkingOptionId: input.thinkingOptionId,
  } satisfies ExecutionAgentConfig;
  configs[input.agentId] = config;
  await writeAgentConfigs(configs);
  return config;
}
