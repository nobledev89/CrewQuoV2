import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { DEFAULT_CURRENCY } from '@crewquo/shared';
import { api, ApiError } from '@/api/client';
import { useAuth } from '@/auth/AuthProvider';
import { styles } from '@/ui/theme';

export default function SwitcherScreen() {
  const { memberships, activeCompanyId, accessToken, setActiveCompany, refreshMemberships } =
    useAuth();
  const router = useRouter();

  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(companyId: string) {
    await setActiveCompany(companyId);
    router.back();
  }

  async function createCompany() {
    if (!accessToken || !newName.trim()) return;
    setError(null);
    setBusy(true);
    try {
      const { company } = await api.createCompany(accessToken, {
        name: newName.trim(),
        currency: DEFAULT_CURRENCY,
      });
      await refreshMemberships();
      await setActiveCompany(company.id);
      setNewName('');
      router.back();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create company');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 24, gap: 16 }}>
      <Text style={styles.title}>Your companies</Text>

      {memberships.length === 0 ? (
        <Text style={styles.subtitle}>You have no companies yet. Create one below.</Text>
      ) : (
        memberships.map((m) => {
          const active = m.companyId === activeCompanyId;
          return (
            <Pressable key={m.companyId} style={styles.card} onPress={() => pick(m.companyId)}>
              <View style={styles.row}>
                <Text style={{ fontSize: 17, fontWeight: '600' }}>{m.companyName}</Text>
                {active ? <Text style={styles.link}>Active</Text> : null}
              </View>
              <Text style={styles.subtitle}>
                {m.role} · {m.currency}
              </Text>
            </Pressable>
          );
        })
      )}

      <View style={{ height: 1, backgroundColor: '#eee', marginVertical: 8 }} />

      <Text style={styles.subtitle}>Create a new company (you become OWNER)</Text>
      <TextInput
        style={styles.input}
        placeholder="Company name"
        value={newName}
        onChangeText={setNewName}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable style={styles.button} onPress={createCompany} disabled={busy}>
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>Create company</Text>
        )}
      </Pressable>
    </ScrollView>
  );
}
