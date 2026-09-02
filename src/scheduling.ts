import type { Pool, PoolClient } from "pg";

export async function vehicleHasConflict(
  client: Pool | PoolClient,
  vehicleId: string,
  pickupTime: Date,
  durationMinutes: number,
  excludeTripId?: string
) {
  const result = await client.query(
    `SELECT id
     FROM trip_requests
     WHERE vehicle_id = $1
       AND status IN ('assigned', 'in_progress')
       AND pickup_time < $2 + ($3 * INTERVAL '1 minute')
       AND pickup_time + (duration_minutes * INTERVAL '1 minute') > $2
       AND ($4::uuid IS NULL OR id <> $4::uuid)
     LIMIT 1`,
    [vehicleId, pickupTime, durationMinutes, excludeTripId ?? null]
  );

  return Boolean(result.rows[0]);
}

export async function driverHasConflict(
  client: Pool | PoolClient,
  driverId: string,
  pickupTime: Date,
  durationMinutes: number,
  excludeTripId?: string
) {
  const result = await client.query(
    `SELECT id
     FROM trip_requests
     WHERE driver_id = $1
       AND status IN ('assigned', 'in_progress')
       AND pickup_time < $2 + ($3 * INTERVAL '1 minute')
       AND pickup_time + (duration_minutes * INTERVAL '1 minute') > $2
       AND ($4::uuid IS NULL OR id <> $4::uuid)
     LIMIT 1`,
    [driverId, pickupTime, durationMinutes, excludeTripId ?? null]
  );

  return Boolean(result.rows[0]);
}