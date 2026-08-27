import type { PluginAgentPanelProps } from "@getpaseo/plugin";
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Card } from "../../components";

export function TaskPanel({ theme, layout }: PluginAgentPanelProps) {
  const [loopEnabled, setLoopEnabled] = useState(false);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        screen: {
          flex: 1,
          gap: layout.compact ? 16 : 20,
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
          gap: 10,
        },
        sectionTitle: {
          color: theme.colors.foregroundMuted,
          fontSize: 12,
          fontWeight: "600",
          lineHeight: 18,
        },
        emptyCard: {
          flex: 1,
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
        },
        emptyDescription: {
          color: theme.colors.foregroundMuted,
          fontSize: 13,
          lineHeight: 19,
          textAlign: "center",
        },
      }),
    [layout.compact, theme],
  );

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.title}>
          任务面板
        </Text>
        <Pressable
          accessibilityLabel="任务循环"
          accessibilityRole="switch"
          accessibilityState={{ checked: loopEnabled }}
          onPress={() => setLoopEnabled((enabled) => !enabled)}
          style={({ pressed }) => [styles.toggle, pressed && styles.pressed]}
        >
          <View style={[styles.toggleTrack, loopEnabled && styles.toggleTrackEnabled]}>
            <View style={[styles.toggleThumb, loopEnabled && styles.toggleThumbEnabled]} />
          </View>
          <Text style={[styles.toggleLabel, loopEnabled && styles.toggleLabelEnabled]}>
            {loopEnabled ? "循环已开启" : "开启循环"}
          </Text>
        </Pressable>
      </View>

      <View style={styles.listSection}>
        <Text style={styles.sectionTitle}>BEADS 任务</Text>
        <Card theme={theme} style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>暂无任务</Text>
          <Text style={styles.emptyDescription}>当前没有可展示的 Beads 任务</Text>
        </Card>
      </View>
    </View>
  );
}
