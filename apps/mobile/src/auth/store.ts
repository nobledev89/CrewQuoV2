import * as SecureStore from 'expo-secure-store';
import type { AuthTokens } from '@crewquo/shared';

// Tokens live in the OS keychain/keystore via expo-secure-store (§5).
const TOKENS_KEY = 'crewquo.tokens';
const ACTIVE_COMPANY_KEY = 'crewquo.activeCompanyId';

export async function saveTokens(tokens: AuthTokens): Promise<void> {
  await SecureStore.setItemAsync(TOKENS_KEY, JSON.stringify(tokens));
}

export async function loadTokens(): Promise<AuthTokens | null> {
  const raw = await SecureStore.getItemAsync(TOKENS_KEY);
  return raw ? (JSON.parse(raw) as AuthTokens) : null;
}

export async function clearTokens(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKENS_KEY);
}

export async function saveActiveCompanyId(id: string): Promise<void> {
  await SecureStore.setItemAsync(ACTIVE_COMPANY_KEY, id);
}

export async function loadActiveCompanyId(): Promise<string | null> {
  return SecureStore.getItemAsync(ACTIVE_COMPANY_KEY);
}

export async function clearActiveCompanyId(): Promise<void> {
  await SecureStore.deleteItemAsync(ACTIVE_COMPANY_KEY);
}
