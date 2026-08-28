import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PaseoAgent, PaseoAgentHandle, PaseoClient } from "@getpaseo/client";
import type { z } from "zod";
import {
  getTaskSchedulerSnapshot as getTaskSchedulerSnapshotContract,
  startTaskScheduler as startTaskSchedulerContract,
  stopTaskScheduler as stopTaskSchedulerContract,
  type TaskSchedulerInput,
  type TaskSchedulerSnapshot,
  type TaskSchedulerTask,
} from "./shared";

const execFileAsync = promisify(execFile);

const SCHEDULER_ACTOR = "paseo-task-scheduler";
const SNAPSHOT_REFRESH_MAX_AGE_MS = 1_500;
const CHILD_WAIT_TIMEOUT_MS = 60 * 60 * 1_000;
const DISPATCH_RETRY_COOLDOWN_MS = 30_000;
const MAX_CONCURRENT_JOBS = 3;
const MAX_EXEC_BUFFER = 4 * 1024 * 1024;
const MAX_ERROR_LENGTH = 2_000;
const MAX_DESCRIPTION_LENGTH = 12_000;
const MAX_NOTIFICATION_BATCH = 8;
const storageDirectory = join(
  process.env.PASEO_HOME ?? join(homedir(), ".paseo"),
  "plugins",
  "paseo-plugin",
);
const cycleSettingsFile = join(storageDirectory, "task-scheduler.json");

type SchedulerPhase = TaskSchedulerSnapshot["phase"];
type BeadsApiIssue = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  assignee: string | null;
  dependencies: Array<{ id: string; title: string; status: string }>;
  updatedAt: string | null;
  raw: Record<string, unknown>;
};

type TaskLink = {
  agentId: string | null;
  agentStatus: string | null;
  error: string | null;
};

type PendingNotification = {
  key: string;
  beadId: string;
  beadTitle: string;
  childAgentId: string;
  summary: string;
  suggestions: string[];
  createdAt: string;
};

type ActiveJob = {
  bead: BeadsApiIssue;
  child: PaseoAgentHandle;
  childAgentId: string;
  startedAt: string;
};

type SchedulerState = {
  key: string;
  input: TaskSchedulerInput;
  paseo: PaseoClient;
  enableCycle: boolean;
  phase: SchedulerPhase;
  beadsAvailable: boolean;
  tasks: TaskSchedulerTask[];
  activeJobs: Map<string, ActiveJob>;
  taskLinks: Map<string, TaskLink>;
  pendingNotifications: Map<string, PendingNotification>;
  dispatchCooldowns: Map<string, number>;
  parentAgentStatus: string | null;
  lastError: string | null;
  lastUpdatedAt: string;
  lastBeadsReadAt: number;
  beadsRefreshInFlight: Promise<void> | null;
  notificationFlushInFlight: boolean;
  cycleRunning: boolean;
  cycleRequested: boolean;
};

type CycleSettings = Record<string, boolean>;

type CommandFailure = {
  message?: unknown;
  stderr?: unknown;
  stdout?: unknown;
};

type WorkerReport = {
  status: "completed" | "blocked" | "failed" | "unknown";
  needsNewBeads: boolean;
  suggestions: string[];
  summary: string;
};

type DispatchFailure = Error & {
  claimAcquired?: boolean;
};

const schedulers = new Map<string, SchedulerState>();

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
    raw: value,
  };
}

async function runBdJson(directory: string, args: readonly string[]): Promise<unknown> {
  const commandArgs = ["--actor", SCHEDULER_ACTOR, ...args];
  try {
    const result = await execFileAsync("bd", commandArgs, {
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
  if (!directoryStat.isDirectory()) {
    throw new Error("当前工作目录不是目录");
  }
}

async function readReadyIssues(directory: string) {
  try {
    const raw = await runBdJson(directory, ["ready", "--limit", "0", "--json"]);
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
      // A bead may be removed between list and show. Keep the list snapshot in that case,
      // but surface real workspace/CLI failures to the scheduler.
      if (!isNoBeadsWorkspaceError(cause) && !isMissingBeadError(cause)) throw cause;
    }
  }
  return details;
}

function schedulerKey(input: TaskSchedulerInput) {
  return [input.workspaceId, input.parentAgentId, input.directory].join("\u0000");
}

async function readCycleSettings(): Promise<CycleSettings> {
  try {
    const raw = await readFile(cycleSettingsFile, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};

    const settings: CycleSettings = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "boolean") settings[key] = value;
    }
    return settings;
  } catch (cause) {
    if (isMissingFile(cause)) return {};
    throw cause;
  }
}

