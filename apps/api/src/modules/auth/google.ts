import { OAuth2Client } from 'google-auth-library';
import { env } from '../../env';
import { AppError } from '../../http/errors';

let client: OAuth2Client | null = null;

export function googleConfigured(): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID);
}

export interface GoogleIdentity {
  googleSub: string;
  email: string;
  name: string;
  emailVerified: boolean;
  avatarUrl: string | null;
}

/** Verify a Google ID token and return the identity, or throw. */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
  if (!env.GOOGLE_CLIENT_ID) {
    throw new AppError('VALIDATION', 'Google sign-in is not configured');
  }
  client ??= new OAuth2Client(env.GOOGLE_CLIENT_ID);

  let payload;
  try {
    const ticket = await client.verifyIdToken({ idToken, audience: env.GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch {
    throw new AppError('UNAUTHENTICATED', 'Invalid Google token');
  }

  if (!payload?.sub || !payload.email) {
    throw new AppError('UNAUTHENTICATED', 'Google token missing required claims');
  }

  return {
    googleSub: payload.sub,
    email: payload.email.toLowerCase(),
    name: payload.name ?? payload.email,
    emailVerified: payload.email_verified ?? false,
    avatarUrl: payload.picture ?? null,
  };
}
