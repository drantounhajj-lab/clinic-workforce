import { useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { fmtDay, fmtTime } from "../format";
import { useSession } from "../session";
import { type Shift, type SwapColleague, type SwapShift, supabase } from "../supabase";
import { colors, radius, space } from "../theme";
import { Button, Label, Muted, Result } from "./ui";

/** Ask a colleague to take my shift, or to exchange it for one of theirs. */
export function SwapSheet({ shift, onClose }: { shift: Shift | null; onClose: (sent: boolean) => void }) {
  const { t, lang, locations } = useSession();
  const [colleagues, setColleagues] = useState<SwapColleague[] | null>(null);
  const [colleague, setColleague] = useState<SwapColleague | null>(null);
  const [theirShift, setTheirShift] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!shift) return;
    setColleagues(null);
    setColleague(null);
    setTheirShift(null);
    setNote("");
    setResult(null);
    supabase.rpc("swap_candidates", { p_shift_id: shift.id }).then(({ data, error }) => {
      if (error || !data?.ok) {
        setColleagues([]);
        setResult({ ok: false, text: error?.message ?? t.swapErrors[data?.reason] ?? t.error });
      } else setColleagues((data.colleagues as SwapColleague[]) ?? []);
    });
  }, [shift, t]);

  if (!shift) return null;
  const loc = (id: string) => locations.find((l) => l.id === id);
  const when = (s: SwapShift | Shift) => {
    const tz = loc(s.location_id)?.timezone;
    return `${fmtDay(s.starts_at, lang, tz)} · ${fmtTime(s.starts_at, tz)}–${fmtTime(s.ends_at, tz)} · ${loc(s.location_id)?.name ?? ""}`;
  };

  async function send() {
    if (!shift || !colleague) return;
    setBusy(true);
    const { data, error } = await supabase.rpc("request_shift_swap", {
      p_shift_id: shift.id,
      p_target_employment_id: colleague.employment_id,
      p_target_shift_id: theirShift,
      p_note: note.trim() || null,
    });
    setBusy(false);
    if (error) setResult({ ok: false, text: error.message });
    else if (!data?.ok) setResult({ ok: false, text: t.swapErrors[data?.reason] ?? t.error });
    else setResult({ ok: true, text: t.requestSent });
  }

  const sent = result?.ok === true;

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={() => onClose(sent)}>
      <SafeAreaView style={styles.page} edges={["top", "bottom"]}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>{t.exchangeTitle}</Text>
          <Text style={styles.shift}>{when(shift)}</Text>
          <Muted small>{t.exchangeHint}</Muted>

          {sent ? (
            <Result ok title={result.text} />
          ) : colleagues === null ? (
            <ActivityIndicator color={colors.accent} />
          ) : (
            <>
              <Label>{t.pickColleague}</Label>
              {colleagues.length === 0 && <Muted>{t.noColleagues}</Muted>}
              {colleagues.map((c) => (
                <Choice
                  key={c.employment_id}
                  label={`${c.first_name} ${c.last_name}`}
                  selected={colleague?.employment_id === c.employment_id}
                  onPress={() => {
                    setColleague(c);
                    setTheirShift(null);
                  }}
                />
              ))}

              {colleague && (
                <>
                  <Choice label={t.giveShift} selected={theirShift === null} onPress={() => setTheirShift(null)} />
                  <Label>{t.takeTheirs}</Label>
                  {colleague.shifts.length === 0 && <Muted small>{t.noTheirShifts}</Muted>}
                  {colleague.shifts.map((s) => (
                    <Choice key={s.id} label={when(s)} selected={theirShift === s.id} onPress={() => setTheirShift(s.id)} />
                  ))}
                  <Label>{t.noteOptional}</Label>
                  <TextInput
                    style={styles.input}
                    value={note}
                    onChangeText={setNote}
                    maxLength={500}
                    multiline
                    accessibilityLabel={t.noteOptional}
                  />
                  <Button variant="primary" big title={t.sendRequest} busy={busy} onPress={send} />
                </>
              )}
              {result && !result.ok && <Result ok={false} title={result.text} />}
            </>
          )}
          <Button variant="ghost" title={sent ? t.close : t.cancel} onPress={() => onClose(sent)} />
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function Choice({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.choice, selected && styles.choiceOn]}
    >
      <View style={[styles.dot, selected && styles.dotOn]} />
      <Text style={styles.choiceText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg, gap: space.md },
  title: { fontSize: 20, fontWeight: "700", color: colors.ink },
  shift: { fontSize: 15, color: colors.ink, textTransform: "capitalize" },
  choice: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  choiceOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  dot: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: colors.line },
  dotOn: { borderColor: colors.accent, backgroundColor: colors.accent },
  choiceText: { flex: 1, fontSize: 15, color: colors.ink },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    padding: space.md,
    minHeight: 70,
    fontSize: 15,
    color: colors.ink,
    backgroundColor: colors.surface,
    textAlignVertical: "top",
  },
});
