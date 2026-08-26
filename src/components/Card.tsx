import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo } from "react";
import { StyleSheet, type StyleProp, type ViewProps, type ViewStyle, View } from "react-native";

export interface CardProps extends Omit<ViewProps, "style"> {
  theme: PluginTheme;
  style?: StyleProp<ViewStyle>;
}

export function Card({ theme, style, ...viewProps }: CardProps) {
  const styles = useMemo(
    () =>
      StyleSheet.create({
        card: {
          backgroundColor: theme.colors.surface0,
          borderWidth: 1,
          borderColor: theme.colors.foregroundMuted,
          borderRadius: 10,
          overflow: "hidden",
        },
      }),
    [theme],
  );

  return <View {...viewProps} style={[styles.card, style]} />;
}
