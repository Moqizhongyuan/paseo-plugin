import {
  type PluginHostProps,
  type PluginTheme,
  useAgent,
  usePaseo,
  useRpc,
} from "@getpaseo/plugin";
import type {
  PaseoProviderModesResult,
  PaseoProviderModelsResult,
  PaseoProviderSnapshotResult,
} from "@getpaseo/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Button, Modal } from "../../components";
import {
  getExecutionAgentConfig,
  saveExecutionAgentConfig,
  type ExecutionAgentConfig,
} from "./shared";

type AgentConfigPanelProps = Pick<PluginHostProps, "theme" | "layout"> & {
  agentId: string;
  cwd: string | null;
};

type ProviderEntry = PaseoProviderSnapshotResult["entries"][number];
type ProviderModel = NonNullable<ProviderEntry["models"]>[number];
type ProviderMode = NonNullable<ProviderEntry["modes"]>[number];
type PickerKind = "model" | "mode" | "thinking";
type ProviderParts = {
  entry: ProviderEntry | null;
  modelId: string | null;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请稍后重试";
}

function composeProviderModel(provider: string, model: string | null) {
  const normalizedProvider = provider.trim();
  const normalizedModel = model?.trim() ?? "";
  if (!normalizedModel || normalizedProvider.endsWith(`/${normalizedModel}`)) {
    return normalizedProvider;
  }
  return `${normalizedProvider}/${normalizedModel}`;
}

function providerParts(selection: string, entries: ProviderEntry[]): ProviderParts {
  const normalizedSelection = selection.trim();
  const matchingEntry = [...entries]
    .sort((left, right) => right.provider.length - left.provider.length)
    .find(
      (entry) =>
        normalizedSelection === entry.provider ||
        normalizedSelection.startsWith(`${entry.provider}/`),
    );
  if (matchingEntry) {
    const modelId = normalizedSelection.slice(matchingEntry.provider.length + 1).trim();
    return { entry: matchingEntry, modelId: modelId || null };
  }

  const separator = normalizedSelection.indexOf("/");
  if (separator < 0) return { entry: null, modelId: null };
  return {
    entry: null,
    modelId: normalizedSelection.slice(separator + 1).trim() || null,
  };
}

function modelForId(models: ProviderModel[], modelId: string | null) {
  if (!modelId) return null;
  return (
    models.find(
      (model) => model.id === modelId || model.aliases?.some((alias) => alias === modelId),
    ) ?? null
  );
}

function defaultThinkingOptionId(model: ProviderModel | null) {
  if (!model) return null;
  return (
    model.defaultThinkingOptionId ??
    model.thinkingOptions?.find((option) => option.isDefault)?.id ??
    model.thinkingOptions?.[0]?.id ??
    null
  );
}

function defaultModeId(entry: ProviderEntry | null, modes: ProviderMode[]) {
  if (entry?.defaultModeId !== undefined) return entry.defaultModeId;
  return modes[0]?.id ?? null;
}

function providerLabel(entry: ProviderEntry | null, provider: string) {
  return entry?.label?.trim() || provider;
}

function modelLabel(model: ProviderModel | null, modelId: string | null) {
  return model?.label?.trim() || modelId || "未选择模型";
}

