import { useQuery } from '@tanstack/react-query';
import { Link } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { api } from '@/api/client';
import { useAuth } from '@/auth/AuthProvider';
import { usePushRegistration } from '@/push/register';
import { styles } from '@/ui/theme';

export default function HomeScreen() {
  const { user, memberships, accessToken, activeCompanyId, signOut } = useAuth();
  const activeMembership = memberships.find((m) => m.companyId === activeCompanyId);
  usePushRegistration(accessToken);

  const entitlements = useQuery({
    queryKey: ['entitlements', activeCompanyId],
    enabled: Boolean(accessToken && activeCompanyId),
    queryFn: () => api.entitlements(accessToken!, activeCompanyId!),
  });

  return (
    <ScrollView contentContainerStyle={{ padding: 24, gap: 16 }}>
      <Text style={styles.title}>Hi {user?.name ?? ''}</Text>

      <View style={styles.card}>
        <View style={styles.row}>
          <Text style={styles.subtitle}>Active company</Text>
          <Link href="/(app)/switcher" style={styles.link}>
            Switch
          </Link>
        </View>
        <Text style={{ fontSize: 18, fontWeight: '600' }}>
          {activeMembership ? activeMembership.companyName : 'No company yet'}
        </Text>
        {activeMembership ? (
          <Text style={styles.subtitle}>
            {activeMembership.role} · {activeMembership.currency}
          </Text>
        ) : (
          <Text style={styles.subtitle}>Create one from the switcher to get started.</Text>
        )}
      </View>

      {activeCompanyId ? (
        <View style={styles.card}>
          <Text style={styles.subtitle}>Work</Text>
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
            <Link href="/(app)/log-time" style={[styles.button, { flex: 1, textAlign: 'center', color: '#fff', paddingVertical: 12 }]}>
              Log time
            </Link>
            <Link href="/(app)/approvals" style={[styles.button, { flex: 1, textAlign: 'center', color: '#fff', paddingVertical: 12, backgroundColor: '#0f172a' }]}>
              Approvals
            </Link>
          </View>
        </View>
      ) : null}

      {activeCompanyId ? (
        <View style={styles.card}>
          <Text style={styles.subtitle}>Plan &amp; entitlements</Text>
          {entitlements.isLoading ? (
            <ActivityIndicator />
          ) : entitlements.isError ? (
            <Text style={styles.error}>Could not load entitlements</Text>
          ) : entitlements.data ? (
            <View style={{ gap: 8 }}>
              <Text style={{ fontSize: 18, fontWeight: '600', textTransform: 'capitalize' }}>
                {entitlements.data.planId}
              </Text>
              <Text style={styles.subtitle}>
                Downstream: {entitlements.data.operatesDownstream ? 'yes' : 'no'}
              </Text>
              <Text style={styles.subtitle}>
                Features: {entitlements.data.features.join(', ') || 'none'}
              </Text>
              {entitlements.data.usage.map((u) => (
                <Text key={u.key} style={styles.subtitle}>
                  {u.key}: {u.used} / {u.value ?? '∞'}
                </Text>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}

      <Pressable style={styles.button} onPress={signOut}>
        <Text style={styles.buttonText}>Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}