async function readEnableCycle(input: TaskSchedulerInput) {
  const settings = await readCycleSettings();
  return settings[schedulerKey(input)] ?? false;
}

async function writeEnableCycle(input: TaskSchedulerInput, enableCycle: boolean) {
  const settings = await readCycleSettings();
  settings[schedulerKey(input)] = enableCycle;
  await mkdir(storageDirectory, { recursive: true });
  await writeFile(cycleSettingsFile, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function touch(state: SchedulerState) {
  state.lastUpdatedAt = nowIso();
}

function taskSnapshot(issue: BeadsApiIssue, state: SchedulerState): TaskSchedulerTask {
  const link = state.taskLinks.get(issue.id);
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
    agentId: link?.agentId ?? null,
    agentStatus: link?.agentStatus ?? null,
    error: link?.error ? truncate(link.error, MAX_ERROR_LENGTH) : null,
    updatedAt: issue.updatedAt ? truncate(issue.updatedAt, 80) : null,
  };
}

async function refreshBeadsInternal(state: SchedulerState) {
  const listed = await readBeadList(state.input.directory);
  if (!listed.available) {
    state.beadsAvailable = false;
    state.tasks = [];
    state.lastBeadsReadAt = Date.now();
    touch(state);
    return;
  }

  const details = await readBeadDetails(
    state.input.directory,
    listed.issues.map((issue) => issue.id),
  );
  state.beadsAvailable = true;
  state.tasks = listed.issues.map((issue) => {
    const detailedIssue = details.get(issue.id);
    return taskSnapshot(
      detailedIssue
        ? {
            ...issue,
            ...detailedIssue,
            raw: { ...issue.raw, ...detailedIssue.raw },
          }
        : issue,
      state,
    );
  });
  state.lastBeadsReadAt = Date.now();
  touch(state);
}

async function refreshBeads(state: SchedulerState) {
  if (state.beadsRefreshInFlight) {
    await state.beadsRefreshInFlight;
    return;
  }

  const refresh = refreshBeadsInternal(state);
  state.beadsRefreshInFlight = refresh;
  try {
    await refresh;
  } finally {
    if (state.beadsRefreshInFlight === refresh) state.beadsRefreshInFlight = null;
  }
}

async function refreshForSnapshot(state: SchedulerState) {
  if (Date.now() - state.lastBeadsReadAt < SNAPSHOT_REFRESH_MAX_AGE_MS) return;
  try {
    await refreshBeads(state);
  } catch (cause) {
    if (isNoBeadsWorkspaceError(cause)) {
      state.beadsAvailable = false;
      state.tasks = [];
      state.lastBeadsReadAt = Date.now();
      return;
    }
    state.lastError = truncate(errorMessage(cause), MAX_ERROR_LENGTH);
  }
}

function getSnapshot(state: SchedulerState): TaskSchedulerSnapshot {
  return {
    enableCycle: state.enableCycle,
    running: state.cycleRunning,
    phase: state.phase,
    beadsAvailable: state.beadsAvailable,
    tasks: state.tasks,
    activeTaskCount: state.activeJobs.size,
    pendingNotificationCount: state.pendingNotifications.size,
    parentAgentStatus: state.parentAgentStatus,
    lastError: state.lastError,
    lastUpdatedAt: state.lastUpdatedAt,
  };
}

function createState(input: TaskSchedulerInput, paseo: PaseoClient): SchedulerState {
  return {
    key: schedulerKey(input),
    input,
    paseo,
    enableCycle: false,
    phase: "stopped",
    beadsAvailable: false,
    tasks: [],
    activeJobs: new Map(),
    taskLinks: new Map(),
    pendingNotifications: new Map(),
    dispatchCooldowns: new Map(),
    parentAgentStatus: null,
    lastError: null,
    lastUpdatedAt: nowIso(),
    lastBeadsReadAt: 0,
    beadsRefreshInFlight: null,
    notificationFlushInFlight: false,
    cycleRunning: false,
    cycleRequested: false,
  };
}

function getOrCreateState(input: TaskSchedulerInput, paseo: PaseoClient) {
  const key = schedulerKey(input);
  const existing = schedulers.get(key);
  if (existing) {
    existing.paseo = paseo;
    existing.input = input;
    return existing;
  }
  const state = createState(input, paseo);
  schedulers.set(key, state);
  return state;
}

function providerSelection(parent: PaseoAgent) {
  const provider = parent.provider.trim();
  const model = parent.model?.trim() ?? "";
  if (!provider) throw new Error("父 Agent 没有可用的 provider");
  if (!model) {
    if (provider.includes("/")) return provider;
    throw new Error("父 Agent 没有可复用的 model");
  }
  if (provider.endsWith(`/${model}`)) return provider;
  return `${provider}/${model}`;
}

function buildWorkerPrompt(issue: BeadsApiIssue, input: TaskSchedulerInput) {
  const description = issue.description
    ? truncate(issue.description, MAX_DESCRIPTION_LENGTH)
    : "（无描述）";
  const dependencies = issue.dependencies.length
    ? issue.dependencies
        .map((dependency) => `${dependency.id}（${dependency.title}，${dependency.status}）`)
        .join("、")
    : "无";

  return `你是 Beads 调度器分派的执行 Agent。请在工作目录 ${JSON.stringify(input.directory)} 中执行当前 bead，不要处理其它 bead。

当前 bead：
- ID：${issue.id}
- 标题：${issue.title}
- 描述：${description}
- 前置依赖：${dependencies}

执行约束：
1. 先阅读仓库规则和 bead 上下文，完成这个 bead 的实现、验证和必要的文件修改。
2. 你只能更新当前 bead 的状态（例如使用 bd update 或 bd close），不能直接创建新的 bead，也不要擅自修改其它 bead 的业务内容。
3. 如果发现确实需要新增或拆分 bead，只记录建议，不要执行 bd create；由父 Agent 检查后决定是否修改任务列表。
4. 完成前运行与任务相关的最小验证，并如实说明失败、未验证项和剩余风险。

最终回复末尾必须包含一行机器可读结果，格式严格如下（summary 和 suggestions 使用 JSON 字符串）：
BEADS_SCHEDULER_RESULT {"status":"completed|blocked|failed","needs_new_beads":true|false,"suggestions":["建议一"],"summary":"简短总结"}
若不需要新 bead，请将 needs_new_beads 设为 false，suggestions 设为空数组。`;
}

function extractJsonObject(value: string) {
  const start = value.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) return value.slice(start, index + 1);
    }
  }
  return null;
}

