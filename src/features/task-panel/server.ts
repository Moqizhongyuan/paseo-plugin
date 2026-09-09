import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
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
    // The plugin process must not leak another agent's database overrides into bd.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(BEADS_|DOLT_)/.test(key)),
    );
    const result = await execFileAsync("bd", ["--readonly", ...args], {
      cwd: directory,
      env: { ...env, BEADS_DIR: join(directory, ".beads") },
      encoding: "utf8",
      maxBuffer: MAX_EXEC_BUFFER,
      timeout: 15_000,
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

async function resolveMainAgentId(agentId: string, paseo: PluginHandlerContext["paseo"]) {
  const visited = new Set<string>();
  let currentId = agentId;
  while (visited.size < 64) {
    getBeadsTaskListContract.input.parse({ agentId: currentId });
    if (visited.has(currentId)) throw new Error("Agent 父级关系存在循环，无法定位任务库");
    visited.add(currentId);
    const result = await paseo.agents.ref(currentId).refresh();
    if (!result?.agent || result.agent.id !== currentId) {
      throw new Error(`无法读取 Agent ${currentId}，不能确定所属主 Agent`);
    }
    // Public Paseo protocol: getParentAgentIdFromLabels uses this reserved label.
    const parentId = result.agent.labels?.["paseo.parent-agent-id"]?.trim();
    if (!parentId) return currentId;
    currentId = parentId;
  }
  throw new Error("Agent 父级关系过深，无法定位任务库");
}

async function assertContainedPath(base: string, target: string) {
  const canonical = await realpath(target);
  const pathFromBase = relative(base, canonical);
  if (pathFromBase === ".." || pathFromBase.startsWith("../") || isAbsolute(pathFromBase)) {
    throw new Error("Beads 数据库路径指向主 Agent 专属目录之外，已停止查询");
  }
  return canonical;
}

async function hasAgentDatabase(directory: string) {
  const beadsDirectory = join(directory, ".beads");
  try {
    await lstat(beadsDirectory);
  } catch (cause) {
    if (isMissingFile(cause)) return false;
    throw cause;
  }
  // Resolve ai-native itself, but do not accept redirects/symlinks to another agent's store.
  if ((await realpath(beadsDirectory)) !== beadsDirectory) {
    throw new Error("Beads 专属目录包含重定向软链，已停止查询");
  }
  await ensureDirectory(beadsDirectory);
  try {
    await lstat(join(beadsDirectory, "redirect"));
    throw new Error("Beads 专属目录存在 redirect，已停止查询");
  } catch (cause) {
    if (!isMissingFile(cause)) throw cause;
  }
  const metadata: unknown = JSON.parse(
    await readFile(join(beadsDirectory, "metadata.json"), "utf8"),
  );
  if (!isRecord(metadata) || (metadata.dolt_mode && metadata.dolt_mode !== "embedded")) {
    throw new Error("任务面板只读取主 Agent 的独立 embedded Beads 数据库");
  }
  // Validate explicit overrides, but let bd resolve its version-specific default storage.
  const dataDirectory =
    stringField(metadata, "dolt_data_dir") ||
    (typeof metadata.database === "string" && isAbsolute(metadata.database)
      ? metadata.database
      : null);
  if (dataDirectory) {
    await assertContainedPath(beadsDirectory, resolve(beadsDirectory, dataDirectory));
  }
  const context = await runBdJson(directory, ["context", "--json"]);
  if (
    !isRecord(context) ||
    context.beads_dir !== beadsDirectory ||
    context.is_redirected ||
    context.dolt_mode !== "embedded" ||
    context.server_host ||
    context.server_port ||
    context.proxied_dir
  ) {
    throw new Error("Beads 实际数据库位置或后端与主 Agent 专属库不一致");
  }
  if (typeof context.data_dir === "string" && context.data_dir) {
    await assertContainedPath(beadsDirectory, resolve(beadsDirectory, context.data_dir));
  }
  const location = await runBdJson(directory, ["where", "--json"]);
  if (
    !isRecord(location) ||
    location.path !== beadsDirectory ||
    typeof location.database_path !== "string"
  ) {
    throw new Error("无法确认 Beads 实际数据库路径");
  }
  await assertContainedPath(beadsDirectory, location.database_path);
  return true;
}

async function readBeadList(directory: string) {
  const raw = await runBdJson(directory, [
    "list",
    "--all",
    "--flat",
    "--limit",
    "0",
    "--no-pager",
    "--json",
  ]);
  return extractRecords(raw)
    .map(normalizeIssue)
    .filter((issue): issue is BeadsApiIssue => issue !== null);
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
      if (!isMissingBeadError(cause)) throw cause;
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

export async function getBeadsTaskList(
  input: z.infer<typeof getBeadsTaskListContract.input>,
  { paseo }: PluginHandlerContext,
) {
  let mainAgentId: string | null = null;
  let beadsDirectory: string | null = null;
  try {
    mainAgentId = await resolveMainAgentId(input.agentId, paseo);
    const sourceRoot = await realpath(join(homedir(), "ai-native"));
    const directory = join(sourceRoot, "personal", "agent-state", mainAgentId, "beads");
    beadsDirectory = join(directory, ".beads");
    if (!(await hasAgentDatabase(directory))) {
      return {
        mainAgentId,
        beadsDirectory,
        beadsAvailable: false,
        tasks: [],
        lastError: null,
        lastUpdatedAt: nowIso(),
      };
    }

    const listed = await readBeadList(directory);
    const details = await readBeadDetails(
      directory,
      listed.map((issue) => issue.id),
    );
    const tasks = listed.map((issue) => {
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
      mainAgentId,
      beadsDirectory,
      beadsAvailable: true,
      tasks,
      lastError: null,
      lastUpdatedAt: nowIso(),
    };
  } catch (cause) {
    return {
      mainAgentId,
      beadsDirectory,
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
