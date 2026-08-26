import { type PluginAgentPanelProps, useRpc, useWorkspace } from "@getpaseo/plugin";
import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { getCurrentBranch, getShortcutBinding, saveShortcutBinding } from "./shared";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请稍后重试";
}

export function ShortcutPanel({ theme, layout, agentId, workspaceId }: PluginAgentPanelProps) {
  const workspaceDirectory = useWorkspace(workspaceId, ({ directory }) => directory);
  const loadShortcutBinding = useRpc(getShortcutBinding);
  const loadCurrentBranch = useRpc(getCurrentBranch);
  const persistShortcutBinding = useRpc(saveShortcutBinding);
  const [gitBranch, setGitBranch] = useState("");
  const [draftBranch, setDraftBranch] = useState("");
  const [editingBranch, setEditingBranch] = useState(false);
  const [branchLoading, setBranchLoading] = useState(true);
  const [savingBranch, setSavingBranch] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    if (!workspaceDirectory) {
      setBranchLoading(false);
      return () => {
        active = false;
      };
    }

    const directory = workspaceDirectory;

    setBranchLoading(true);
    setBranchError(null);
    setEditingBranch(false);

    async function loadBranch() {
      try {
        const stored = await loadShortcutBinding({ agentId });
        if (!active) return;

        if (stored.branch) {
          setGitBranch(stored.branch);
          setDraftBranch(stored.branch);
          return;
        }

        const current = await loadCurrentBranch({ directory });
        if (!active) return;

        const fallbackBranch = current.branch ?? "";
        setGitBranch(fallbackBranch);
        setDraftBranch(fallbackBranch);
      } catch (cause) {
        if (active) setBranchError(errorMessage(cause));
      } finally {
        if (active) setBranchLoading(false);
      }
    }

    void loadBranch();
    return () => {
      active = false;
    };
  }, [agentId, loadCurrentBranch, loadShortcutBinding, workspaceDirectory]);

  function handleStartEditing() {
    if (branchLoading || savingBranch) return;
    setDraftBranch(gitBranch);
    setBranchError(null);
    setEditingBranch(true);
  }

  function handleCancelEditing() {
    if (savingBranch) return;
    setDraftBranch(gitBranch);
    setBranchError(null);
    setEditingBranch(false);
  }

  async function handleSaveBranch() {
    const normalizedBranch = draftBranch.trim();
    if (!normalizedBranch || savingBranch) return;

    setSavingBranch(true);
    setBranchError(null);
    try {
      const saved = await persistShortcutBinding({ agentId, branch: normalizedBranch });
      setGitBranch(saved.branch);
      setDraftBranch(saved.branch);
      setEditingBranch(false);
    } catch (cause) {
      setBranchError(errorMessage(cause));
    } finally {
      setSavingBranch(false);
    }
  }

  const styles = useMemo(
    () =>
      StyleSheet.create({
        screen: {
          flex: 1,
          padding: layout.compact ? 16 : 24,
          backgroundColor: theme.colors.surface0,
        },
        title: {
          color: theme.colors.foreground,
          fontSize: layout.compact ? 18 : 20,
          fontWeight: "600",
        },
        subTitle: {
          color: theme.colors.foreground,
          fontSize: layout.compact ? 14 : 16,
          fontWeight: "500",
          marginTop: 12,
          marginBottom: 8,
        },
        infoRow: {
          height: 40,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
        },
        infoText: {
          flex: 1,
          color: theme.colors.foreground,
        },
        fieldLabel: {
          flexShrink: 0,
          color: theme.colors.foreground,
          fontSize: layout.compact ? 13 : 14,
        },
        branchInput: {
          flex: 1,
          minWidth: 0,
          height: 40,
          paddingHorizontal: 12,
          paddingVertical: 8,
          color: theme.colors.foreground,
          borderWidth: 1,
          borderColor: theme.colors.foregroundMuted,
          borderRadius: 8,
        },
        iconButton: {
          width: 32,
          height: 32,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 6,
        },
        iconGlyph: {
          fontSize: 20,
          lineHeight: 22,
        },
        saveGlyph: {
          color: theme.colors.accent,
        },
        cancelGlyph: {
          color: theme.colors.foregroundMuted,
        },
        pressed: {
          opacity: 0.7,
        },
        disabled: {
          opacity: 0.45,
        },
        error: {
          marginTop: 4,
          color: theme.colors.statusDanger,
          fontSize: 12,
        },
      }),
    [layout.compact, theme],
  );

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>快捷命令</Text>
      <Text style={styles.subTitle}>当前Agent基本信息：</Text>
      <View style={styles.infoRow}>
        <Text numberOfLines={1} style={styles.infoText}>
          agentId：{agentId}
        </Text>
      </View>
      <View style={styles.infoRow}>
        <Text numberOfLines={1} style={styles.infoText}>
          workspaceId：{workspaceId}
        </Text>
      </View>
      {editingBranch ? (
        <View style={styles.infoRow}>
          <Text style={styles.fieldLabel}>git branch：</Text>
          <TextInput
            accessibilityLabel="当前 Agent 绑定的 Git 分支"
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            onChangeText={setDraftBranch}
            placeholder="请输入绑定的 Git 分支"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={styles.branchInput}
            value={draftBranch}
          />
          <Pressable
            accessibilityLabel="保存 Git 分支绑定"
            accessibilityRole="button"
            disabled={!draftBranch.trim() || savingBranch}
            onPress={() => void handleSaveBranch()}
            style={({ pressed }) => [
              styles.iconButton,
              pressed && styles.pressed,
              (!draftBranch.trim() || savingBranch) && styles.disabled,
            ]}
          >
            <Text accessible={false} style={[styles.iconGlyph, styles.saveGlyph]}>
              ✓
            </Text>
          </Pressable>
          <Pressable
            accessibilityLabel="取消编辑 Git 分支"
            accessibilityRole="button"
            disabled={savingBranch}
            onPress={handleCancelEditing}
            style={({ pressed }) => [
              styles.iconButton,
              pressed && styles.pressed,
              savingBranch && styles.disabled,
            ]}
          >
            <Text accessible={false} style={[styles.iconGlyph, styles.cancelGlyph]}>
              ×
            </Text>
          </Pressable>
        </View>
      ) : (
        <Pressable
          accessibilityLabel="编辑当前 Agent 绑定的 Git 分支"
          accessibilityRole="button"
          disabled={branchLoading}
          onPress={handleStartEditing}
          style={({ pressed }) => [styles.infoRow, pressed && styles.pressed]}
        >
          <Text style={styles.fieldLabel}>git branch：</Text>
          <Text numberOfLines={1} style={styles.infoText}>
            {branchLoading ? "读取中…" : gitBranch || "点击设置绑定分支"}
          </Text>
        </Pressable>
      )}
      {branchError ? <Text style={styles.error}>{branchError}</Text> : null}
      <Text style={styles.subTitle}>指令</Text>
    </View>
  );
}
