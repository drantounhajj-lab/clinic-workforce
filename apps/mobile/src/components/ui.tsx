import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { colors, radius, space } from "../theme";

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Label({ children }: { children: ReactNode }) {
  return <Text style={styles.label}>{children}</Text>;
}

export function Muted({ children, small }: { children: ReactNode; small?: boolean }) {
  return <Text style={[styles.muted, small && { fontSize: 12 }]}>{children}</Text>;
}

type Variant = "primary" | "secondary" | "dark" | "ghost";

export function Button({
  title,
  onPress,
  variant = "secondary",
  big,
  busy,
  accessibilityHint,
}: {
  title: string;
  onPress: () => void;
  variant?: Variant;
  big?: boolean;
  busy?: boolean;
  accessibilityHint?: string;
}) {
  const v = variants[variant];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={accessibilityHint}
      onPress={busy ? undefined : onPress}
      style={({ pressed }) => [styles.button, big && styles.big, { backgroundColor: v.bg, borderColor: v.border }, pressed && { opacity: 0.8 }]}
    >
      {busy ? <ActivityIndicator color={v.fg} /> : <Text style={[styles.buttonText, big && styles.bigText, { color: v.fg }]}>{title}</Text>}
    </Pressable>
  );
}

const variants: Record<Variant, { bg: string; fg: string; border: string }> = {
  primary: { bg: colors.accent, fg: colors.accentInk, border: colors.accent },
  secondary: { bg: colors.surface, fg: colors.ink, border: colors.line },
  dark: { bg: colors.ink, fg: colors.surface, border: colors.ink },
  ghost: { bg: "transparent", fg: colors.accent, border: "transparent" },
};

export function Segmented<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <View style={styles.segmented} accessibilityRole="tablist">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(o.value)}
            style={[styles.segment, on && { backgroundColor: colors.ink }]}
          >
            <Text style={[styles.segmentText, on && { color: colors.surface }]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Result({ ok, title, lines = [] }: { ok: boolean; title: string; lines?: string[] }) {
  return (
    <View
      accessibilityLiveRegion="polite"
      style={[styles.result, { backgroundColor: ok ? colors.okSoft : colors.errorSoft, borderLeftColor: ok ? colors.ok : colors.error }]}
    >
      <Text style={[styles.resultTitle, !ok && { color: colors.error }]}>{title}</Text>
      {lines.map((l) => (
        <Text key={l} style={styles.resultLine}>
          {l}
        </Text>
      ))}
    </View>
  );
}

export function Tag({ text, tone = "accent" }: { text: string; tone?: "accent" | "ok" | "error" | "warn" | "ink" }) {
  const map = {
    accent: [colors.accentSoft, colors.accent],
    ok: [colors.okSoft, colors.ok],
    error: [colors.errorSoft, colors.error],
    warn: [colors.warnSoft, colors.warn],
    ink: ["#E8ECEF", colors.ink],
  } as const;
  const [bg, fg] = map[tone];
  return (
    <View style={[styles.tag, { backgroundColor: bg }]}>
      <Text style={[styles.tagText, { color: fg }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: radius.lg, padding: space.lg, gap: space.sm },
  label: { fontSize: 12, fontWeight: "700", color: colors.muted, textTransform: "uppercase", letterSpacing: 0.6 },
  muted: { color: colors.muted, fontSize: 14 },
  button: { minHeight: 44, borderRadius: radius.md, borderWidth: 1, paddingHorizontal: space.lg, alignItems: "center", justifyContent: "center" },
  buttonText: { fontSize: 15, fontWeight: "600" },
  big: { minHeight: 58, borderRadius: 14 },
  bigText: { fontSize: 18, fontWeight: "700" },
  segmented: { flexDirection: "row", backgroundColor: colors.bg, borderRadius: radius.md, padding: 3, gap: 3 },
  segment: { flex: 1, minHeight: 38, borderRadius: 9, alignItems: "center", justifyContent: "center", paddingHorizontal: space.sm },
  segmentText: { fontSize: 14, fontWeight: "600", color: colors.ink },
  result: { borderLeftWidth: 4, borderRadius: radius.md, padding: space.md, gap: 4 },
  resultTitle: { fontWeight: "700", fontSize: 15, color: colors.ink },
  resultLine: { fontSize: 14, color: colors.ink },
  tag: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, alignSelf: "flex-start" },
  tagText: { fontSize: 11, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.4 },
});
