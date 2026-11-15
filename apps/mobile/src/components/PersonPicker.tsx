import { persons } from "@clinic-workforce/sample-data";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSettings } from "../settings";
import { colors, radius, space } from "../theme";
import { Card, Muted } from "./ui";

export function PersonPicker({ onPicked }: { onPicked?: () => void }) {
  const { t, settings, update } = useSettings();
  return (
    <Card>
      <Text style={styles.title}>{t.whoAreYou}</Text>
      <Muted small>{t.whoHint}</Muted>
      <View style={styles.list}>
        {persons.map((p) => {
          const on = settings.personId === p.id;
          return (
            <Pressable
              key={p.id}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              onPress={() => {
                update({ personId: p.id });
                onPicked?.();
              }}
              style={[styles.row, on && { borderColor: colors.accent, backgroundColor: colors.accentSoft }]}
            >
              <Text style={styles.name}>{p.name}</Text>
              <Text style={styles.role}>{t.roles[p.role]}</Text>
            </Pressable>
          );
        })}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 20, fontWeight: "700", color: colors.ink },
  list: { gap: space.sm, marginTop: space.sm },
  row: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, padding: space.md, minHeight: 48 },
  name: { fontSize: 16, fontWeight: "600", color: colors.ink },
  role: { fontSize: 13, color: colors.muted },
});
