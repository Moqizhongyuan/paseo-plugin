import type { PluginTheme } from "@getpaseo/plugin";
import { type ReactNode, useMemo } from "react";
import {
  Modal as NativeModal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  type StyleProp,
  type ViewStyle,
  View,
} from "react-native";

export interface ModalProps {
  theme: PluginTheme;
  visible: boolean;
  onRequestClose: () => void;
  children: ReactNode;
  title?: string;
  footer?: ReactNode;
  dismissable?: boolean;
  compact?: boolean;
  width?: number;
  animationType?: "none" | "slide" | "fade";
  style?: StyleProp<ViewStyle>;
}

export function Modal({
  theme,
  visible,
  onRequestClose,
  children,
  title,
  footer,
  dismissable = true,
  compact = false,
  width,
  animationType = "fade",
  style,
}: ModalProps) {
  const styles = useMemo(
    () =>
      StyleSheet.create({
        overlay: {
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          padding: compact ? 12 : 20,
          backgroundColor: "rgba(0, 0, 0, 0.45)",
        },
        backdrop: {
          ...StyleSheet.absoluteFillObject,
        },
        card: {
          width: "100%",
          maxWidth: 520,
          maxHeight: "90%",
          gap: compact ? 10 : 12,
          padding: compact ? 14 : 20,
          backgroundColor: theme.colors.surface0,
          borderWidth: 1,
          borderColor: theme.colors.foregroundMuted,
          borderRadius: 12,
        },
        header: {
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          minHeight: 32,
        },
        title: {
          flex: 1,
          color: theme.colors.foreground,
          fontSize: compact ? 16 : 18,
          fontWeight: "600",
        },
        headerSpacer: {
          flex: 1,
        },
        closeButton: {
          minWidth: 32,
          minHeight: 32,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 6,
        },
        closeGlyph: {
          color: theme.colors.foregroundMuted,
          fontSize: 22,
          lineHeight: 24,
        },
        body: {
          flexShrink: 1,
        },
        bodyContent: {
          gap: compact ? 10 : 12,
        },
        footer: {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 8,
        },
      }),
    [compact, theme],
  );

  return (
    <NativeModal
      visible={visible}
      transparent
      animationType={animationType}
      onRequestClose={onRequestClose}
      accessibilityViewIsModal
    >
      <View style={styles.overlay}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="关闭弹窗"
          disabled={!dismissable}
          onPress={dismissable ? onRequestClose : undefined}
          style={styles.backdrop}
        />
        <View style={[styles.card, width ? { width } : null, style]}>
          {title || dismissable ? (
            <View style={styles.header}>
              {title ? (
                <Text style={styles.title}>{title}</Text>
              ) : (
                <View style={styles.headerSpacer} />
              )}
              {dismissable ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="关闭弹窗"
                  onPress={onRequestClose}
                  style={styles.closeButton}
                >
                  <Text style={styles.closeGlyph}>×</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
            {children}
          </ScrollView>
          {footer ? <View style={styles.footer}>{footer}</View> : null}
        </View>
      </View>
    </NativeModal>
  );
}
