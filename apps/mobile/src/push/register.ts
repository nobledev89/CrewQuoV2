import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { api } from '@/api/client';

/**
 * Register this device's Expo push token with the API once the user is signed in
 * (CREWQUO_V2_PLAN.md §3.4). Best-effort: permission denial or a simulator (no
 * push support) is a no-op, never an error. The EAS projectId comes from app.json
 * (extra.eas.projectId).
 */
export function usePushRegistration(accessToken: string | null): void {
  const registered = useRef(false);

  useEffect(() => {
    if (!accessToken || registered.current) return;
    registered.current = true;
    void registerAsync(accessToken).catch((err) => {
      registered.current = false;
      console.warn('[push] registration failed:', err);
    });
  }, [accessToken]);
}

async function registerAsync(accessToken: string): Promise<void> {
  if (!Device.isDevice) return; // push tokens require a physical device

  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== 'granted') {
    status = (await Notifications.requestPermissionsAsync()).status;
  }
  if (status !== 'granted') return;

  const projectId =
    (Constants.expoConfig?.extra?.eas as { projectId?: string } | undefined)?.projectId;
  const { data: token } = await Notifications.getExpoPushTokenAsync(
    projectId ? { projectId } : undefined
  );

  await api.registerPushToken(accessToken, token, Platform.OS);
}
