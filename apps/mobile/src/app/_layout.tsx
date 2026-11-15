import { Tabs } from "expo-router/js-tabs";
import { StatusBar } from "expo-status-bar";
import { Icon } from "../components/Icon";
import { SettingsProvider, useSettings } from "../settings";
import { colors } from "../theme";

function AppTabs() {
  const { t } = useSettings();
  return (
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
      <Tabs.Screen name="kiosk" options={{ href: null, headerShown: false, tabBarStyle: { display: "none" } }} />
    </Tabs>
  );
}

export default function RootLayout() {
  return (
    <SettingsProvider>
      <StatusBar style="dark" />
      <AppTabs />
    </SettingsProvider>
  );
}
