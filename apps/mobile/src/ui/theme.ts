import { StyleSheet } from 'react-native';

// Minimal shared styles for Phase 1 screens. The real design system
// (packages/ui tokens) arrives once UI work starts (open item #5).
export const styles = StyleSheet.create({
  screen: { flex: 1, padding: 24, gap: 16, justifyContent: 'center', backgroundColor: '#fff' },
  title: { fontSize: 28, fontWeight: '700', color: '#111' },
  subtitle: { fontSize: 15, color: '#555' },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  button: { backgroundColor: '#2563eb', borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  link: { color: '#2563eb', fontSize: 15, textAlign: 'center' },
  error: { color: '#dc2626', fontSize: 14 },
  card: { borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 12, padding: 16, gap: 4 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
});
