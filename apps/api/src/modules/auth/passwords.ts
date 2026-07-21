import bcrypt from 'bcryptjs';

// Spec §5: bcrypt cost 12. bcryptjs is wire-compatible and needs no native build.
const COST = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
