import 'dotenv/config';
import { pool } from '../../db';

async function main() {
  const email = (process.argv[2] ?? process.env.SUPER_ADMIN_EMAIL ?? '').trim().toLowerCase();
  if (!email) throw new Error('Usage: pnpm --filter @crewquo/api grant-super-admin -- user@example.com');

  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await client.query<{
      id: string;
      is_super_admin: boolean;
      email_verified_at: Date | null;
    }>(
      `select id, is_super_admin, email_verified_at from users where lower(email) = $1 for update`,
      [email]
    );
    const user = result.rows[0];
    if (!user) throw new Error(`No CrewQuo user exists for ${email}`);
    if (!user.email_verified_at) {
      throw new Error(`${email} must verify its email before receiving platform access`);
    }
    await client.query(
      `update users set is_super_admin = true, updated_at = now() where id = $1`,
      [user.id]
    );
    await client.query(
      `insert into platform_audit_logs
         (actor_user_id, action, entity_type, entity_id, changes, description)
       values (null, 'user.super_admin_granted', 'USER', $1, $2, $3)`,
      [
        user.id,
        JSON.stringify({ from: user.is_super_admin, to: true, source: 'grant-super-admin CLI' }),
        `Bootstrap super-admin access granted to ${email}`,
      ]
    );
    await client.query('commit');
    console.log(`${email} is now a CrewQuo super admin.`);
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

