import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import type { TimeLogView } from '@crewquo/shared';
import { api, ApiError } from '@/api/client';
import { useAuth } from '@/auth/AuthProvider';
import { styles } from '@/ui/theme';

/** Client-side approvals inbox: SUBMITTED time logs, approve or reject. */
export default function ApprovalsScreen() {
  const { accessToken, activeCompanyId } = useAuth();
  const qc = useQueryClient();

  const inbox = useQuery({
    queryKey: ['time-logs', 'SUBMITTED', activeCompanyId],
    enabled: Boolean(accessToken && activeCompanyId),
    queryFn: () => api.timeLogs(accessToken!, activeCompanyId!, 'SUBMITTED'),
  });

  const review = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'approve' | 'reject' }) =>
      decision === 'approve'
        ? api.approveTimeLog(accessToken!, activeCompanyId!, id)
        : api.rejectTimeLog(accessToken!, activeCompanyId!, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['time-logs'] }),
  });

  if (inbox.isLoading) {
    return (
      <View style={styles.screen}>
        <ActivityIndicator />
      </View>
    );
  }

  const logs = inbox.data?.data ?? [];

  return (
    <ScrollView contentContainerStyle={{ padding: 24, gap: 12 }}>
      <Text style={styles.title}>Approvals</Text>
      {inbox.isError ? <Text style={styles.error}>Could not load the inbox.</Text> : null}

      {logs.length === 0 ? (
        <Text style={styles.subtitle}>Nothing awaiting approval. 🎉</Text>
      ) : (
        logs.map((log) => <ApprovalCard key={log.id} log={log} onReview={review.mutate} busy={review.isPending} />)
      )}
    </ScrollView>
  );
}

function ApprovalCard({
  log,
  onReview,
  busy,
}: {
  log: TimeLogView;
  onReview: (v: { id: string; decision: 'approve' | 'reject' }) => void;
  busy: boolean;
}) {
  const cost = log.resolvedRate?.costCents;
  return (
    <View style={styles.card}>
      <Text style={{ fontSize: 16, fontWeight: '600' }}>
        {log.hoursRegular + log.hoursOt}h · {log.shiftType}
      </Text>
      <Text style={styles.subtitle}>{log.workDate}</Text>
      <Text style={styles.subtitle}>
        {cost !== undefined && cost !== null ? `Cost: ${(cost / 100).toFixed(2)}` : 'No rate resolved'}
      </Text>
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
        <Pressable
          style={[styles.button, { flex: 1, backgroundColor: '#16a34a' }, busy && { opacity: 0.5 }]}
          disabled={busy}
          onPress={() => onReview({ id: log.id, decision: 'approve' })}
        >
          <Text style={styles.buttonText}>Approve</Text>
        </Pressable>
        <Pressable
          style={[styles.button, { flex: 1, backgroundColor: '#dc2626' }, busy && { opacity: 0.5 }]}
          disabled={busy}
          onPress={() => onReview({ id: log.id, decision: 'reject' })}
        >
          <Text style={styles.buttonText}>Reject</Text>
        </Pressable>
      </View>
    </View>
  );
}
