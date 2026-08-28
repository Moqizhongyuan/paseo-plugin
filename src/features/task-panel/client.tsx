import { type PluginAgentPanelProps, useRpc, useWorkspace } from "@getpaseo/plugin";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Card } from "../../components";
import {
  getTaskSchedulerSnapshot,
  startTaskScheduler,
  stopTaskScheduler,
  type TaskSchedulerSnapshot,
  type TaskSchedulerTask,
} from "./shared";

const SNAPSHOT_REFRESH_INTERVAL_MS = 3_000;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请稍后重试";
}

function phaseLabel(phase: TaskSchedulerSnapshot["phase"]) {
  return {
    stopped: "已停止",
    starting: "正在启动",
    checking: "正在检查任务",
    waiting: "等待可执行任务",
    dispatching: "正在派发任务",
    executing: "子 Agent 执行中",
    error: "调度异常",
  }[phase];
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

function agentStatusLabel(status: string) {
  return (
    {
      initializing: "初始化中",
      idle: "空闲",
      running: "运行中",
      error: "错误",
      closed: "已关闭",
    }[status] ?? status
  );
}

function assignedAgent(task: TaskSchedulerTask) {
  if (task.agentId) return `子 Agent：${task.agentId}`;
  if (task.assignee) return `Beads：${task.assignee}`;
  return "未指派 Agent";
}

export function TaskPanel({ theme, layout, agentId, workspaceId }: PluginAgentPanelProps) {
  const workspaceDirectory = useWorkspace(workspaceId, ({ directory }) => directory);
  const loadSnapshot = useRpc(getTaskSchedulerSnapshot);
  const startScheduler = useRpc(startTaskScheduler);
  const stopScheduler = useRpc(stopTaskScheduler);
  const [snapshot, setSnapshot] = useState<TaskSchedulerSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        toggle: {
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          minHeight: 36,
          flexShrink: 0,
        },
        toggleTrack: {
          width: 44,
          height: 26,
          justifyContent: "center",
          padding: 3,
          borderRadius: 13,
          backgroundColor: theme.colors.foregroundMuted,
        },
        toggleTrackEnabled: {
          backgroundColor: theme.colors.accent,
        },
        toggleThumb: {
          width: 20,
          height: 20,
          borderRadius: 10,
          backgroundColor: theme.colors.surface0,
        },
        toggleThumbEnabled: {
          transform: [{ translateX: 18 }],
        },
        toggleLabel: {
          color: theme.colors.foregroundMuted,
          fontSize: 13,
          fontWeight: "600",
        },
        toggleLabelEnabled: {
          color: theme.colors.foreground,
        },
        pressed: {
          opacity: 0.75,
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
        schedulerStatus: {
          color: theme.colors.foregroundMuted,
          fontSize: 12,
          lineHeight: 18,
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
        taskError: {
          color: theme.colors.statusDanger,
          fontSize: 12,
          lineHeight: 18,
        },
      }),
    [layout.compact, theme],
  );

  useEffect(() => {
    let active = true;

    if (!workspaceDirectory) {
      setSnapshot(null);
      setLoading(false);
      setError(null);
      return () => {
        active = false;
      };
    }

    const input = { workspaceId, parentAgentId: agentId, directory: workspaceDirectory };

    async function loadInitialSnapshot() {
      try {
        const nextSnapshot = await loadSnapshot(input);
        if (!active) return;
        setSnapshot(nextSnapshot);
        setError(nextSnapshot.lastError);
      } catch (cause) {
        if (active) setError(errorMessage(cause));
      } finally {
        if (active) setLoading(false);
      }
    }

    setLoading(true);
    setSnapshot(null);
    void loadInitialSnapshot();
    return () => {
      active = false;
    };
  }, [agentId, loadSnapshot, workspaceDirectory, workspaceId]);

  useEffect(() => {
    if (!workspaceDirectory || !snapshot?.enableCycle) return;

    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const input = { workspaceId, parentAgentId: agentId, directory: workspaceDirectory };

    async function refreshSnapshot() {
      let keepRefreshing = true;
      try {
        const nextSnapshot = await loadSnapshot(input);
        if (!active) return;
        keepRefreshing = nextSnapshot.enableCycle;
        setSnapshot(nextSnapshot);
        setError(nextSnapshot.lastError);
      } catch (cause) {
        if (active) setError(errorMessage(cause));
      } finally {
        if (active && keepRefreshing) {
          timer = setTimeout(() => {
            void refreshSnapshot();
          }, SNAPSHOT_REFRESH_INTERVAL_MS);
        }
      }
    }

    timer = setTimeout(() => {
      void refreshSnapshot();
    }, SNAPSHOT_REFRESH_INTERVAL_MS);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [agentId, loadSnapshot, snapshot?.enableCycle, workspaceDirectory, workspaceId]);

  async function handleToggle() {
    if (!workspaceDirectory || actionLoading) return;

    const input = { workspaceId, parentAgentId: agentId, directory: workspaceDirectory };
    setActionLoading(true);
    setError(null);
    try {
      const nextSnapshot = snapshot?.enableCycle
        ? await stopScheduler(input)
        : await startScheduler(input);
      setSnapshot(nextSnapshot);
      setError(nextSnapshot.lastError);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setActionLoading(false);
    }
  }

  const loopEnabled = snapshot?.enableCycle ?? false;
  const taskCount = snapshot?.tasks.length ?? 0;
  const statusText = snapshot
    ? snapshot.beadsAvailable
      ? `${phaseLabel(snapshot.phase)} · 活跃 ${snapshot.activeTaskCount}${
          snapshot.pendingNotificationCount > 0
            ? ` · 待通知 ${snapshot.pendingNotificationCount}`
            : ""
        }`
      : "当前目录未初始化 Beads"
    : loading
      ? "正在读取任务"
      : "等待工作区";

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.title}>
          任务面板
        </Text>
        <Pressable
          accessibilityLabel="任务循环"
          accessibilityRole="switch"
          accessibilityState={{
            checked: loopEnabled,
            disabled: actionLoading || !workspaceDirectory,
          }}
          disabled={actionLoading || !workspaceDirectory}
          onPress={() => void handleToggle()}
          style={({ pressed }) => [styles.toggle, pressed && styles.pressed]}
        >
          <Text style={[styles.toggleLabel, loopEnabled && styles.toggleLabelEnabled]}>
            {actionLoading ? "处理中…" : loopEnabled ? "循环已开启" : "开启循环"}
          </Text>
          <View style={[styles.toggleTrack, loopEnabled && styles.toggleTrackEnabled]}>
            <View style={[styles.toggleThumb, loopEnabled && styles.toggleThumbEnabled]} />
          </View>
        </Pressable>
      </View>

      <View style={styles.listSection}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>
            BEADS 任务{taskCount > 0 ? ` · ${taskCount}` : ""}
          </Text>
          <Text style={styles.schedulerStatus}>{statusText}</Text>
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
                  <Text style={styles.taskMeta}>{assignedAgent(task)}</Text>
                  {task.agentStatus ? (
                    <Text style={styles.taskMeta}>
                      Agent 状态：{agentStatusLabel(task.agentStatus)}
                    </Text>
                  ) : null}
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
                  {task.error ? <Text style={styles.taskError}>{task.error}</Text> : null}
                </Card>
              );
            })
          )}
        </ScrollView>
      </View>
    </View>
  );
}
