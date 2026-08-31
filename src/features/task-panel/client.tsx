import { type PluginAgentPanelProps, useAgent, useRpc, useWorkspace } from "@getpaseo/plugin";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Clipboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Card, Toast, type ToastVariant } from "../../components";
import { AgentConfigPanel } from "./agent-config";
import {
  getBeadsTaskList,
  getExecutionAgentConfig,
  type BeadsTask,
  type BeadsTaskList,
  type ExecutionAgentConfig,
} from "./shared";

async function copyToClipboard(text: string) {
  const browserClipboard = globalThis.navigator?.clipboard;
  if (browserClipboard?.writeText) {
    try {
      await browserClipboard.writeText(text);
      return;
    } catch {
      // Fall back to the React Native clipboard implementation.
    }
  }

  try {
    Clipboard.setString(text);
  } catch {
    throw new Error("当前运行环境不支持复制到剪切板");
  }
}

function composeProviderModel(provider: string, model: string | null) {
  const normalizedProvider = provider.trim();
  const normalizedModel = model?.trim() ?? "";
  if (!normalizedModel || normalizedProvider.endsWith(`/${normalizedModel}`)) {
    return normalizedProvider;
  }
  return `${normalizedProvider}/${normalizedModel}`;
}

function buildBeadsPrompt(config: ExecutionAgentConfig | null, requirement: string) {
  const launchConfig = config
    ? {
        provider: config.provider,
        settings: {
          ...(config.modeId ? { modeId: config.modeId } : {}),
          ...(config.thinkingOptionId ? { thinkingOptionId: config.thinkingOptionId } : {}),
        },
      }
    : null;
  const configSection = launchConfig
    ? `任务面板当前有效的执行 Agent 配置如下（provider 已包含完整的 model），可直接作为 Paseo MCP create_agent 的参数：

${JSON.stringify(launchConfig, null, 2)}`
    : "任务面板当前没有读取到单独保存的执行 Agent 配置。请使用当前主 Agent 的有效 provider/model、modeId 和 thinkingOptionId，并在创建时显式传入，不要猜测或静默改用其他配置。";
  const requirementSection = requirement.trim() || "（未填写本次需求，请先补充后再开始执行。）";

  return `你是当前任务的主 Agent，只需要负责设计和推进本次工作的 Beads 任务图，并由你决定何时创建和如何协调子 Agent。

一、本次用户需求
${requirementSection}

二、设计 Beads
1. 先读取当前工作区已有的 Beads 和依赖关系（例如使用 bd list、bd show），理解已有任务后再修改，避免重复创建。
2. 将用户目标拆成一个清晰的父 bead/epic，以及粒度适中、可以独立验收的子 bead。每个子 bead 都写明目标、背景、允许范围、禁止范围、完成标准、验证命令和阻塞条件。
3. 显式建立依赖关系、优先级和执行顺序。不要用任务标题或编号猜测依赖，也不要覆盖与本次目标无关的已有 bead。
4. 先向用户或当前会话说明任务图；信息足够时直接按依赖顺序推进，不为了形式拆出没有独立价值的子任务。

三、按执行 Agent 配置创建子 Agent
${configSection}

1. 使用 Paseo agent-scoped MCP create_agent 创建真正的子 Agent，让 Paseo 保留父子关系；不要使用脚本、定时任务或插件调度器代替父 Agent 编排。
2. 将上面的完整 provider/model 传给 create_agent.provider，并将非空的 modeId、thinkingOptionId 放入 create_agent.settings。配置中的空值要省略，不要自行发明值。
3. 每个子 Agent 对应一个明确的子 bead，在 initialPrompt 中带上 bead ID、目标、范围、完成标准、验证命令和回报格式。子 Agent 创建成功后，立即使用命令 bd update <beadId> --assignee "<provider>" 将对应 bead 的 assignee 设置为本次执行配置中的完整 provider（包含 model，例如 codex/gpt-5.6-sol），按原字符串传入并在 shell 中正确引用；不要填入 Paseo Agent ID，不要写入 metadata，也不要使用 owner 代替。子 Agent 返回的 Agent ID 仅用于核对 parent、workspace、provider/model 和 settings 是否符合预期。
4. 子 Agent 只负责自己的 bead，并把完成证据、失败原因、阻塞条件或新增任务建议直接报告给父 Agent。是否更新状态、调整依赖或新增 bead，由父 Agent 决定。

四、推进和收尾
1. 父 Agent 负责选择执行顺序、等待和汇总子 Agent 结果，并根据真实证据更新 Beads 状态；不要让子 Agent 自行派发兄弟任务或启动后台调度。
2. 如果发现需要新增工作，先向父 Agent 报告理由和建议内容，由父 Agent 判断是否创建新的 bead，再重新安排依赖。
3. 本次任务图中的所有子任务完成且父 Agent 验收通过后，收集本次创建的父 bead/epic 和全部子 bead ID，先执行 bd delete <id...> --dry-run 核对删除范围，再执行 bd delete <id...> --force 永久删除这些 Beads。不要使用 --cascade，不要删除任务开始前已有或与本次工作无关的 bead；如果预览包含无关任务，则停止清理并报告。
4. 最终汇报每个子任务对应的 Agent、执行配置、验证结果、Beads 清理结果、未解决阻塞和后续建议。`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请稍后重试";
}