function ChoiceRow({
  theme,
  label,
  description,
  selected,
  onPress,
}: {
  theme: PluginTheme;
  label: string;
  description?: string;
  selected: boolean;
  onPress: () => void;
}) {
  const styles = useMemo(
    () =>
      StyleSheet.create({
        row: {
          minHeight: 48,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingHorizontal: 10,
          paddingVertical: 8,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: selected ? theme.colors.accent : theme.colors.foregroundMuted,
          backgroundColor: selected ? `${theme.colors.accent}18` : "transparent",
        },
        content: {
          flex: 1,
          minWidth: 0,
          gap: 2,
        },
        label: {
          color: theme.colors.foreground,
          fontSize: 13,
          fontWeight: selected ? "600" : "400",
        },
        description: {
          color: theme.colors.foregroundMuted,
          fontSize: 11,
          lineHeight: 15,
        },
        check: {
          color: theme.colors.accent,
          fontSize: 16,
          fontWeight: "700",
        },
      }),
    [selected, theme],
  );

  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.75 }]}
    >
      <View style={styles.content}>
        <Text numberOfLines={1} style={styles.label}>
          {label}
        </Text>
        {description ? (
          <Text numberOfLines={2} style={styles.description}>
            {description}
          </Text>
        ) : null}
      </View>
      {selected ? (
        <Text accessible={false} style={styles.check}>
          ✓
        </Text>
      ) : null}
    </Pressable>
  );
}