function parseWorkerReportObject(message: string) {
  const markerIndex = message.indexOf("BEADS_SCHEDULER_RESULT");
  if (markerIndex < 0) return null;
  const remainder = message.slice(markerIndex + "BEADS_SCHEDULER_RESULT".length).trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(remainder)?.[1];
  const candidates = [fenced, remainder]
    .filter((candidate): candidate is string => Boolean(candidate))
    .map(extractJsonObject)
    .filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Try the next representation (for example, a fenced block versus one line).
    }
  }
  return null;
}

function parseWorkerReport(message: string | null, resultStatus: string): WorkerReport {
  const text = message ?? "";
  const parsed = parseWorkerReportObject(text);
  if (parsed) {
    const statusValue = stringField(parsed, "status");
    const status: WorkerReport["status"] =
      statusValue === "completed" || statusValue === "blocked" || statusValue === "failed"
        ? statusValue
        : "unknown";
    const suggestions = Array.isArray(parsed.suggestions)
      ? parsed.suggestions
          .filter((suggestion): suggestion is string => typeof suggestion === "string")
          .map((suggestion) => truncate(suggestion, 1_000))
          .filter(Boolean)
          .slice(0, 10)
      : [];
    return {
      status,
      needsNewBeads: parsed.needs_new_beads === true || parsed.needsNewBeads === true,
      suggestions,
      summary: truncate(stringField(parsed, "summary") ?? "子 Agent 已返回结果。", 2_000),
    };
  }

  return {
    status:
      resultStatus === "idle"
        ? "completed"
        : resultStatus === "permission" || resultStatus === "timeout"
          ? "blocked"
          : "failed",
    needsNewBeads: /needs[_ ]new[_ ]beads\s*[:=]\s*true/i.test(text),
    suggestions: [],
    summary: truncate(text.replace(/\s+/g, " "), 2_000) || "子 Agent 没有返回文本结果。",
  };
}

