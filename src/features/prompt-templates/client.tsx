import { type PluginWorkspacePanelProps, useRpc } from "@getpaseo/plugin";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Clipboard,
  Easing,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Button, Card, List, Modal, Searchbar } from "../../components";
import {
  createPromptTemplate,
  deletePromptTemplate,
  getPromptTemplate,
  listPromptTemplates,
  updatePromptTemplate,
  type PromptSummary,
  type PromptTemplate,
} from "./contract";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请稍后重试";
}

function sortByUpdatedAt(items: PromptSummary[]) {
  return [...items].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

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

export function PromptTemplatesPanel({ theme, layout }: PluginWorkspacePanelProps) {
  const listTemplates = useRpc(listPromptTemplates);
  const loadTemplate = useRpc(getPromptTemplate);
  const createTemplate = useRpc(createPromptTemplate);
  const updateTemplate = useRpc(updatePromptTemplate);
  const deleteTemplate = useRpc(deletePromptTemplate);

  const [items, setItems] = useState<PromptSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<PromptTemplate | null>(null);
  const [detailClosing, setDetailClosing] = useState(false);
  const [detailWidth, setDetailWidth] = useState(0);
  const [search, setSearch] = useState("");
  const [draftTitle, setDraftTitle] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PromptSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const detailProgress = useRef(new Animated.Value(0)).current;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listTemplates({});
      setItems(result.items);
      setSelectedId((currentId) => {
        return currentId && result.items.some((item) => item.id === currentId) ? currentId : null;
      });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [listTemplates]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let active = true;

    if (!selectedId) {
      setSelected(null);
      setDraftTitle("");
      setDraftContent("");
      setDetailLoading(false);
      return () => {
        active = false;
      };
    }

    setDetailLoading(true);
    setError(null);
    void loadTemplate({ id: selectedId })
      .then((template) => {
        if (!active) return;
        setSelected(template);
        setDraftTitle(template.title);
        setDraftContent(template.content);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });

    return () => {
      active = false;
    };
  }, [loadTemplate, selectedId]);

  useEffect(() => {
    if (!selectedId || detailWidth <= 0) {
      detailProgress.setValue(0);
      return;
    }

    if (!detailClosing) detailProgress.setValue(0);
    const animation = Animated.timing(detailProgress, {
      toValue: detailClosing ? 0 : 1,
      duration: 220,
      easing: detailClosing ? Easing.in(Easing.cubic) : Easing.out(Easing.cubic),
      useNativeDriver: false,
    });

    animation.start(({ finished }) => {
      if (!finished || !detailClosing) return;
      setSelectedId(null);
      setDetailClosing(false);
      setSelected(null);
      setError(null);
    });
    return () => animation.stop();
  }, [detailClosing, detailProgress, detailWidth, selectedId]);

  const visibleItems = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return items;
    return items.filter((item) =>
      `${item.title} ${item.preview}`.toLocaleLowerCase().includes(query),
    );
  }, [items, search]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        screen: {
          flex: 1,
          padding: layout.compact ? 12 : 20,
          backgroundColor: theme.colors.surface0,
        },
        glyph: {
          color: theme.colors.foregroundMuted,
          fontSize: 20,
          lineHeight: 22,
        },
        actionGlyph: {
          color: theme.colors.foregroundMuted,
          fontSize: 18,
          lineHeight: 20,
        },
        deleteGlyph: {
          color: theme.colors.statusDanger,
        },
        listPane: {
          flex: 1,
          minHeight: 0,
        },
        listHeader: {
          paddingHorizontal: 12,
          paddingVertical: 10,
          color: theme.colors.foregroundMuted,
          fontSize: 12,
        },
        newButton: {
          alignSelf: "stretch",
          minHeight: 44,
          paddingHorizontal: 12,
          justifyContent: "flex-start",
          borderWidth: 0,
          borderTopWidth: 1,
          borderBottomWidth: 1,
          borderColor: theme.colors.foregroundMuted,
          borderRadius: 0,
        },
        newButtonLabel: {
          color: theme.colors.foreground,
          fontWeight: "600",
        },
        listScroll: {
          flex: 1,
        },
        panelStage: {
          flex: 1,
          minHeight: 0,
          position: "relative",
          overflow: "hidden",
          gap: 12,
        },
        listLayer: {
          flex: 1,
          minHeight: 0,
        },
        mutedText: {
          padding: 12,
          color: theme.colors.foregroundMuted,
        },
        detailMotion: {
          flex: 1,
          minHeight: 0,
        },
        detailLayer: {
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          left: 0,
        },
        detailPane: {
          flex: 1,
          minHeight: 0,
          gap: 12,
          padding: 14,
        },
        detailHeader: {
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
        },
        backButton: {
          minWidth: 32,
          minHeight: 32,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 6,
        },
        backGlyph: {
          color: theme.colors.foregroundMuted,
          fontSize: 24,
          lineHeight: 26,
        },
        detailHeading: {
          color: theme.colors.foreground,
          fontSize: layout.compact ? 16 : 18,
          fontWeight: "600",
        },
        titleInput: {
          minHeight: 42,
          paddingHorizontal: 10,
          paddingVertical: 8,
          color: theme.colors.foreground,
          borderColor: theme.colors.foregroundMuted,
          borderWidth: 1,
          borderRadius: 6,
        },
        contentInput: {
          flex: 1,
          minHeight: 180,
          padding: 10,
          color: theme.colors.foreground,
          textAlignVertical: "top",
          borderWidth: 1,
          borderColor: theme.colors.foregroundMuted,
          borderRadius: 6,
        },
        detailEmpty: {
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          color: theme.colors.foregroundMuted,
          textAlign: "center",
        },
        footer: {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 10,
        },
        saveButton: {
          minHeight: 38,
          paddingHorizontal: 16,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: theme.colors.accent,
          borderRadius: 6,
        },
        saveLabel: {
          color: theme.colors.accentForeground,
          fontWeight: "600",
        },
        error: {
          color: theme.colors.statusDanger,
        },
        notice: {
          color: theme.colors.foregroundMuted,
        },
        deleteMessage: {
          color: theme.colors.foreground,
          lineHeight: 22,
        },
      }),
    [theme, layout.compact],
  );

  async function handleCreate() {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const created = await createTemplate({ title: "", content: "" });
      setItems((current) => sortByUpdatedAt([created, ...current]));
      setSelectedId(created.id);
      setSelected(created);
      setDraftTitle(created.title);
      setDraftContent(created.content);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  async function handleSave() {
    if (!selectedId) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await updateTemplate({
        id: selectedId,
        title: draftTitle,
        content: draftContent,
      });
      setSelected(saved);
      setItems((current) =>
        sortByUpdatedAt(
          current.map((item) =>
            item.id === saved.id
              ? {
                  id: saved.id,
                  title: saved.title,
                  preview: saved.preview,
                  updatedAt: saved.updatedAt,
                }
              : item,
          ),
        ),
      );
      setDraftTitle(saved.title);
      setDraftContent(saved.content);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  function handleRequestDelete(item: PromptSummary) {
    setDeleteTarget(item);
    setError(null);
    setNotice(null);
  }

  function handleCancelDelete() {
    if (deleting) return;
    setDeleteTarget(null);
  }

  async function handleConfirmDelete() {
    const target = deleteTarget;
    if (!target || deleting) return;

    setDeleting(true);
    setError(null);
    setNotice(null);
    try {
      await deleteTemplate({ id: target.id });
      setItems((current) => current.filter((item) => item.id !== target.id));
      setDeleteTarget(null);
      setNotice(`已删除提示词：${target.title || "未命名提示词"}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setDeleting(false);
    }
  }

  async function handleCopy(item: PromptSummary) {
    setError(null);
    setNotice(null);
    try {
      const template = await loadTemplate({ id: item.id });
      await copyToClipboard(template.content);
      setNotice(`已复制提示词：${template.title || "未命名提示词"}`);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  function handleBackToList() {
    if (!selectedId || detailClosing) return;

    setDetailClosing(true);
  }

  const renderList = () => (
    <Card theme={theme} style={styles.listPane}>
      <Text style={styles.listHeader}>提示词模板</Text>
      <Button
        accessibilityLabel="新建提示词"
        disabled={saving}
        icon={<Text style={styles.glyph}>＋</Text>}
        label="新建提示词"
        onPress={() => void handleCreate()}
        theme={theme}
        variant="ghost"
        style={styles.newButton}
        labelStyle={styles.newButtonLabel}
      />
      {loading ? (
        <Text style={styles.mutedText}>正在加载…</Text>
      ) : (
        <ScrollView style={styles.listScroll}>
          {visibleItems.length === 0 ? (
            <Text style={styles.mutedText}>暂无提示词</Text>
          ) : (
            visibleItems.map((item) => {
              return (
                <List.Item
                  key={item.id}
                  theme={theme}
                  title={item.title}
                  description={item.preview}
                  accessibilityLabel={`打开提示词：${item.title}`}
                  onPress={() => setSelectedId(item.id)}
                  actions={[
                    {
                      id: "delete",
                      accessibilityLabel: `删除提示词：${item.title}`,
                      icon: (
                        <Text accessible={false} style={[styles.actionGlyph, styles.deleteGlyph]}>
                          ⌫
                        </Text>
                      ),
                      onPress: () => handleRequestDelete(item),
                    },
                    {
                      id: "copy",
                      accessibilityLabel: `复制提示词：${item.title}`,
                      icon: (
                        <Text accessible={false} style={styles.actionGlyph}>
                          ⧉
                        </Text>
                      ),
                      onPress: () => void handleCopy(item),
                    },
                  ]}
                />
              );
            })
          )}
        </ScrollView>
      )}
    </Card>
  );

  const renderDetail = () => (
    <Animated.View
      onLayout={({ nativeEvent }) => {
        const width = nativeEvent.layout.width;
        if (width !== detailWidth) setDetailWidth(width);
      }}
      style={[
        styles.detailMotion,
        styles.detailLayer,
        {
          transform: [
            {
              translateX: detailProgress.interpolate({
                inputRange: [0, 1],
                outputRange: [detailWidth, 0],
              }),
            },
          ],
        },
      ]}
    >
      <Card theme={theme} style={styles.detailPane}>
        <View style={styles.detailHeader}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="返回提示词列表"
            onPress={handleBackToList}
            style={styles.backButton}
          >
            <Text style={styles.backGlyph}>‹</Text>
          </Pressable>
          <Text style={styles.detailHeading}>提示词详情</Text>
        </View>

        {detailLoading ? (
          <Text style={styles.mutedText}>正在加载…</Text>
        ) : selected ? (
          <>
            <TextInput
              accessibilityLabel="提示词名称"
              value={draftTitle}
              onChangeText={setDraftTitle}
              placeholder="提示词名称"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.titleInput}
            />
            <TextInput
              accessibilityLabel="提示词内容"
              value={draftContent}
              onChangeText={setDraftContent}
              placeholder="输入提示词内容"
              placeholderTextColor={theme.colors.foregroundMuted}
              multiline
              textAlignVertical="top"
              style={styles.contentInput}
            />
            <View style={styles.footer}>
              <Button
                accessibilityLabel="保存提示词"
                loading={saving}
                loadingLabel="保存中…"
                label="保存"
                onPress={() => void handleSave()}
                theme={theme}
                style={styles.saveButton}
                labelStyle={styles.saveLabel}
              />
            </View>
          </>
        ) : (
          <Text style={styles.detailEmpty}>提示词加载失败，请返回列表后重试。</Text>
        )}
      </Card>
    </Animated.View>
  );

  return (
    <View style={styles.screen}>
      <View style={styles.panelStage}>
        {!selectedId || detailClosing ? (
          <>
            <Searchbar
              accessibilityLabel="搜索提示词"
              theme={theme}
              value={search}
              onChangeText={setSearch}
              placeholder="搜索提示词"
            />
            <View pointerEvents={detailClosing ? "none" : "auto"} style={styles.listLayer}>
              {renderList()}
            </View>
          </>
        ) : null}
        {selectedId ? renderDetail() : null}
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      <Modal
        theme={theme}
        visible={deleteTarget !== null}
        title="删除提示词"
        dismissable={!deleting}
        onRequestClose={handleCancelDelete}
        footer={
          <>
            <Button
              accessibilityLabel="取消删除"
              disabled={deleting}
              label="取消"
              onPress={handleCancelDelete}
              theme={theme}
              variant="secondary"
            />
            <Button
              accessibilityLabel="确认删除提示词"
              label="确认删除"
              loading={deleting}
              loadingLabel="删除中…"
              onPress={() => void handleConfirmDelete()}
              theme={theme}
              variant="danger"
            />
          </>
        }
      >
        <Text style={styles.deleteMessage}>
          确定要删除“{deleteTarget?.title || "未命名提示词"}”吗？删除后无法恢复。
        </Text>
      </Modal>
    </View>
  );
}