export function AgentConfigPanel({ theme, layout, agentId, cwd }: AgentConfigPanelProps) {
  const paseo = usePaseo();
  const currentAgent = useAgent(
    agentId,
    ({ provider, model, currentModeId, thinkingOptionId }) => ({
      provider,
      model,
      currentModeId,
      thinkingOptionId,
    }),
  );
  const loadConfig = useRpc(getExecutionAgentConfig);
  const persistConfig = useRpc(saveExecutionAgentConfig);
  const [config, setConfig] = useState<ExecutionAgentConfig | null>(null);
  const [savedConfig, setSavedConfig] = useState<ExecutionAgentConfig | null>(null);
  const [hasPersistedConfig, setHasPersistedConfig] = useState(false);
  const [configLoading, setConfigLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [providerEntries, setProviderEntries] = useState<ProviderEntry[]>([]);
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, ProviderModel[]>>({});
  const [modesByProvider, setModesByProvider] = useState<Record<string, ProviderMode[]>>({});
  const [providerLoading, setProviderLoading] = useState(true);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [picker, setPicker] = useState<PickerKind | null>(null);
  const [pickerLoading, setPickerLoading] = useState(false);
  const loadingModels = useRef(new Map<string, Promise<void>>());
  const loadingModes = useRef(new Map<string, Promise<void>>());

  const inheritedConfig = useMemo<ExecutionAgentConfig | null>(() => {
    if (!currentAgent?.provider?.trim()) return null;
    return {
      provider: composeProviderModel(currentAgent.provider, currentAgent.model),
      modeId: currentAgent.currentModeId,
      thinkingOptionId: currentAgent.thinkingOptionId,
    };
  }, [currentAgent]);

  useEffect(() => {
    let active = true;
    setConfigLoading(true);
    setConfigError(null);
    setSavedConfig(null);
    setHasPersistedConfig(false);
    setConfig(inheritedConfig);

    if (!inheritedConfig) {
      setConfigLoading(false);
      return () => {
        active = false;
      };
    }

    const fallback = inheritedConfig;
    void loadConfig({ agentId })
      .then((result) => {
        if (!active) return;
        const next = result.config ?? fallback;
        setConfig(next);
        // The inherited configuration is the clean baseline until the user
        // changes a field. It is not written to disk unless the user presses
        // Save, but it should not look like an unsaved edit on first render.
        setSavedConfig(next);
        setHasPersistedConfig(result.config !== null);
      })
      .catch((cause) => {
        if (!active) return;
        setSavedConfig(fallback);
        setConfigError(errorMessage(cause));
      })
      .finally(() => {
        if (active) setConfigLoading(false);
      });

    return () => {
      active = false;
    };
  }, [agentId, inheritedConfig, loadConfig]);

  useEffect(() => {
    let active = true;
    setProviderLoading(true);
    setProviderError(null);
    setProviderEntries([]);
    setModelsByProvider({});
    setModesByProvider({});
    loadingModels.current.clear();
    loadingModes.current.clear();

    const options = cwd ? { cwd } : undefined;
    function applyProviderSnapshot(snapshot: PaseoProviderSnapshotResult) {
      const entries: ProviderEntry[] = snapshot.entries ?? [];
      setProviderEntries(entries);
      setModelsByProvider(
        Object.fromEntries(entries.map((entry) => [entry.provider, entry.models ?? []])),
      );
      setModesByProvider(
        Object.fromEntries(entries.map((entry) => [entry.provider, entry.modes ?? []])),
      );
      return entries;
    }

    async function loadProviders() {
      try {
        const snapshot = await paseo.providers.waitForReady({
          ...(options ?? {}),
          timeoutMs: 10_000,
        });
        if (!active) return;
        applyProviderSnapshot(snapshot);
      } catch (waitCause) {
        // A provider may already have a usable cached snapshot even when lazy
        // discovery times out. Keep the panel usable in that case.
        try {
          const snapshot = await paseo.providers.snapshot(options);
          if (!active) return;
          const entries = applyProviderSnapshot(snapshot);
          if (entries.length === 0) setProviderError(errorMessage(waitCause));
        } catch (snapshotCause) {
          if (active) setProviderError(errorMessage(snapshotCause));
        }
      } finally {
        if (active) setProviderLoading(false);
      }
    }

    void loadProviders();
    return () => {
      active = false;
    };
  }, [cwd, paseo]);

  const selectableEntries = useMemo(
    () =>
      providerEntries.filter((entry) => entry.enabled !== false && entry.status !== "unavailable"),
    [providerEntries],
  );

  const currentProviderParts = useMemo(
    () => providerParts(config?.provider ?? "", providerEntries),
    [config?.provider, providerEntries],
  );
  const currentProvider = currentProviderParts.entry?.provider ?? "";
  const currentModels = currentProvider
    ? (modelsByProvider[currentProvider] ?? currentProviderParts.entry?.models ?? [])
    : [];
  const currentModel = modelForId(currentModels, currentProviderParts.modelId);
  const currentModes = currentProvider
    ? (modesByProvider[currentProvider] ?? currentProviderParts.entry?.modes ?? [])
    : [];
  const currentThinkingOptions = currentModel?.thinkingOptions ?? [];

  const loadModels = useCallback(
    (provider: string) => {
      const cached = modelsByProvider[provider];
      if (cached && cached.length > 0) return Promise.resolve();
      const running = loadingModels.current.get(provider);
      if (running) return running;

      const request = paseo.providers
        .listModels(provider, cwd ? { cwd } : undefined)
        .then((result: PaseoProviderModelsResult) => {
          if (result.error) throw new Error(result.error);
          setModelsByProvider((current) => ({
            ...current,
            [provider]: result.models ?? [],
          }));
        })
        .finally(() => {
          loadingModels.current.delete(provider);
        });
      loadingModels.current.set(provider, request);
      return request;
    },
    [cwd, modelsByProvider, paseo],
  );

  const loadModes = useCallback(
    (provider: string) => {
      const cached = modesByProvider[provider];
      if (cached && cached.length > 0) return Promise.resolve();
      const running = loadingModes.current.get(provider);
      if (running) return running;

      const request = paseo.providers
        .listModes(provider, cwd ? { cwd } : undefined)
        .then((result: PaseoProviderModesResult) => {
          if (result.error) throw new Error(result.error);
          setModesByProvider((current) => ({
            ...current,
            [provider]: result.modes ?? [],
          }));
        })
        .finally(() => {
          loadingModes.current.delete(provider);
        });
      loadingModes.current.set(provider, request);
      return request;
    },
    [cwd, modesByProvider, paseo],
  );

  async function openPicker(kind: PickerKind) {
    if (!config || configLoading) return;
    setPicker(kind);
    setPickerLoading(true);
    try {
      if (kind === "model") {
        await Promise.all(
          selectableEntries
            .filter((entry) => !(modelsByProvider[entry.provider]?.length || entry.models?.length))
            .map((entry) => loadModels(entry.provider)),
        );
      } else if (currentProvider) {
        await loadModes(currentProvider);
      }
    } catch (cause) {
      setConfigError(errorMessage(cause));
    } finally {
      setPickerLoading(false);
    }
  }

  function updateConfig(next: Partial<ExecutionAgentConfig>) {
    setConfig((current) => (current ? { ...current, ...next } : current));
    setConfigError(null);
  }

  function handleSelectModel(entry: ProviderEntry, model: ProviderModel) {
    const provider = composeProviderModel(entry.provider, model.id);
    const modes = modesByProvider[entry.provider] ?? entry.modes ?? [];
    updateConfig({
      provider,
      modeId: defaultModeId(entry, modes),
      thinkingOptionId: defaultThinkingOptionId(model),
    });
    setPicker(null);
  }

  function handleSelectMode(modeId: string | null) {
    updateConfig({ modeId });
    setPicker(null);
  }

  function handleSelectThinking(thinkingOptionId: string | null) {
    updateConfig({ thinkingOptionId });
    setPicker(null);
  }

  async function handleSave() {
    if (!config || saving || !config.provider.trim()) return;
    setSaving(true);
    setConfigError(null);
    try {
      const saved = await persistConfig({
        agentId,
        provider: config.provider,
        modeId: config.modeId,
        thinkingOptionId: config.thinkingOptionId,
      });
      setConfig(saved);
      setSavedConfig(saved);
      setHasPersistedConfig(true);
    } catch (cause) {
      setConfigError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setConfig(savedConfig ?? inheritedConfig);
    setConfigError(null);
  }

  const dirty =
    config !== null &&
    (savedConfig === null ||
      config.provider !== savedConfig.provider ||
      config.modeId !== savedConfig.modeId ||
      config.thinkingOptionId !== savedConfig.thinkingOptionId);
  const selectedProviderLabel = currentProviderParts.entry
    ? providerLabel(currentProviderParts.entry, currentProvider)
    : currentProvider || config?.provider || "未设置";
  const selectedModelLabel = modelLabel(currentModel, currentProviderParts.modelId);
  const selectedMode = currentModes.find((mode) => mode.id === config?.modeId) ?? null;
  const selectedThinking =
    currentThinkingOptions.find((option) => option.id === config?.thinkingOptionId) ?? null;

  const styles = useMemo(
    () =>
      StyleSheet.create({
        section: {
          gap: 6,
        },
        titleRow: {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        },
        title: {
          color: theme.colors.foreground,
          fontSize: layout.compact ? 14 : 16,
          fontWeight: "600",
        },
        status: {
          flexShrink: 1,
          color: theme.colors.foregroundMuted,
          fontSize: 11,
          textAlign: "right",
        },
        field: {
          minHeight: 42,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 10,
          paddingVertical: 7,
          borderWidth: 1,
          borderColor: theme.colors.foregroundMuted,
          borderRadius: 8,
        },
        fieldDisabled: {
          opacity: 0.55,
        },
        fieldLabel: {
          width: layout.compact ? 108 : 128,
          flexShrink: 0,
          color: theme.colors.foregroundMuted,
          fontSize: layout.compact ? 12 : 13,
        },
        fieldContent: {
          flex: 1,
          minWidth: 0,
          gap: 1,
        },
        fieldValue: {
          color: theme.colors.foreground,
          fontSize: layout.compact ? 12 : 13,
          fontWeight: "500",
        },
        fieldId: {
          color: theme.colors.foregroundMuted,
          fontSize: 10,
          lineHeight: 14,
        },
        chevron: {
          color: theme.colors.foregroundMuted,
          fontSize: 16,
        },
        hint: {
          color: theme.colors.foregroundMuted,
          fontSize: 11,
          lineHeight: 16,
        },
        error: {
          color: theme.colors.statusDanger,
          fontSize: 11,
          lineHeight: 16,
        },
        actions: {
          flexDirection: "row",
          justifyContent: "flex-end",
          gap: 8,
          marginTop: 2,
        },
        modalGroup: {
          gap: 6,
        },
        modalGroupTitle: {
          color: theme.colors.foregroundMuted,
          fontSize: 12,
          fontWeight: "600",
          marginTop: 4,
        },
        modalHint: {
          color: theme.colors.foregroundMuted,
          fontSize: 12,
          lineHeight: 18,
        },
      }),
    [layout.compact, theme],
  );

  function renderModelPicker() {
    if (pickerLoading || providerLoading) {
      return <Text style={styles.modalHint}>正在读取 Paseo 可用模型…</Text>;
    }
    if (selectableEntries.length === 0) {
      return (
        <Text style={styles.modalHint}>
          {providerError ?? "没有发现可用 provider。请先在 Paseo 中完成 provider 配置。"}
        </Text>
      );
    }
    return selectableEntries.map((entry) => {
      const models = modelsByProvider[entry.provider] ?? entry.models ?? [];
      return (
        <View key={entry.provider} style={styles.modalGroup}>
          <Text style={styles.modalGroupTitle}>{providerLabel(entry, entry.provider)}</Text>
          {models.length > 0 ? (
            models
              .filter((model) => model.isSelectable !== false)
              .map((model) => {
                const value = composeProviderModel(entry.provider, model.id);
                return (
                  <ChoiceRow
                    key={value}
                    description={model.description}
                    label={model.label}
                    onPress={() => handleSelectModel(entry, model)}
                    selected={config?.provider === value}
                    theme={theme}
                  />
                );
              })
          ) : (
            <Text style={styles.modalHint}>暂无可选模型</Text>
          )}
        </View>
      );
    });
  }

  function renderModePicker() {
    if (pickerLoading) return <Text style={styles.modalHint}>正在读取 mode…</Text>;
    const options = currentModes;
    return (
      <View style={styles.modalGroup}>
        <ChoiceRow
          label="默认"
          onPress={() => handleSelectMode(null)}
          selected={!config?.modeId}
          theme={theme}
        />
        {options.map((mode) => (
          <ChoiceRow
            key={mode.id}
            description={mode.description}
            label={mode.label}
            onPress={() => handleSelectMode(mode.id)}
            selected={config?.modeId === mode.id}
            theme={theme}
          />
        ))}
        {config?.modeId && !options.some((mode) => mode.id === config.modeId) ? (
          <ChoiceRow
            description="当前保存的 mode 不在最新 provider 列表中"
            label={config.modeId}
            onPress={() => handleSelectMode(config.modeId)}
            selected
            theme={theme}
          />
        ) : null}
      </View>
    );
  }

  function renderThinkingPicker() {
    const options = currentThinkingOptions;
    if (pickerLoading) return <Text style={styles.modalHint}>正在读取 thinking option…</Text>;
    return (
      <View style={styles.modalGroup}>
        <ChoiceRow
          label="默认"
          onPress={() => handleSelectThinking(null)}
          selected={!config?.thinkingOptionId}
          theme={theme}
        />
        {options.map((option) => (
          <ChoiceRow
            key={option.id}
            description={option.description}
            label={option.label}
            onPress={() => handleSelectThinking(option.id)}
            selected={config?.thinkingOptionId === option.id}
            theme={theme}
          />
        ))}
        {config?.thinkingOptionId &&
        !options.some((option) => option.id === config.thinkingOptionId) ? (
          <ChoiceRow
            description="当前保存的 thinking option 不在最新模型列表中"
            label={config.thinkingOptionId}
            onPress={() => handleSelectThinking(config.thinkingOptionId)}
            selected
            theme={theme}
          />
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.section}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>执行 Agent 配置：</Text>
        <Text style={styles.status}>
          {configLoading
            ? "正在读取…"
            : saving
              ? "正在保存…"
              : dirty
                ? "有未保存修改"
                : hasPersistedConfig
                  ? "已保存"
                  : "跟随当前 Agent"}
        </Text>
      </View>
      <Pressable
        accessibilityLabel="选择执行 Agent 的 provider 和 model"
        accessibilityRole="button"
        disabled={configLoading || !config}
        onPress={() => void openPicker("model")}
        style={({ pressed }) => [
          styles.field,
          pressed && { opacity: 0.75 },
          !config && styles.fieldDisabled,
        ]}
      >
        <Text style={styles.fieldLabel}>provider：</Text>
        <View style={styles.fieldContent}>
          <Text numberOfLines={1} style={styles.fieldValue}>
            {selectedProviderLabel} · {selectedModelLabel}
          </Text>
          <Text numberOfLines={1} style={styles.fieldId}>
            {config?.provider || "未设置"}
          </Text>
        </View>
        <Text accessible={false} style={styles.chevron}>
          ›
        </Text>
      </Pressable>
      <Pressable
        accessibilityLabel="选择执行 Agent 的 modeId"
        accessibilityRole="button"
        disabled={configLoading || !config || !currentProvider}
        onPress={() => void openPicker("mode")}
        style={({ pressed }) => [
          styles.field,
          pressed && { opacity: 0.75 },
          (!config || !currentProvider) && styles.fieldDisabled,
        ]}
      >
        <Text style={styles.fieldLabel}>modeId：</Text>
        <View style={styles.fieldContent}>
          <Text numberOfLines={1} style={styles.fieldValue}>
            {selectedMode?.label || config?.modeId || "默认"}
          </Text>
          {selectedMode ? (
            <Text numberOfLines={1} style={styles.fieldId}>
              {selectedMode.id}
            </Text>
          ) : null}
        </View>
        <Text accessible={false} style={styles.chevron}>
          ›
        </Text>
      </Pressable>
      <Pressable
        accessibilityLabel="选择执行 Agent 的 thinkingOptionId"
        accessibilityRole="button"
        disabled={configLoading || !config || !currentModel}
        onPress={() => void openPicker("thinking")}
        style={({ pressed }) => [
          styles.field,
          pressed && { opacity: 0.75 },
          (!config || !currentModel) && styles.fieldDisabled,
        ]}
      >
        <Text style={styles.fieldLabel}>thinkingOptionId：</Text>
        <View style={styles.fieldContent}>
          <Text numberOfLines={1} style={styles.fieldValue}>
            {selectedThinking?.label || config?.thinkingOptionId || "默认"}
          </Text>
          {selectedThinking ? (
            <Text numberOfLines={1} style={styles.fieldId}>
              {selectedThinking.id}
            </Text>
          ) : null}
        </View>
        <Text accessible={false} style={styles.chevron}>
          ›
        </Text>
      </Pressable>
      <Text style={styles.hint}>
        默认读取当前 Agent 配置；这里只保存选择，子 Agent 由父 Agent 控制执行。
      </Text>
      {configError ? <Text style={styles.error}>{configError}</Text> : null}
      {dirty ? (
        <View style={styles.actions}>
          <Button
            disabled={saving}
            label="取消"
            onPress={handleCancel}
            size="small"
            theme={theme}
            variant="ghost"
          />
          <Button
            disabled={saving || !config?.provider.trim()}
            label="保存配置"
            loading={saving}
            onPress={() => void handleSave()}
            size="small"
            theme={theme}
          />
        </View>
      ) : null}
      <Modal
        compact={layout.compact}
        onRequestClose={() => setPicker(null)}
        theme={theme}
        title={
          picker === "model"
            ? "选择 provider / model"
            : picker === "mode"
              ? "选择 mode"
              : "选择 thinking option"
        }
        visible={picker !== null}
      >
        {picker === "model"
          ? renderModelPicker()
          : picker === "mode"
            ? renderModePicker()
            : picker === "thinking"
              ? renderThinkingPicker()
              : null}
      </Modal>
    </View>
  );
}
