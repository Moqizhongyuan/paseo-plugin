import type { PluginTheme } from "@getpaseo/plugin";
import { type ReactNode, useMemo, useState } from "react";
import {
  Pressable,
  type PressableProps,
  StyleSheet,
  Text,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
  View,
} from "react-native";

export interface ListItemProps extends Omit<
  PressableProps,
  "accessibilityRole" | "accessibilityState" | "children" | "style"
> {
  theme: PluginTheme;
  title: ReactNode;
  description?: ReactNode;
  leading?: ReactNode;
  actions?: readonly ListItemAction[];
  style?: StyleProp<ViewStyle>;
  titleStyle?: StyleProp<TextStyle>;
  descriptionStyle?: StyleProp<TextStyle>;
}

export interface ListItemAction {
  id: string;
  accessibilityLabel: string;
  icon: ReactNode;
  onPress: () => void;
  disabled?: boolean;
}

export function ListItem({
  theme,
  title,
  description,
  leading,
  actions = [],
  style,
  titleStyle,
  descriptionStyle,
  disabled = false,
  onFocus,
  onBlur,
  ...pressableProps
}: ListItemProps) {
  const [active, setActive] = useState(false);
  const isDisabled = disabled === true;
  const styles = useMemo(
    () =>
      StyleSheet.create({
        item: {
          minHeight: 68,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 12,
          paddingVertical: 10,
          borderBottomWidth: 1,
          borderColor: theme.colors.foregroundMuted,
        },
        main: {
          flex: 1,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          minWidth: 0,
        },
        leading: {
          alignItems: "center",
          justifyContent: "center",
        },
        content: {
          flex: 1,
          minWidth: 0,
          gap: 4,
        },
        title: {
          color: theme.colors.foreground,
          fontWeight: "600",
        },
        description: {
          color: theme.colors.foregroundMuted,
          fontSize: 12,
        },
        actions: {
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
        },
        actionButton: {
          minWidth: 30,
          minHeight: 30,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 6,
        },
        actionButtonHidden: {
          opacity: 0,
        },
        pressed: {
          opacity: 0.75,
        },
      }),
    [theme],
  );

  return (
    <View
      onPointerEnter={() => setActive(true)}
      onPointerLeave={() => setActive(false)}
      style={style ? [styles.item, style] : styles.item}
    >
      <Pressable
        {...pressableProps}
        accessibilityRole="button"
        accessibilityState={{ disabled: isDisabled }}
        disabled={isDisabled}
        onFocus={(event) => {
          setActive(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setActive(false);
          onBlur?.(event);
        }}
        style={({ pressed }) => [styles.main, pressed && styles.pressed]}
      >
        {leading ? <View style={styles.leading}>{leading}</View> : null}
        <View style={styles.content}>
          <Text numberOfLines={1} style={[styles.title, titleStyle]}>
            {title}
          </Text>
          {description !== undefined ? (
            <Text numberOfLines={2} style={[styles.description, descriptionStyle]}>
              {description}
            </Text>
          ) : null}
        </View>
      </Pressable>
      {actions.length > 0 ? (
        <View style={styles.actions}>
          {actions.map((action) => {
            const actionDisabled = isDisabled || action.disabled === true;
            return (
              <Pressable
                key={action.id}
                accessibilityRole="button"
                accessibilityLabel={action.accessibilityLabel}
                accessibilityState={{ disabled: actionDisabled }}
                disabled={actionDisabled}
                onFocus={() => setActive(true)}
                onBlur={() => setActive(false)}
                onPress={action.onPress}
                style={({ pressed }) => [
                  styles.actionButton,
                  !active && styles.actionButtonHidden,
                  pressed && styles.pressed,
                ]}
              >
                {action.icon}
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

export const List = {
  Item: ListItem,
};