function buildParentNotification(notifications: readonly PendingNotification[]) {
  const lines = notifications.map((notification) => {
    const suggestions = notification.suggestions.length
      ? notification.suggestions.map((suggestion) => `- ${suggestion}`).join("\n")
      : "- 子 Agent 没有给出具体拆分建议，请你自行复核。";
    return `Bead ${notification.beadId}（${notification.beadTitle}）由子 Agent ${notification.childAgentId} 执行后认为可能需要新增或调整任务。
摘要：${notification.summary}
建议：
${suggestions}`;
  });

  return `Beads 调度器通知：以下执行结果需要你作为父 Agent 决策。

${lines.join("\n\n")}

调度器不会自动创建或修改 Beads。请先检查当前任务列表和仓库状态；如果确有必要，请由你自行使用 bd create、bd update 或依赖命令调整任务。处理完成后可在回复中说明你的决定。`;
}

async function refreshParent(state: SchedulerState) {
  const parentHandle = state.paseo.agents.ref(state.input.parentAgentId);
  const result = await parentHandle.refresh();
  const parent = result?.agent ?? null;
  state.parentAgentStatus = parent?.status ?? null;
  touch(state);
  return { parent, parentHandle };
}

async function flushPendingNotifications(state: SchedulerState) {
  if (state.pendingNotifications.size === 0) return;
  if (state.notificationFlushInFlight) return;
  state.notificationFlushInFlight = true;

  try {
    let parentResult;
    try {
      parentResult = await refreshParent(state);
    } catch (cause) {
      state.lastError = truncate(`读取父 Agent 状态失败：${errorMessage(cause)}`, MAX_ERROR_LENGTH);
      return;
    }

    if (!parentResult.parent || parentResult.parent.status !== "idle") return;

    const notifications = Array.from(state.pendingNotifications.values()).slice(
      0,
      MAX_NOTIFICATION_BATCH,
    );
    try {
      await parentResult.parentHandle.send(
        truncate(buildParentNotification(notifications), 20_000),
      );
      for (const notification of notifications) state.pendingNotifications.delete(notification.key);
      state.parentAgentStatus = "running";
      touch(state);
    } catch (cause) {
      state.lastError = truncate(`通知父 Agent 失败：${errorMessage(cause)}`, MAX_ERROR_LENGTH);
    }
  } finally {
    state.notificationFlushInFlight = false;
  }
}

async function releaseClaimIfOwned(state: SchedulerState, beadId: string) {
  let current: BeadsApiIssue | null = null;
  try {
    const raw = await runBdJson(state.input.directory, ["show", beadId, "--long", "--json"]);
    current =
      extractRecords(raw)
        .map(normalizeIssue)
        .find((issue): issue is BeadsApiIssue => issue?.id === beadId) ?? null;
  } catch (cause) {
    if (isNoBeadsWorkspaceError(cause) || isMissingBeadError(cause)) return;
    throw cause;
  }

  // Never clear a claim that no longer belongs to this scheduler. This matters when
  // another worker claims the issue between bd ready and our rollback path.
  if (!current || current.status !== "in_progress" || current.assignee !== SCHEDULER_ACTOR) return;

  await runBdJson(state.input.directory, [
    "update",
    beadId,
    "--status",
    "open",
    "--assignee",
    "",
    "--json",
  ]);
}

