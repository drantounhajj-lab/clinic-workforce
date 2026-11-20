import { Tabs } from "expo-router/js-tabs";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { ActivityIndicator, AppState, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Icon } from "../components/Icon";
import { Kiosk } from "../components/Kiosk";
import { Login } from "../components/Login";
import { Button, Card, Muted } from "../components/ui";
import { SessionProvider, useSession } from "../session";
import { syncShifts } from "../shiftSync";
import { supabase } from "../supabase";
import { colors, space } from "../theme";

/** Keeps the phone calendar and shift reminders up to date when the app opens or comes back. */
function ShiftSyncer() {
  const { t, lang, me, employments, locations } = useSession();
  useEffect(() => {
    if (!me) return;
    const run = () => syncShifts({ employments, locations, t, lang }).catch(() => undefined);
    run();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") run();
    });
    return () => sub.remove();
  }, [me, employments, locations, t, lang]);
  return null;
}

function Gate() {
  const { t, ready, session, isAnonymous, me } = useSession();

  if (!ready) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }
  if (!session) return <Login />;
  if (isAnonymous) return <Kiosk />;
  if (!me) {
    return (
      <SafeAreaView style={styles.safe}>
        <ScrollView contentContainerStyle={styles.page}>
          <Card>
            <Text style={styles.title}>{t.notInvitedTitle}</Text>
            <Muted>{session.user.email ?? ""}</Muted>
            <Muted>{t.notInvitedHint}</Muted>
            <Button title={t.signOut} onPress={() => supabase.auth.signOut()} />
          </Card>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <>
    <ShiftSyncer />
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTitleStyle: { color: colors.ink, fontWeight: "600" },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.line },
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tabs.Screen name="index" options={{ title: t.tabs.clock, tabBarIcon: ({ color }) => <Icon name="clock" color={color} /> }} />
      <Tabs.Screen name="schedule" options={{ title: t.tabs.schedule, tabBarIcon: ({ color }) => <Icon name="schedule" color={color} /> }} />
      <Tabs.Screen name="setup" options={{ title: t.tabs.setup, tabBarIcon: ({ color }) => <Icon name="setup" color={color} /> }} />
    </Tabs>
    </>
  );
}

export default function RootLayout() {
  return (
    <SessionProvider>
      <StatusBar style="dark" />
      <Gate />
    </SessionProvider>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
  safe: { flex: 1, backgroundColor: colors.bg },
  page: { padding: space.lg, paddingTop: space.xl * 2 },
  title: { fontSize: 20, fontWeight: "700", color: colors.ink },
});
