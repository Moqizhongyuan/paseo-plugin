import {
  type PluginAgentPanelProps,
  useAgent,
  usePaseo,
  useRpc,
  useWorkspace,
} from "@getpaseo/plugin";
import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Button, Toast, type ToastVariant } from "../../components";
import {
  DEFAULT_MR_URL,
  getCurrentBranch,
  getShortcutBinding,
  saveShortcutBinding,
} from "./shared";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请稍后重试";
}

// “评审当前 MR”只创建一个 GPT 管理 Agent，由它负责后续编排两个 Claude 子 Agent 与飞书文档。
// 管理 Agent 固定使用完整 provider/model，并以 full-access 模式运行（它需要创建子 Agent 与飞书文档，
// 这些是允许的外部写入）；两个 Claude 子 Agent 的 provider/模式由管理 Agent 自行选择。
const REVIEW_MANAGER_PROVIDER = "codex/gpt-5.6-sol";
const REVIEW_MANAGER_MODE_ID = "full-access";

// 构造 GPT 管理 Agent 的 initial prompt：插件只提供 MR URL、绑定分支、workspaceId 和整个管理流程，
// 真正的 MR 取证、创建两个 Claude 子 Agent、收集结果、创建飞书文档都由这个管理 Agent 异步负责。
function buildReviewManagerPrompt(
  targetMrUrl: string,
  branch: string,
  reviewWorkspaceId: string,
): string {
  return `你是本次 MR 代码评审的“管理 Agent”，负责端到端编排评审并产出一份飞书云文档。请按下面的流程执行。

输入信息：
- MR 链接：${JSON.stringify(targetMrUrl)}
- 当前绑定分支：${JSON.stringify(branch)}
- 目标 Workspace ID：${JSON.stringify(reviewWorkspaceId)}

一、你自己的取证（先做）：
1. 核对 MR 链接、MR 的源分支与目标分支、当前 Git 状态和远端配置；从真实 diff 取证（例如比较 MR 目标分支与源分支，或从代码托管平台读取 MR diff），不要根据分支名称或文件名猜测改动内容。
2. 如信息缺失或不一致（例如 MR 链接无法访问、分支对不上），在最终结论中如实说明，不要臆测。

二、创建两个 Claude 子 Agent（遵循 Paseo 多 Agent 规则）：
- 使用 Paseo skill / MCP（create_agent 等）在目标 Workspace ${JSON.stringify(reviewWorkspaceId)} 中创建两个 Claude 子 Agent；不要绑定发起本次评审的快捷面板 Agent，也不要把它当作 parent。
- provider/model 选择：按当前 ~/.paseo/orchestration-preferences.json 和 provider 实际可用状态选择 Claude provider/model，优先使用受管的 claude-super-relay 完整 provider/model（例如 claude-super-relay/claude-opus-4-8[1m]）；不要假设内置 claude/claude-opus-5 有可用凭据。
- 两个子 Agent 都使用 plan / 只读模式、同一个 Workspace、清晰的标题和 labels（例如 role=primary-review / role=verification-review）。
- 每个子任务都必须写清：目标、允许范围、禁止范围、背景、完成标准、验证命令、失败/回滚边界，以及固定的结构化汇报格式。必要时先建立或指定一个 chat room 做协作与结果收集。

Claude 子 Agent 1（主评审）：
- 只读审查 MR 改动的：正确性、边界、异常处理、安全、性能、可维护性、测试覆盖，以及与项目既有约定的一致性。
- 禁止修改任何文件、禁止 git add/commit/push、禁止改写历史、禁止发布 MR 评论或任何远端写入。
- 输出结构化报告：总体结论 + 逐条问题（严重级别 blocker/major/minor/nit、path:line、证据、建议）、验证情况、不确定项。

Claude 子 Agent 2（复核）：
- 不能信任 Agent 1 的结论；必须独立重新读取真实 diff 与相关代码上下文取证。
- 逐条把 Agent 1 的问题标记为 confirmed / rejected / uncertain 并给出自己的 path:line 证据，补充 Agent 1 遗漏的问题，给出纠正后的最终建议（approve / request-changes / needs-discussion）。
- 同样只读，禁止修改文件、git add/commit/push、改写历史或发布 MR 评论。
- 你可以先等待 Agent 1 完成，再把它的状态与报告原文发送给 Agent 2；即使 Agent 1 失败、超时或没有产出文本，也要把该状态转交给 Agent 2，并要求 Agent 2 完整、独立地评审。

三、创建飞书云文档（结果汇总）：
- 先读取 lark-doc 与 lark-shared 的使用要求以及创建文档所需的 references。
- 默认使用 \`lark-cli docs +create --as user\` 的 XML 格式创建文档；创建后必须检查返回 JSON 的 ok:true 与文档 URL。若失败，请如实报告真实的认证/权限原因，不得假称已创建。
- 文档标题与正文要清楚标识：本次 MR、评审时间、两个 Agent 的结论、问题清单、证据、验证结果和不确定项。不要广播消息或发送到群聊。

四、红线（管理 Agent 自身）：
- 不得修改当前仓库代码、不得 git commit/push、不得修改 MR 或发布 MR 评论。只读评审与创建飞书文档是允许的外部写入。

五、最终回复：
- 汇总两个 Agent 的评审结论要点，并在你自己的最终回复中明确给出所创建飞书文档的 URL（若文档创建失败，则说明失败原因）。`;
}