async function updateBeadAfterDispatchFailure(
  state: SchedulerState,
  beadId: string,
  cause: unknown,
  claimAcquired: boolean,
) {
  const message = truncate(errorMessage(cause), MAX_ERROR_LENGTH);
  state.taskLinks.set(beadId, { agentId: null, agentStatus: null, error: message });
  state.dispatchCooldowns.set(beadId, Date.now() + DISPATCH_RETRY_COOLDOWN_MS);
  state.lastError = truncate(`派发 bead ${beadId} 失败：${message}`, MAX_ERROR_LENGTH);
  if (claimAcquired) {
    try {
      await releaseClaimIfOwned(state, beadId);
    } catch (rollbackCause) {
      state.lastError = truncate(
        `${state.lastError}；回滚认领失败：${errorMessage(rollbackCause)}`,
        MAX_ERROR_LENGTH,
      );
    }
  }
  touch(state);
}

async function verifyChildPlacement(state: SchedulerState, job: ActiveJob) {
  try {
    const result = await job.child.refresh();
    const snapshot = result?.agent;
    if (!snapshot) throw new Error("子 Agent 快照为空");
    const parentLabel = snapshot.labels?.["paseo.parent-agent-id"];
    if (parentLabel !== state.input.parentAgentId) {
      throw new Error(`parentAgentId 标签不匹配（实际为 ${parentLabel ?? "空"}）`);
    }
    if (snapshot.workspaceId !== state.input.workspaceId) {
      throw new Error(`workspaceId 不匹配（实际为 ${snapshot.workspaceId ?? "空"}）`);
    }
  } catch (cause) {
    const message = `子 Agent 归属校验失败：${errorMessage(cause)}`;
    const link = state.taskLinks.get(job.bead.id);
    state.taskLinks.set(job.bead.id, {
      agentId: link?.agentId ?? job.childAgentId,
      agentStatus: link?.agentStatus ?? null,
      error: message,
    });
    state.lastError = truncate(message, MAX_ERROR_LENGTH);
    touch(state);
  }
}

async function monitorChild(state: SchedulerState, job: ActiveJob) {
  let result;
  try {
    result = await job.child.waitForFinish(CHILD_WAIT_TIMEOUT_MS);
  } catch (cause) {
    result = {
      status: "error" as const,
      final: null,
      error: errorMessage(cause),
      lastMessage: null,
    };
  }

  if (state.activeJobs.get(job.bead.id) !== job) return;

  let finalStatus = result.final?.status ?? null;
  try {
    const refreshed = await job.child.refresh();
    finalStatus = refreshed?.agent.status ?? finalStatus;
  } catch {
    // The wait result still contains the last known status. Keep it if refresh fails.
  }

  const report = parseWorkerReport(result.lastMessage, result.status);
  let taskError: string | null = null;
  if (result.status !== "idle") {
    taskError = result.error
      ? truncate(result.error, MAX_ERROR_LENGTH)
      : `子 Agent 以 ${result.status} 状态结束`;
  } else if (report.status === "blocked" || report.status === "failed") {
    taskError = `子 Agent 汇报任务${report.status === "blocked" ? "阻塞" : "失败"}`;
  }

  state.activeJobs.delete(job.bead.id);
  const previousLink = state.taskLinks.get(job.bead.id);
  state.taskLinks.set(job.bead.id, {
    agentId: job.childAgentId,
    agentStatus: finalStatus,
    error: taskError ?? previousLink?.error ?? null,
  });
  if (report.needsNewBeads) {
    const key = `${job.bead.id}:${job.childAgentId}`;
    state.pendingNotifications.set(key, {
      key,
      beadId: job.bead.id,
      beadTitle: job.bead.title,
      childAgentId: job.childAgentId,
      summary: report.summary,
      suggestions: report.suggestions,
      createdAt: nowIso(),
    });
  }
  touch(state);

  // The worker is responsible for changing the bead status. Read it back after the
  // worker turn, so the panel reflects the authoritative Beads state before dispatching more work.
  try {
    await refreshBeads(state);
    const updatedTask = state.tasks.find((task) => task.id === job.bead.id);
    if (
      !taskError &&
      result.status === "idle" &&
      updatedTask &&
      updatedTask.status === "in_progress"
    ) {
      const message = "子 Agent 已结束，但当前 bead 仍为 in_progress，请检查并更新 Beads 状态";
      state.taskLinks.set(job.bead.id, {
        agentId: job.childAgentId,
        agentStatus: finalStatus,
        error: message,
      });
      state.tasks = state.tasks.map((task) =>
        task.id === job.bead.id ? { ...task, error: message } : task,
      );
    }
  } catch (cause) {
    state.lastError = truncate(`刷新 bead 列表失败：${errorMessage(cause)}`, MAX_ERROR_LENGTH);
  }

  await flushPendingNotifications(state);
  touch(state);
  void requestCycle(state);
}

