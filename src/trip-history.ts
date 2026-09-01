import type { Pool, PoolClient } from "pg";

export async function recordTripStatusChange(
  client: Pool | PoolClient,
  input: {
    tripRequestId: string;
    changedBy?: string;
    previousStatus?: string;
    newStatus: string;
    note?: string;
  }
) {
  await client.query(
    `INSERT INTO trip_request_status_history
       (trip_request_id, changed_by, previous_status, new_status, note)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      input.tripRequestId,
      input.changedBy ?? null,
      input.previousStatus ?? null,
      input.newStatus,
      input.note ?? null,
    ]
  );
}