import type { Pool, PoolClient } from "pg";

export async function createNotification(
  client: Pool | PoolClient,
  input: {
    recipientUserId: string;
    type: string;
    title: string;
    message: string;
    tripRequestId?: string;
    vehicleId?: string;
  }
) {
  await client.query(
    `INSERT INTO notifications
       (recipient_user_id, type, title, message,
        related_trip_request_id, related_vehicle_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.recipientUserId,
      input.type,
      input.title,
      input.message,
      input.tripRequestId ?? null,
      input.vehicleId ?? null,
    ]
  );
}