async function dispatchBead(
  state: SchedulerState,
  bead: BeadsApiIssue,
  parent: PaseoAgent,
): Promise<boolean> {
  let claimAcquired = false;
  try {
    await runBdJson(state.input.directory, ["update", bead.id, "--claim", "--json"]);
    claimAcquired = true;

    const config: {
      provider: string;
      modeId?: string;
      thinkingOptionId?: string;
    } = { provider: providerSelection(parent) };
    if (parent.currentModeId) config.modeId = parent.currentModeId;
    if (parent.thinkingOptionId) config.thinkingOptionId = parent.thinkingOptionId;

    const workspace = state.paseo.workspaces.ref(state.input.workspaceId);
    const child = await workspace.agents.create({
      config,
      parent: state.input.parentAgentId,
      title: truncate(`Beads：${bead.id} ${bead.title}`, 120),
      prompt: buildWorkerPrompt(bead, state.input),
      labels: {
        role: "beads-worker",
        beadId: bead.id,
        scheduler: "paseo-plugin",
      },
    });

    const job: ActiveJob = {
      bead,
      child,
      childAgentId: child.id,
      startedAt: nowIso(),
    };
    state.activeJobs.set(bead.id, job);
    state.taskLinks.set(bead.id, {
      agentId: child.id,
      agentStatus: child.status,
      error: null,
    });
    state.dispatchCooldowns.delete(bead.id);
    touch(state);
    await verifyChildPlacement(state, job);
    void monitorChild(state, job);
    return true;
  } catch (cause) {
    if (claimAcquired) {
      const dispatchError = new Error(errorMessage(cause)) as DispatchFailure;
      dispatchError.claimAcquired = true;
      throw dispatchError;
    }
    throw cause;
  }
}

async function refreshActiveJobs(state: SchedulerState) {
  await Promise.all(
    Array.from(state.activeJobs.values()).map(async (job) => {
      try {
        const result = await job.child.refresh();
        const status = result?.agent.status ?? job.child.status;
        const link = state.taskLinks.get(job.bead.id);
        state.taskLinks.set(job.bead.id, {
          agentId: job.childAgentId,
          agentStatus: status,
          error: link?.error ?? null,
        });
      } catch (cause) {
        const link = state.taskLinks.get(job.bead.id);
        state.taskLinks.set(job.bead.id, {
          agentId: job.childAgentId,
          agentStatus: link?.agentStatus ?? null,
          error: truncate(`读取子 Agent 状态失败：${errorMessage(cause)}`, MAX_ERROR_LENGTH),
        });
      }
    }),
  );
  touch(state);
}

