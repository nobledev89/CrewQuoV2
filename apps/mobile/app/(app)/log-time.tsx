import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SHIFT_TYPES, todayInZone, type ShiftType, type WorkContextAssignment } from '@crewquo/shared';
import { api, ApiError } from '@/api/client';
import { useAuth } from '@/auth/AuthProvider';
import { styles } from '@/ui/theme';


/** Provider logs time against an assigned project, then submits it for approval. */
export default function LogTimeScreen() {
  const { accessToken, activeCompanyId } = useAuth();
  const qc = useQueryClient();
  const router = useRouter();

  const context = useQuery({
    queryKey: ['work-context', activeCompanyId],
    enabled: Boolean(accessToken && activeCompanyId),
    queryFn: () => api.workContext(accessToken!, activeCompanyId!),
  });

  const assignments = context.data?.assignments ?? [];
  const [projectId, setProjectId] = useState<string | null>(null);
  const [roleId, setRoleId] = useState<string | null>(null);
  const [shiftType, setShiftType] = useState<ShiftType>('WEEKDAY_DAY');
  const [workDate, setWorkDate] = useState('');
  // Until the person types a date themselves, the field tracks the project's own
  // today. After that nothing moves it: switching project must not rewrite a date
  // somebody deliberately entered.
  const [dateTouched, setDateTouched] = useState(false);
  const [hours, setHours] = useState('8');
  const [error, setError] = useState<string | null>(null);

  const selected: WorkContextAssignment | undefined = assignments.find(
    (assignment) => assignment.projectId === projectId
  );

  /**
   * The default work date is the **project's** today.
   *
   * This screen used to default to `new Date().toISOString().slice(0, 10)` — the
   * *UTC* date, not even the device's. For a Manila crew (UTC+8) that is yesterday
   * every morning before 08:00, which is precisely when a night shift gets logged:
   * the whole shift filed against the wrong day, found weeks later at approval.
   * `docs/operating-model/time.md` §1 and §8 — the device's zone is diagnostic
   * metadata, never an input to which day work counts against.
   */
  const projectZone = selected?.timeZone ?? null;
  useEffect(() => {
    if (dateTouched || !projectZone) return;
    setWorkDate(todayInZone(projectZone, new Date()));
  }, [projectZone, dateTouched]);

  const submit = useMutation({
    mutationFn: async () => {
      if (!projectId || !roleId) throw new Error('Pick a project and role');
      const created = await api.createTimeLog(accessToken!, activeCompanyId!, {
        projectId,
        roleId,
        shiftType,
        workDate,
        hoursRegular: Number(hours) || 0,
        hoursOt: 0,
      });
      await api.submitTimeLog(accessToken!, activeCompanyId!, created.timeLog.id);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['time-logs'] });
      router.back();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : (e as Error).message),
  });

  if (context.isLoading) {
    return (
      <View style={styles.screen}>
        <ActivityIndicator />
      </View>
    );
  }

  if (assignments.length === 0) {
    return (
      <ScrollView contentContainerStyle={{ padding: 24, gap: 12 }}>
        <Text style={styles.title}>Log time</Text>
        <Text style={styles.subtitle}>
          You have no active project assignments yet. A client needs to add you as a provider and
          assign you to a project.
        </Text>
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 24, gap: 16 }}>
      <Text style={styles.title}>Log time</Text>

      <Field label="Project">
        <Chips
          options={assignments.map((a) => ({ key: a.projectId, label: a.projectName }))}
          value={projectId}
          onChange={(v) => {
            setProjectId(v);
            setRoleId(null);
          }}
        />
      </Field>

      {selected ? (
        <Field label={`Role (from ${selected.clientCompanyName})`}>
          {selected.roles.length === 0 ? (
            <Text style={styles.subtitle}>The client has not defined any roles yet.</Text>
          ) : (
            <Chips
              options={selected.roles.map((r) => ({ key: r.id, label: r.name }))}
              value={roleId}
              onChange={setRoleId}
            />
          )}
        </Field>
      ) : null}

      <Field label="Shift type">
        <Chips
          options={SHIFT_TYPES.map((s) => ({ key: s, label: s }))}
          value={shiftType}
          onChange={(v) => setShiftType(v as ShiftType)}
        />
      </Field>

      <Field label={projectZone ? `Work date (${projectZone})` : 'Work date'}>
        <TextInput
          style={styles.input}
          value={workDate}
          onChangeText={(value) => {
            setDateTouched(true);
            setWorkDate(value);
          }}
          placeholder="YYYY-MM-DD"
          autoCapitalize="none"
        />
      </Field>

      <Field label="Hours">
        <TextInput
          style={styles.input}
          value={hours}
          onChangeText={setHours}
          keyboardType="decimal-pad"
        />
      </Field>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Pressable
        style={[styles.button, (!projectId || !roleId || submit.isPending) && { opacity: 0.5 }]}
        disabled={!projectId || !roleId || submit.isPending}
        onPress={() => {
          setError(null);
          submit.mutate();
        }}
      >
        <Text style={styles.buttonText}>{submit.isPending ? 'Submitting…' : 'Submit for approval'}</Text>
      </Pressable>
    </ScrollView>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ fontSize: 13, fontWeight: '600', color: '#555' }}>{label}</Text>
      {children}
    </View>
  );
}

function Chips({
  options,
  value,
  onChange,
}: {
  options: { key: string; label: string }[];
  value: string | null;
  onChange: (key: string) => void;
}) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {options.map((o) => {
        const active = o.key === value;
        return (
          <Pressable
            key={o.key}
            onPress={() => onChange(o.key)}
            style={{
              paddingHorizontal: 14,
              paddingVertical: 9,
              borderRadius: 999,
              borderWidth: 1,
              borderColor: active ? '#2563eb' : '#ccc',
              backgroundColor: active ? '#2563eb' : 'transparent',
            }}
          >
            <Text style={{ color: active ? '#fff' : '#333', fontWeight: '600', fontSize: 13 }}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
