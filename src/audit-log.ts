import { pool } from "./db";

export async function recordAuditLog(input: {
  actorUserId: string;
  action: string;
  targetUserId?: string;
  metadata?: Record<string, unknown>;
}) {
  await pool.query(
    `INSERT INTO audit_logs
       (actor_user_id, action, target_user_id, metadata)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [
      input.actorUserId,
      input.action,
      input.targetUserId ?? null,
      JSON.stringify(input.metadata ?? {}),
    ]
  );
}