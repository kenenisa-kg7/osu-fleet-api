import express from "express";
import type { Request, Response } from "express";
import { tripRequestSchema } from "./schemas/trip";
import { pool } from "./db";
import { requireRole } from "./middleware/require-role";

const app = express();

app.use(express.json());

app.get("/admin/fleet-summary", requireRole("admin", "staff"), (_request, response) => {
  response.status(200).json({ message: "Fleet summary access granted" });
});

app.post("/trip-requests", async (request: Request, response: Response) => {
  const validation = tripRequestSchema.safeParse(request.body);

  if (!validation.success) {
    return response.status(400).json({ message: "Invalid trip request", errors: validation.error.flatten() });
  }

  const trip = validation.data;

  const result = await pool.query(
    `INSERT INTO trip_requests (purpose, origin, destination, pickup_time, passengers, requested_by, department)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, purpose, origin, destination, pickup_time, passengers, requested_by, department, status, created_at`,
    [trip.purpose, trip.origin, trip.destination, trip.pickupTime, trip.passengers, trip.requestedBy, trip.department]
  );

  response.status(201).json({ message: "Trip request created", tripRequest: result.rows[0] });
});

export default app;