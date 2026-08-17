import { Stack } from 'expo-router';

export default function AppLayout() {
  return (
    <Stack screenOptions={{ headerShown: true }}>
      <Stack.Screen name="index" options={{ title: 'CrewQuo' }} />
      <Stack.Screen name="switcher" options={{ title: 'Switch company', presentation: 'modal' }} />
      <Stack.Screen name="log-time" options={{ title: 'Log time' }} />
      <Stack.Screen name="approvals" options={{ title: 'Approvals' }} />
    </Stack>
  );
}
