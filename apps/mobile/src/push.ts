/** Registers this phone for schedule notifications (Expo push), and removes it on sign-out. */
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { supabase } from "./supabase";

const KEY_TOKEN = "cw-push-token";
const KEY_ASKED = "cw-push-asked";

export async function registerForPush(): Promise<void> {
  try {
    let perm = await Notifications.getPermissionsAsync();
    if (!perm.granted && perm.canAskAgain && (await AsyncStorage.getItem(KEY_ASKED)) !== "1") {
      await AsyncStorage.setItem(KEY_ASKED, "1");
      perm = await Notifications.requestPermissionsAsync();
    }
    if (!perm.granted) return;
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", { name: "Clinic Workforce", importance: Notifications.AndroidImportance.HIGH });
    }
    const projectId = (Constants.expoConfig?.extra?.eas as { projectId?: string } | undefined)?.projectId;
    const { data: token } = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    const { data } = await supabase.rpc("register_push_token", { p_token: token, p_platform: Platform.OS === "ios" ? "ios" : "android" });
    if (data?.ok) await AsyncStorage.setItem(KEY_TOKEN, token);
  } catch {
    // Push isn't set up on this device (e.g. Android without Firebase): local reminders still work.
  }
}

export async function unregisterPush(): Promise<void> {
  try {
    const token = await AsyncStorage.getItem(KEY_TOKEN);
    if (token) await supabase.rpc("unregister_push_token", { p_token: token });
    await AsyncStorage.removeItem(KEY_TOKEN);
  } catch {
    /* offline: the token is replaced the next time this phone registers */
  }
}
