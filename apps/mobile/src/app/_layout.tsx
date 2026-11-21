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
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { registerForPush } from "../push";
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
    // A schedule notification arriving while the app is open: refresh the calendar and reminders
    const received = Notifications.addNotificationReceivedListener(() => run());
    return () => {
      sub.remove();
      received.remove();
    };
  }, [me, employments, locations, t, lang]);

  useEffect(() => {
    if (!me) return;
    registerForPush();
    supabase.rpc("set_my_locale", { p_locale: lang === "fr" ? "fr-CA" : "en-CA" }).then(undefined, () => undefined);
    // Tapping a notification opens the right tab
    const tapped = Notifications.addNotificationResponseReceivedListener((response) => {
      const type = (response.notification.request.content.data as { type?: string } | undefined)?.type;
      if (type === "time_off" || type === "availability" || type === "punch_correction") router.navigate("/requests");
      else if (type) router.navigate("/schedule");
    });
    return () => tapped.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.id]);
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
      <Tabs.Screen name="requests" options={{ title: t.tabs.requests, tabBarIcon: ({ color }) => <Icon name="requests" color={color} /> }} />
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
