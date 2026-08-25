import type { PluginTheme } from "@getpaseo/plugin";
import { type ReactNode, useMemo } from "react";
import {
  Pressable,
  type PressableProps,
  StyleSheet,
  Text,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "small" | "medium";

export interface ButtonProps extends Omit<
  PressableProps,
  "accessibilityRole" | "accessibilityState" | "children" | "style"
> {
  theme: PluginTheme;
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  loadingLabel?: string;
  icon?: ReactNode;
  style?: StyleProp<ViewStyle>;
  labelStyle?: StyleProp<TextStyle>;
}

export function Button({
  theme,
  label,
  variant = "primary",
  size = "medium",
  loading = false,
  loadingLabel = "处理中…",
  icon,
  style,
  labelStyle,
  disabled = false,
  accessibilityLabel,
  ...pressableProps
}: ButtonProps) {
  const styles = useMemo(
    () =>
      StyleSheet.create({
        button: {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          borderWidth: 1,
        },
        small: {
          minHeight: 32,
          paddingHorizontal: 10,
          borderRadius: 6,
        },
        medium: {
          minHeight: 40,
          paddingHorizontal: 14,
          borderRadius: 8,
        },
        primary: {
          backgroundColor: theme.colors.accent,
          borderColor: theme.colors.accent,
        },
        secondary: {
          backgroundColor: theme.colors.surface0,
          borderColor: theme.colors.foregroundMuted,
        },
        ghost: {
          backgroundColor: "transparent",
          borderColor: "transparent",
        },
        danger: {
          backgroundColor: "transparent",
          borderColor: theme.colors.statusDanger,
        },
        primaryLabel: {
          color: theme.colors.accentForeground,
        },
        secondaryLabel: {
          color: theme.colors.foreground,
        },
        ghostLabel: {
          color: theme.colors.foreground,
        },
        dangerLabel: {
          color: theme.colors.statusDanger,
        },
        label: {
          fontWeight: "600",
        },
        disabled: {
          opacity: 0.5,
        },
        pressed: {
          opacity: 0.8,
        },
      }),
    [theme],
  );

  const isDisabled = disabled || loading;
  const labelStyleForVariant = {
    primary: styles.primaryLabel,
    secondary: styles.secondaryLabel,
    ghost: styles.ghostLabel,
    danger: styles.dangerLabel,
  }[variant];

  return (
    <Pressable
      {...pressableProps}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.button,
        styles[size],
        styles[variant],
        isDisabled && styles.disabled,
        pressed && !isDisabled && styles.pressed,
        style,
      ]}
    >
      {icon}
      <Text style={[styles.label, labelStyleForVariant, labelStyle]}>
        {loading ? loadingLabel : label}
      </Text>
    </Pressable>
  );
}