async function runCycle(state: SchedulerState): Promise<void> {
  try {
    state.phase = "checking";
    state.lastError = null;
    touch(state);

    // Every cycle starts from Beads' dependency-aware ready list. The persisted switch
    // is intentionally read once, immediately after bd ready, before this round dispatches.
    const ready = await readReadyIssues(state.input.directory);
    state.enableCycle = await readEnableCycle(state.input);
    if (!state.enableCycle) {
      state.phase = "stopped";
      touch(state);
      return;
    }

    if (!ready.available) {
      state.beadsAvailable = false;
      state.tasks = [];
      state.phase = "waiting";
      state.lastError = null;
      state.lastBeadsReadAt = Date.now();
      touch(state);
      return;
    }

    state.beadsAvailable = true;
    await refreshBeads(state);
    await refreshActiveJobs(state);
    await flushPendingNotifications(state);

    const capacity = Math.max(0, MAX_CONCURRENT_JOBS - state.activeJobs.size);
    if (capacity > 0 && ready.issues.length > 0) {
      state.phase = "dispatching";
      let parent: PaseoAgent | null = null;
      try {
        parent = (await refreshParent(state)).parent;
      } catch (cause) {
        state.lastError = truncate(
          `读取父 Agent 配置失败：${errorMessage(cause)}`,
          MAX_ERROR_LENGTH,
        );
      }

      if (parent && (parent.status === "idle" || parent.status === "running")) {
        let dispatched = 0;
        for (const bead of ready.issues) {
          if (dispatched >= capacity) break;
          if (state.activeJobs.has(bead.id)) continue;
          const cooldownUntil = state.dispatchCooldowns.get(bead.id) ?? 0;
          if (cooldownUntil > Date.now()) continue;
          try {
            const didDispatch = await dispatchBead(state, bead, parent);
            if (!didDispatch) break;
            dispatched += 1;
          } catch (cause) {
            await updateBeadAfterDispatchFailure(
              state,
              bead.id,
              cause,
              (cause as DispatchFailure).claimAcquired === true,
            );
          }
        }
      } else if (parent) {
        state.lastError = `父 Agent 当前处于 ${parent.status} 状态，暂不派发 bead`;
      }
    }

    // Claims and worker completions can both change Beads between the two reads.
    // Refresh once more before exposing the next snapshot to the panel.
    await refreshBeads(state);
    await refreshActiveJobs(state);
    await flushPendingNotifications(state);
    state.phase = state.activeJobs.size > 0 ? "executing" : "waiting";
    touch(state);
  } catch (cause) {
    if (isNoBeadsWorkspaceError(cause)) {
      state.beadsAvailable = false;
      state.tasks = [];
      state.lastError = null;
      state.phase = "waiting";
    } else {
      state.lastError = truncate(errorMessage(cause), MAX_ERROR_LENGTH);
      state.phase = "error";
    }
    touch(state);
  }
}

async function requestCycle(state: SchedulerState) {
  state.cycleRequested = true;
  if (state.cycleRunning) return;

  state.cycleRunning = true;
  touch(state);
  try {
    while (state.cycleRequested) {
      state.cycleRequested = false;
      await runCycle(state);
    }
  } finally {
    state.cycleRunning = false;
    touch(state);
  }
}

export async function getTaskSchedulerSnapshot(
  input: z.infer<typeof getTaskSchedulerSnapshotContract.input>,
  { paseo }: { paseo: PaseoClient },
) {
  const state = getOrCreateState(input, paseo);
  const persistedEnableCycle = await readEnableCycle(input);
  const shouldResumeCycle = persistedEnableCycle && !state.enableCycle;
  state.enableCycle = persistedEnableCycle;
  if (!state.enableCycle && !state.cycleRunning) state.phase = "stopped";
  await refreshForSnapshot(state);
  if (shouldResumeCycle) {
    state.phase = "starting";
    touch(state);
    void requestCycle(state);
  }
  return getSnapshot(state);
}

export async function startTaskScheduler(
  input: z.infer<typeof startTaskSchedulerContract.input>,
  { paseo }: { paseo: PaseoClient },
) {
  await ensureDirectory(input.directory);
  const state = getOrCreateState(input, paseo);
  await writeEnableCycle(input, true);
  state.enableCycle = true;
  state.phase = "starting";
  state.lastError = null;
  touch(state);
  void requestCycle(state);
  return getSnapshot(state);
}

export async function stopTaskScheduler(
  input: z.infer<typeof stopTaskSchedulerContract.input>,
  { paseo }: { paseo: PaseoClient },
) {
  const state = getOrCreateState(input, paseo);
  await writeEnableCycle(input, false);
  state.enableCycle = false;
  state.phase = "stopped";
  touch(state);
  await refreshForSnapshot(state);
  return getSnapshot(state);
}