function statusLabel(status: string) {
  return (
    {
      open: "待处理",
      in_progress: "执行中",
      blocked: "已阻塞",
      deferred: "已延期",
      closed: "已完成",
    }[status] ?? status
  );
}

function assigneeLabel(task: BeadsTask) {
  return task.assignee ? `认领 Agent：${task.assignee}` : "未认领 Agent";
}

export function TaskPanel({ theme, layout, agentId, workspaceId }: PluginAgentPanelProps) {
  const workspaceDirectory = useWorkspace(workspaceId, ({ directory }) => directory);
  const currentAgent = useAgent(
    agentId,
    ({ provider, model, currentModeId, thinkingOptionId }) => ({
      provider,
      model,
      currentModeId,
      thinkingOptionId,
    }),
  );
  const loadTaskList = useRpc(getBeadsTaskList);
  const loadExecutionConfig = useRpc(getExecutionAgentConfig);
  const inheritedConfig = useMemo<ExecutionAgentConfig | null>(() => {
    if (!currentAgent?.provider?.trim()) return null;
    return {
      provider: composeProviderModel(currentAgent.provider, currentAgent.model),
      modeId: currentAgent.currentModeId,
      thinkingOptionId: currentAgent.thinkingOptionId,
    };
  }, [currentAgent]);
  const [snapshot, setSnapshot] = useState<BeadsTaskList | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [requirement, setRequirement] = useState("");
  const [copyingPrompt, setCopyingPrompt] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; variant: ToastVariant } | null>(null);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        screen: {
          flex: 1,
          gap: layout.compact ? 12 : 16,
          padding: layout.compact ? 12 : 16,
          backgroundColor: theme.colors.surface0,
        },
        header: {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        },
        title: {
          flexShrink: 1,
          color: theme.colors.foreground,
          fontSize: layout.compact ? 22 : 26,
          fontWeight: "700",
          lineHeight: layout.compact ? 28 : 32,
        },
        headerActions: {
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          flexShrink: 0,
        },
        headerButton: {
          minHeight: 34,
          justifyContent: "center",
          paddingHorizontal: 10,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: theme.colors.foregroundMuted,
        },
        headerButtonDisabled: {
          opacity: 0.55,
        },
        headerButtonLabel: {
          color: theme.colors.foreground,
          fontSize: layout.compact ? 11 : 12,
          fontWeight: "600",
        },
        requirementSection: {
          gap: 6,
        },
        requirementLabel: {
          color: theme.colors.foreground,
          fontSize: layout.compact ? 12 : 13,
          fontWeight: "600",
        },
        requirementInput: {
          minHeight: layout.compact ? 76 : 96,
          maxHeight: 180,
          paddingHorizontal: 10,
          paddingVertical: 8,
          color: theme.colors.foreground,
          fontSize: layout.compact ? 12 : 13,
          lineHeight: 18,
          borderWidth: 1,
          borderColor: theme.colors.foregroundMuted,
          borderRadius: 8,
          textAlignVertical: "top",
        },
        listSection: {
          flex: 1,
          minHeight: 0,
          gap: 8,
        },
        sectionHeader: {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        },
        sectionTitle: {
          color: theme.colors.foregroundMuted,
          fontSize: 12,
          fontWeight: "600",
          lineHeight: 18,
        },
        listStatus: {
          flexShrink: 1,
          color: theme.colors.foregroundMuted,
          fontSize: 12,
          lineHeight: 18,
          textAlign: "right",
        },
        error: {
          color: theme.colors.statusDanger,
          fontSize: 12,
          lineHeight: 18,
        },
        scroll: {
          flex: 1,
          minHeight: 0,
        },
        scrollContent: {
          gap: 8,
          paddingBottom: 12,
        },
        emptyCard: {
          minHeight: 180,
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          padding: 24,
        },
        emptyTitle: {
          color: theme.colors.foreground,
          fontSize: 16,
          fontWeight: "600",
          lineHeight: 22,
          textAlign: "center",
        },
        emptyDescription: {
          color: theme.colors.foregroundMuted,
          fontSize: 13,
          lineHeight: 19,
          textAlign: "center",
        },
        taskCard: {
          gap: 7,
          padding: 12,
        },
        taskHeader: {
          flexDirection: "row",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 8,
        },
        taskTitle: {
          flex: 1,
          color: theme.colors.foreground,
          fontSize: 15,
          fontWeight: "600",
          lineHeight: 20,
        },
        taskStatus: {
          color: theme.colors.foregroundMuted,
          fontSize: 12,
          fontWeight: "600",
          lineHeight: 18,
        },
        taskStatusActive: {
          color: theme.colors.accent,
        },
        taskStatusDanger: {
          color: theme.colors.statusDanger,
        },
        taskId: {
          color: theme.colors.foregroundMuted,
          fontSize: 11,
          lineHeight: 16,
        },
        taskMeta: {
          color: theme.colors.foregroundMuted,
          fontSize: 12,
          lineHeight: 18,
        },
        taskDescription: {
          color: theme.colors.foreground,
          fontSize: 13,
          lineHeight: 19,
        },
        taskDependency: {
          color: theme.colors.foregroundMuted,
          fontSize: 12,
          lineHeight: 18,
        },
      }),
    [layout.compact, theme],
  );

  const handleCopyPrompt = useCallback(async () => {
    if (copyingPrompt) return;

    setCopyingPrompt(true);
    setToast(null);
    let config: ExecutionAgentConfig | null = null;
    let configSource: "saved" | "current" | "none" = "none";
    let configReadFailed = false;
    try {
      try {
        const result = await loadExecutionConfig({ agentId });
        if (result.config) {
          config = result.config;
          configSource = "saved";
        } else if (inheritedConfig) {
          config = inheritedConfig;
          configSource = "current";
        }
      } catch {
        configReadFailed = true;
        if (inheritedConfig) {
          config = inheritedConfig;
          configSource = "current";
        }
      }

      await copyToClipboard(buildBeadsPrompt(config, requirement));
      const message =
        configSource === "saved"
          ? "已复制提示词，已带入已保存的执行 Agent 配置"
          : configSource === "current"
            ? configReadFailed
              ? "已复制提示词，已带入当前 Agent 配置（保存配置读取失败）"
              : "已复制提示词，已带入当前 Agent 配置"
            : configReadFailed
              ? "已复制提示词，但未读取到执行 Agent 配置"
              : "已复制提示词，当前没有可用的执行 Agent 配置";
      setToast({ message, variant: "success" });
    } catch (cause) {
      setToast({ message: errorMessage(cause), variant: "error" });
    } finally {
      setCopyingPrompt(false);
    }
  }, [agentId, copyingPrompt, inheritedConfig, loadExecutionConfig, requirement]);

  const refreshTasks = useCallback(
    async (initial = false) => {
      if (!workspaceDirectory) {
        setSnapshot(null);
        setError(null);
        setLoading(false);
        return;
      }

      if (initial) setLoading(true);
      else setRefreshing(true);
      setError(null);
      try {
        const nextSnapshot = await loadTaskList({ directory: workspaceDirectory });
        setSnapshot(nextSnapshot);
        setError(nextSnapshot.lastError);
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        if (initial) setLoading(false);
        else setRefreshing(false);
      }
    },
    [loadTaskList, workspaceDirectory],
  );

  useEffect(() => {
    setSnapshot(null);
    void refreshTasks(true);
  }, [refreshTasks]);

  const taskCount = snapshot?.tasks.length ?? 0;
  const listStatus = loading
    ? "正在读取任务"
    : refreshing
      ? "正在刷新"
      : snapshot?.beadsAvailable
        ? `共 ${taskCount} 项`
        : "当前目录未初始化 Beads";

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.title}>
          任务面板
        </Text>
        <View style={styles.headerActions}>
          <Pressable
            accessibilityLabel="复制 Beads 父 Agent 提示词"
            accessibilityRole="button"
            disabled={copyingPrompt}
            onPress={() => void handleCopyPrompt()}
            style={({ pressed }) => [
              styles.headerButton,
              (pressed || copyingPrompt) && styles.headerButtonDisabled,
            ]}
          >
            <Text style={styles.headerButtonLabel}>{copyingPrompt ? "复制中…" : "复制提示词"}</Text>
          </Pressable>
          <Pressable
            accessibilityLabel="刷新 Beads 任务"
            accessibilityRole="button"
            disabled={loading || refreshing || !workspaceDirectory}
            onPress={() => void refreshTasks()}
            style={({ pressed }) => [
              styles.headerButton,
              (pressed || loading || refreshing || !workspaceDirectory) &&
                styles.headerButtonDisabled,
            ]}
          >
            <Text style={styles.headerButtonLabel}>{refreshing ? "刷新中…" : "刷新"}</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.requirementSection}>
        <Text style={styles.requirementLabel}>本次需求（复制提示词时会带入）：</Text>
        <TextInput
          accessibilityLabel="填写本次 Beads 任务需求"
          multiline
          onChangeText={setRequirement}
          placeholder="请输入希望主 Agent 设计和推进的具体需求"
          placeholderTextColor={theme.colors.foregroundMuted}
          style={styles.requirementInput}
          value={requirement}
        />
      </View>

      <AgentConfigPanel agentId={agentId} cwd={workspaceDirectory} layout={layout} theme={theme} />

      <View style={styles.listSection}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>
            BEADS 任务{taskCount > 0 ? ` · ${taskCount}` : ""}
          </Text>
          <Text style={styles.listStatus}>{listStatus}</Text>
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          {taskCount === 0 ? (
            <Card theme={theme} style={styles.emptyCard}>
              <Text style={styles.emptyTitle}>{loading ? "正在读取任务" : "暂无任务"}</Text>
              <Text style={styles.emptyDescription}>
                {snapshot && !snapshot.beadsAvailable
                  ? "当前工作目录还没有可用的 Beads 工作区"
                  : "当前没有可展示的 Beads 任务"}
              </Text>
            </Card>
          ) : (
            snapshot?.tasks.map((task) => {
              const statusStyle =
                task.status === "blocked" || task.status === "deferred"
                  ? styles.taskStatusDanger
                  : task.status === "in_progress"
                    ? styles.taskStatusActive
                    : undefined;
              return (
                <Card key={task.id} theme={theme} style={styles.taskCard}>
                  <View style={styles.taskHeader}>
                    <Text numberOfLines={2} style={styles.taskTitle}>
                      {task.title}
                    </Text>
                    <Text style={[styles.taskStatus, statusStyle]}>{statusLabel(task.status)}</Text>
                  </View>
                  <Text style={styles.taskId}>{task.id}</Text>
                  {task.description ? (
                    <Text numberOfLines={3} style={styles.taskDescription}>
                      {task.description}
                    </Text>
                  ) : null}
                  <Text style={styles.taskMeta}>{assigneeLabel(task)}</Text>
                  {task.dependencies.length > 0 ? (
                    <Text style={styles.taskDependency}>
                      前置依赖：
                      {task.dependencies
                        .map(
                          (dependency) => `${dependency.id}（${statusLabel(dependency.status)}）`,
                        )
                        .join("、")}
                    </Text>
                  ) : null}
                </Card>
              );
            })
          )}
        </ScrollView>
      </View>
      <Toast
        compact={layout.compact}
        message={toast?.message ?? ""}
        onDismiss={() => setToast(null)}
        theme={theme}
        variant={toast?.variant ?? "success"}
        visible={toast !== null}
      />
    </View>
  );
}
