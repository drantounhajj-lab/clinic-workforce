import DateTimePicker, { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radius, space } from "../theme";

/** A date or time input: compact native picker on iOS, a button that opens the dialog on Android. */
export function DateTimeField({
  label,
  mode,
  value,
  onChange,
  lang,
  minimumDate,
  maximumDate,
}: {
  label: string;
  mode: "date" | "time";
  value: Date;
  onChange: (d: Date) => void;
  lang: "fr" | "en";
  minimumDate?: Date;
  maximumDate?: Date;
}) {
  const locale = lang === "fr" ? "fr-CA" : "en-CA";
  const text =
    mode === "date"
      ? new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(value)
      : new Intl.DateTimeFormat("en-CA", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(value);
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      {Platform.OS === "ios" ? (
        <DateTimePicker
          value={value}
          mode={mode}
          display="compact"
          locale={locale}
          minuteInterval={mode === "time" ? 5 : undefined}
          minimumDate={minimumDate}
          maximumDate={maximumDate}
          onChange={(e, d) => {
            if (d) onChange(d);
          }}
          accessibilityLabel={label}
        />
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${label}: ${text}`}
          style={styles.button}
          onPress={() =>
            DateTimePickerAndroid.open({
              value,
              mode,
              is24Hour: true,
              minimumDate,
              maximumDate,
              onChange: (e, d) => {
                if (e.type === "set" && d) onChange(d);
              },
            })
          }
        >
          <Text style={styles.value}>{text}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md, minHeight: 44 },
  label: { fontSize: 15, color: colors.ink, flexShrink: 1 },
  button: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: space.sm, backgroundColor: colors.surface },
  value: { fontSize: 15, color: colors.ink, fontVariant: ["tabular-nums"] },
});
