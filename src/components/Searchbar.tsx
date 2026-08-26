import type { PluginTheme } from "@getpaseo/plugin";
import { type ReactNode, useMemo } from "react";
import {
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  type TextStyle,
  type StyleProp,
  type ViewStyle,
  View,
} from "react-native";

export interface SearchbarProps extends Omit<TextInputProps, "onChangeText" | "style" | "value"> {
  theme: PluginTheme;
  value: string;
  onChangeText: (value: string) => void;
  icon?: ReactNode;
  style?: StyleProp<ViewStyle>;
  inputStyle?: StyleProp<TextStyle>;
}

export function Searchbar({
  theme,
  value,
  onChangeText,
  icon,
  style,
  inputStyle,
  placeholderTextColor,
  ...textInputProps
}: SearchbarProps) {
  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: {
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          minHeight: 40,
          paddingHorizontal: 12,
          backgroundColor: theme.colors.surface0,
          borderWidth: 1,
          borderColor: theme.colors.foregroundMuted,
          borderRadius: 10,
        },
        icon: {
          color: theme.colors.foregroundMuted,
          fontSize: 18,
          lineHeight: 20,
        },
        input: {
          flex: 1,
          paddingVertical: 7,
          color: theme.colors.foreground,
          fontSize: 14,
          lineHeight: 20,
        },
      }),
    [theme],
  );

  return (
    <View style={[styles.container, style]}>
      {icon ?? (
        <Text accessible={false} style={styles.icon}>
          ⌕
        </Text>
      )}
      <TextInput
        {...textInputProps}
        value={value}
        onChangeText={onChangeText}
        placeholderTextColor={placeholderTextColor ?? theme.colors.foregroundMuted}
        style={[styles.input, inputStyle]}
      />
    </View>
  );
}
