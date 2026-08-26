import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useMemo, useRef } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";

export type ToastVariant = "success" | "error";

export interface ToastProps {
  theme: PluginTheme;
  visible: boolean;
  message: string;
  variant?: ToastVariant;
  compact?: boolean;
  duration?: number;
  onDismiss?: () => void;
}

/**
 * A small, theme-aware floating feedback surface.
 *
 * Paseo currently does not expose a plugin-level toast API. Keeping the
 * component absolutely positioned means feedback never changes the panel's
 * layout or pushes the composer/list content down.
 */
export function Toast({
  theme,
  visible,
  message,
  variant = "success",
  compact = false,
  duration = 2400,
  onDismiss,
}: ToastProps) {
  const progress = useRef(new Animated.Value(0)).current;
  const styles = useMemo(
    () =>
      StyleSheet.create({
        host: {
          position: "absolute",
          top: 12,
          right: 12,
          zIndex: 100,
          alignItems: "flex-end",
        },
        compactHost: {
          right: 10,
          left: 10,
          alignItems: "stretch",
        },
        toast: {
          maxWidth: 420,
          minHeight: 42,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingHorizontal: 12,
          paddingVertical: 9,
          backgroundColor: theme.colors.surface0,
          borderWidth: 1,
          borderColor: theme.colors.foregroundMuted,
          borderRadius: 10,
          shadowColor: "#000000",
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.16,
          shadowRadius: 12,
          elevation: 6,
        },
        compactToast: {
          width: "100%",
          maxWidth: "100%",
        },
        indicator: {
          width: 4,
          height: 22,
          borderRadius: 2,
        },
        symbol: {
          width: 18,
          color: theme.colors.foreground,
          fontSize: 14,
          fontWeight: "700",
          textAlign: "center",
        },
        message: {
          flex: 1,
          color: theme.colors.foreground,
          fontSize: 13,
          lineHeight: 18,
        },
      }),
    [theme],
  );

  useEffect(() => {
    const animation = Animated.timing(progress, {
      toValue: visible ? 1 : 0,
      duration: visible ? 180 : 140,
      easing: visible ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: false,
    });

    animation.start();
    return () => animation.stop();
  }, [progress, visible]);

  useEffect(() => {
    if (!visible || !onDismiss) return;

    const timer = setTimeout(onDismiss, duration);
    return () => clearTimeout(timer);
  }, [duration, message, onDismiss, visible]);

  const indicatorColor = variant === "error" ? theme.colors.statusDanger : theme.colors.accent;

  return (
    <View pointerEvents="box-none" style={[styles.host, compact && styles.compactHost]}>
      <Animated.View
        accessibilityRole="alert"
        pointerEvents={visible ? "auto" : "none"}
        style={[
          styles.toast,
          compact && styles.compactToast,
          {
            opacity: progress,
            transform: [
              {
                translateY: progress.interpolate({
                  inputRange: [0, 1],
                  outputRange: [-6, 0],
                }),
              },
            ],
          },
        ]}
      >
        <View style={[styles.indicator, { backgroundColor: indicatorColor }]} />
        <Text accessible={false} style={styles.symbol}>
          {variant === "error" ? "!" : "✓"}
        </Text>
        <Text numberOfLines={2} style={styles.message}>
          {message}
        </Text>
      </Animated.View>
    </View>
  );
}
