import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useSession } from "../session";
import { supabase } from "../supabase";
import { colors, radius, space } from "../theme";
import { Button, Card, Muted, Segmented } from "./ui";

export function Login() {
  const { t, lang, setLang } = useSession();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code" | "password">("email");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function sendCode() {
    const clean = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
      setError(t.invalidEmail);
      return;
    }
    setBusy(true);
    setError("");
    const { error: err } = await supabase.auth.signInWithOtp({ email: clean, options: { shouldCreateUser: true } });
    setBusy(false);
    if (err) setError(err.message);
    else {
      setEmail(clean);
      setStep("code");
    }
  }

  async function verify() {
    if (!/^\d{6,10}$/.test(code)) {
      setError(t.invalidCode);
      return;
    }
    setBusy(true);
    setError("");
    const { error: err } = await supabase.auth.verifyOtp({ email, token: code, type: "email" });
    setBusy(false);
    if (err) setError(err.message);
  }

  // Accounts created with a password in the Supabase dashboard (e.g. for Apple's App Review team).
  async function signInWithPassword() {
    const clean = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean) || !password) {
      setError(t.invalidEmail);
      return;
    }
    setBusy(true);
    setError("");
    const { error: err } = await supabase.auth.signInWithPassword({ email: clean, password });
    setBusy(false);
    if (err) setError(t.wrongPassword);
  }

  async function startKiosk() {
    setBusy(true);
    setError("");
    const { error: err } = await supabase.auth.signInAnonymously();
    setBusy(false);
    if (err) setError(err.message);
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
          <Text style={styles.brand}>Clinic Workforce</Text>
          <Segmented
            options={[
              { value: "fr", label: "Français" },
              { value: "en", label: "English" },
            ]}
            value={lang}
            onChange={setLang}
          />
          <Card>
            <Text style={styles.title}>{t.signInTitle}</Text>
            {step === "email" ? (
              <>
                <Muted>{t.signInHint}</Muted>
                <Text style={styles.label}>{t.email}</Text>
                <TextInput
                  style={styles.input}
                  value={email}
                  onChangeText={setEmail}
                  autoCapitalize="none"
                  autoComplete="email"
                  keyboardType="email-address"
                  textContentType="emailAddress"
                  accessibilityLabel={t.email}
                  onSubmitEditing={sendCode}
                />
                {error ? <Text style={styles.error}>{error}</Text> : null}
                <Button variant="primary" big title={t.sendCode} busy={busy} onPress={sendCode} />
                <Button variant="ghost" title={t.usePassword} onPress={() => { setStep("password"); setError(""); }} />
              </>
            ) : step === "password" ? (
              <>
                <Text style={styles.label}>{t.email}</Text>
                <TextInput
                  style={styles.input}
                  value={email}
                  onChangeText={setEmail}
                  autoCapitalize="none"
                  autoComplete="email"
                  keyboardType="email-address"
                  textContentType="username"
                  accessibilityLabel={t.email}
                />
                <Text style={styles.label}>{t.password}</Text>
                <TextInput
                  style={styles.input}
                  value={password}
                  onChangeText={setPassword}
                  autoCapitalize="none"
                  secureTextEntry
                  textContentType="password"
                  accessibilityLabel={t.password}
                  onSubmitEditing={signInWithPassword}
                />
                {error ? <Text style={styles.error}>{error}</Text> : null}
                <Button variant="primary" big title={t.verify} busy={busy} onPress={signInWithPassword} />
                <Button variant="ghost" title={t.useCode} onPress={() => { setStep("email"); setPassword(""); setError(""); }} />
              </>
            ) : (
              <>
                <Muted>{t.codeSent(email)}</Muted>
                <Text style={styles.label}>{t.code}</Text>
                <TextInput
                  style={[styles.input, styles.codeInput]}
                  value={code}
                  onChangeText={(v) => setCode(v.replace(/\D/g, "").slice(0, 10))}
                  keyboardType="number-pad"
                  textContentType="oneTimeCode"
                  autoComplete="one-time-code"
                  accessibilityLabel={t.code}
                  onSubmitEditing={verify}
                />
                {error ? <Text style={styles.error}>{error}</Text> : null}
                <Button variant="primary" big title={t.verify} busy={busy} onPress={verify} />
                <Button variant="ghost" title={t.otherEmail} onPress={() => { setStep("email"); setCode(""); setError(""); }} />
              </>
            )}
          </Card>
          <Button variant="ghost" title={t.setUpKiosk} onPress={startKiosk} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  page: { padding: space.lg, gap: space.lg, paddingTop: space.xl * 2 },
  brand: { fontSize: 26, fontWeight: "700", color: colors.ink, textAlign: "center" },
  title: { fontSize: 20, fontWeight: "700", color: colors.ink },
  label: { fontSize: 12, fontWeight: "600", color: colors.muted, marginTop: space.sm },
  input: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, paddingHorizontal: space.md, minHeight: 48, fontSize: 17, color: colors.ink, backgroundColor: colors.surface },
  codeInput: { fontSize: 24, letterSpacing: 4, textAlign: "center", fontVariant: ["tabular-nums"] },
  error: { color: colors.error, fontSize: 14 },
});