export function ShortcutPanel({ theme, layout, agentId, workspaceId }: PluginAgentPanelProps) {
  const paseo = usePaseo();
  const workspaceDirectory = useWorkspace(workspaceId, ({ directory }) => directory);
  const currentAgentConfig = useAgent(
    agentId,
    ({ provider, model, currentModeId, thinkingOptionId }) => ({
      provider,
      model,
      currentModeId,
      thinkingOptionId,
    }),
  );
  const loadShortcutBinding = useRpc(getShortcutBinding);
  const loadCurrentBranch = useRpc(getCurrentBranch);
  const persistShortcutBinding = useRpc(saveShortcutBinding);
  const [gitBranch, setGitBranch] = useState("");
  const [draftBranch, setDraftBranch] = useState("");
  const [mrUrl, setMrUrl] = useState(DEFAULT_MR_URL);
  const [draftMrUrl, setDraftMrUrl] = useState(DEFAULT_MR_URL);
  const [editingBranch, setEditingBranch] = useState(false);
  const [editingMrUrl, setEditingMrUrl] = useState(false);
  const [branchLoading, setBranchLoading] = useState(true);
  const [savingBranch, setSavingBranch] = useState(false);
  const [savingMrUrl, setSavingMrUrl] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [sendingMainSyncPrompt, setSendingMainSyncPrompt] = useState(false);
  const [sendingMrSyncPrompt, setSendingMrSyncPrompt] = useState(false);
  const [creatingPushAgent, setCreatingPushAgent] = useState(false);
  const [creatingReviewManagerAgent, setCreatingReviewManagerAgent] = useState(false);
  const [toast, setToast] = useState<{ message: string; variant: ToastVariant } | null>(null);

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
    setEditingMrUrl(false);

    async function loadBranch() {
      try {
        const stored = await loadShortcutBinding({ agentId });
        if (!active) return;

        const loadedMrUrl = stored.mrUrl ?? DEFAULT_MR_URL;
        setMrUrl(loadedMrUrl);
        setDraftMrUrl(loadedMrUrl);

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
      const saved = await persistShortcutBinding({
        agentId,
        branch: normalizedBranch,
        mrUrl: mrUrl.trim() || DEFAULT_MR_URL,
      });
      setGitBranch(saved.branch);
      setDraftBranch(saved.branch);
      setMrUrl(saved.mrUrl);
      setDraftMrUrl(saved.mrUrl);
      setEditingBranch(false);
    } catch (cause) {
      setBranchError(errorMessage(cause));
    } finally {
      setSavingBranch(false);
    }
  }

  function handleStartEditingMrUrl() {
    if (branchLoading || savingMrUrl) return;
    setDraftMrUrl(mrUrl);
    setBranchError(null);
    setEditingMrUrl(true);
  }

  function handleCancelEditingMrUrl() {
    if (savingMrUrl) return;
    setDraftMrUrl(mrUrl);
    setBranchError(null);
    setEditingMrUrl(false);
  }

  async function handleSaveMrUrl() {
    const normalizedBranch = gitBranch.trim();
    const normalizedMrUrl = draftMrUrl.trim();
    if (!normalizedBranch || !normalizedMrUrl || savingMrUrl) return;

    setSavingMrUrl(true);
    setBranchError(null);
    try {
      const saved = await persistShortcutBinding({
        agentId,
        branch: normalizedBranch,
        mrUrl: normalizedMrUrl,
      });
      setGitBranch(saved.branch);
      setDraftBranch(saved.branch);
      setMrUrl(saved.mrUrl);
      setDraftMrUrl(saved.mrUrl);
      setEditingMrUrl(false);
    } catch (cause) {
      setBranchError(errorMessage(cause));
    } finally {
      setSavingMrUrl(false);
    }
  }

  async function handleCreatePushAgent() {
    const targetBranch = gitBranch.trim();
    if (!targetBranch || !currentAgentConfig || creatingPushAgent) return;

    setCreatingPushAgent(true);
    setToast(null);
    try {
      const provider = currentAgentConfig.model
        ? `${currentAgentConfig.provider}/${currentAgentConfig.model}`
        : currentAgentConfig.provider;

      await paseo.workspaces.ref(workspaceId).agents.create({
        config: {
          provider,
          ...(currentAgentConfig.currentModeId ? { modeId: currentAgentConfig.currentModeId } : {}),
          ...(currentAgentConfig.thinkingOptionId
            ? { thinkingOptionId: currentAgentConfig.thinkingOptionId }
            : {}),
        },
        title: "提交并推送代码",
        prompt: `请在当前 Workspace 中完成以下任务：
1. 检查当前 Git 状态、当前分支和远端配置。
2. 将当前工作区中需要提交的代码整理为一个合适的 commit，提交信息根据实际改动生成。
3. 将该 commit 推送到远端目标分支 ${JSON.stringify(targetBranch)}。
4. 不要丢弃或覆盖现有改动；如果无法安全完成，请停止并说明原因。`,
      });

      setToast({ message: `已创建推送 Agent，目标分支：${targetBranch}`, variant: "success" });
    } catch (cause) {
      setToast({ message: errorMessage(cause), variant: "error" });
    } finally {
      setCreatingPushAgent(false);
    }
  }

  // 点击“评审当前 MR”时，只创建一个 GPT 管理 Agent，把 MR 信息与整个管理流程交给它异步执行。
  async function handleCreateReviewManagerAgent() {
    const targetBranch = gitBranch.trim();
    const targetMrUrl = mrUrl.trim();
    if (
      branchLoading ||
      !targetBranch ||
      !targetMrUrl ||
      targetMrUrl === DEFAULT_MR_URL ||
      creatingReviewManagerAgent
    ) {
      return;
    }

    setCreatingReviewManagerAgent(true);
    setToast(null);
    try {
      // 只创建一个 GPT 管理 Agent（新 tab，不绑定当前面板 agentId 为 parent）。
      // 后续的双 Claude 子 Agent 编排与飞书文档由这个管理 Agent 异步负责，插件不参与等待/转发。
      await paseo.workspaces.ref(workspaceId).agents.create({
        config: { provider: REVIEW_MANAGER_PROVIDER, modeId: REVIEW_MANAGER_MODE_ID },
        title: "MR Code Review 管理",
        labels: { shortcut: "mr-review", role: "review-manager" },
        prompt: buildReviewManagerPrompt(targetMrUrl, targetBranch, workspaceId),
      });

      setToast({
        message: `已在新 tab 创建 MR 评审管理 Agent，将由它编排评审并生成飞书文档`,
        variant: "success",
      });
    } catch (cause) {
      setToast({ message: errorMessage(cause), variant: "error" });
    } finally {
      setCreatingReviewManagerAgent(false);
    }
  }

  async function handleSendMrSyncPrompt() {
    const sourceBranch = gitBranch.trim();
    const targetMrUrl = mrUrl.trim();
    if (!sourceBranch || !targetMrUrl || targetMrUrl === DEFAULT_MR_URL || sendingMrSyncPrompt) {
      return;
    }

    setSendingMrSyncPrompt(true);
    setToast(null);
    try {
      await paseo.agents.ref(agentId)
        .send(`请在当前 Workspace 中根据以下 MR 链接同步目标分支的最新代码，并解决产生的冲突：
MR 链接：${JSON.stringify(targetMrUrl)}
当前 Agent 绑定分支：${JSON.stringify(sourceBranch)}

1. 先检查 Git 状态、当前分支、远端配置，以及 MR 的源分支和目标分支。请从 MR 链接或对应代码托管平台读取真实信息，不要根据分支名称猜测。
2. 确认 MR 源分支与当前 Agent 绑定分支一致；如果不一致或无法确认，请停止并说明原因。
3. 不要丢弃、覆盖或暂存无关的现有改动。如果工作区状态导致无法安全同步，请停止并说明原因。
4. 拉取 MR 目标分支的最新远端代码，并将其合并到 MR 源分支。默认使用 merge，不要 rebase 或改写已有历史。
5. 如果产生冲突，请逐项理解双方改动后解决，保留两边仍然需要的业务逻辑；不要简单使用 ours 或 theirs 覆盖。
6. 完成必要的格式检查、类型检查和测试。如果需要完成 merge，可以创建 merge commit。不要推送远端；本次操作只同步本地代码。
7. 最后汇报 MR 源分支和目标分支、同步前后的 commit、冲突文件、解决方式、验证结果、当前 Git 状态，并明确说明本次未推送远端。`);

      setToast({
        message: `已向当前 Agent 发送同步 MR 目标分支指令：${targetMrUrl}`,
        variant: "success",
      });
    } catch (cause) {
      setToast({ message: errorMessage(cause), variant: "error" });
    } finally {
      setSendingMrSyncPrompt(false);
    }
  }

  async function handleSendMainSyncPrompt() {
    const currentBranch = gitBranch.trim();
    if (!currentBranch || sendingMainSyncPrompt) return;

    setSendingMainSyncPrompt(true);
    setToast(null);
    try {
      await paseo.agents.ref(agentId)
        .send(`请在当前 Workspace 中为当前 Git 分支同步远端主分支的最新代码：
当前 Agent 绑定分支：${JSON.stringify(currentBranch)}

1. 先检查 Git 状态、当前分支和远端配置，并确认当前分支与上述绑定分支一致；如果不一致，请停止并说明原因。
2. 从远端 HEAD 或仓库配置确认真实的默认主分支，不要直接假设主分支名称是 main 或 master。
3. 不要丢弃、覆盖或暂存无关的现有改动。如果工作区状态导致无法安全同步，请停止并说明原因。
4. 拉取远端主分支的最新代码。如果当前分支就是主分支，请仅做安全的 fast-forward 更新；否则将最新主分支合并到当前分支。不要 rebase 或改写已有历史。
5. 如果产生冲突，请逐项理解双方改动后解决，保留两边仍然需要的业务逻辑；不要简单使用 ours 或 theirs 覆盖。
6. 完成必要的格式检查、类型检查和测试。如果需要完成 merge，可以创建 merge commit。不要推送远端；本次操作只同步本地代码。
7. 最后汇报当前分支、远端主分支、同步前后的 commit、冲突文件、解决方式、验证结果、当前 Git 状态，并明确说明本次未推送远端。`);

      setToast({
        message: `已向当前 Agent 发送同步主分支指令：${currentBranch}`,
        variant: "success",
      });
    } catch (cause) {
      setToast({ message: errorMessage(cause), variant: "error" });
    } finally {
      setSendingMainSyncPrompt(false);
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
        commandButton: {
          marginTop: 4,
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
      {editingMrUrl ? (
        <View style={styles.infoRow}>
          <Text style={styles.fieldLabel}>MR 链接：</Text>
          <TextInput
            accessibilityLabel="当前 Agent 绑定的 MR 链接"
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            keyboardType="url"
            onChangeText={setDraftMrUrl}
            placeholder="请输入 MR 链接"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={styles.branchInput}
            value={draftMrUrl}
          />
          <Pressable
            accessibilityLabel="保存 MR 链接"
            accessibilityRole="button"
            disabled={!draftMrUrl.trim() || !gitBranch.trim() || savingMrUrl}
            onPress={() => void handleSaveMrUrl()}
            style={({ pressed }) => [
              styles.iconButton,
              pressed && styles.pressed,
              (!draftMrUrl.trim() || !gitBranch.trim() || savingMrUrl) && styles.disabled,
            ]}
          >
            <Text accessible={false} style={[styles.iconGlyph, styles.saveGlyph]}>
              ✓
            </Text>
          </Pressable>
          <Pressable
            accessibilityLabel="取消编辑 MR 链接"
            accessibilityRole="button"
            disabled={savingMrUrl}
            onPress={handleCancelEditingMrUrl}
            style={({ pressed }) => [
              styles.iconButton,
              pressed && styles.pressed,
              savingMrUrl && styles.disabled,
            ]}
          >
            <Text accessible={false} style={[styles.iconGlyph, styles.cancelGlyph]}>
              ×
            </Text>
          </Pressable>
        </View>
      ) : (
        <Pressable
          accessibilityLabel="编辑当前 Agent 绑定的 MR 链接"
          accessibilityRole="button"
          disabled={branchLoading}
          onPress={handleStartEditingMrUrl}
          style={({ pressed }) => [styles.infoRow, pressed && styles.pressed]}
        >
          <Text style={styles.fieldLabel}>MR 链接：</Text>
          <Text numberOfLines={1} style={styles.infoText}>
            {branchLoading ? "读取中…" : mrUrl}
          </Text>
        </Pressable>
      )}
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
      <Button
        accessibilityLabel="向当前 Agent 发送同步主分支最新代码的指令"
        disabled={branchLoading || !gitBranch.trim()}
        label="同步主分支"
        loading={sendingMainSyncPrompt}
        loadingLabel="正在发送指令…"
        onPress={() => void handleSendMainSyncPrompt()}
        style={styles.commandButton}
        theme={theme}
      />
      <Button
        accessibilityLabel="向当前 Agent 发送同步 MR 目标分支并解决冲突的指令"
        disabled={
          branchLoading || !gitBranch.trim() || !mrUrl.trim() || mrUrl.trim() === DEFAULT_MR_URL
        }
        label="同步 MR 目标分支"
        loading={sendingMrSyncPrompt}
        loadingLabel="正在发送指令…"
        onPress={() => void handleSendMrSyncPrompt()}
        style={styles.commandButton}
        theme={theme}
      />
      <Button
        accessibilityLabel="创建 Agent 提交并推送当前代码"
        disabled={branchLoading || !gitBranch.trim() || !currentAgentConfig}
        label="提交并推送当前代码"
        loading={creatingPushAgent}
        loadingLabel="正在创建 Agent…"
        onPress={() => void handleCreatePushAgent()}
        style={styles.commandButton}
        theme={theme}
      />
      <Button
        accessibilityLabel="创建 GPT 管理 Agent 编排评审当前 MR 并生成飞书文档"
        disabled={
          branchLoading || !gitBranch.trim() || !mrUrl.trim() || mrUrl.trim() === DEFAULT_MR_URL
        }
        label="评审当前 MR"
        loading={creatingReviewManagerAgent}
        loadingLabel="正在创建管理 Agent…"
        onPress={() => void handleCreateReviewManagerAgent()}
        style={styles.commandButton}
        theme={theme}
      />
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
