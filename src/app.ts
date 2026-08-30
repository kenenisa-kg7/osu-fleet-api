import express from "express";
import type { Request, Response } from "express";
import { tripRequestSchema } from "./schemas/trip";
import { pool } from "./db";
import { requireRole } from "./middleware/require-role";
import { authenticate } from "./middleware/authenticate";
import { compare, hash } from "bcryptjs";
import jwt from "jsonwebtoken";
import { userLoginSchema, userRegistrationSchema } from "./schemas/user";

const app = express();

app.use(express.json());

app.get("/health", (_request, response) => {
  response.status(200).json({ status: "ok", service: "osu-fleet-api", version: "0.1.0" });
});

app.get(
  "/admin/fleet-summary",
  authenticate,
  requireRole("admin", "staff"),
  (_request, response) => {
    response.status(200).json({ message: "Fleet summary access granted" });
  }
);

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

app.post("/auth/register", async (request: Request, response: Response) => {
  const validation = userRegistrationSchema.safeParse(request.body);

  if (!validation.success) {
    return response.status(400).json({ message: "Invalid registration", errors: validation.error.flatten() });
  }

  const registration = validation.data;
  const passwordHash = await hash(registration.password, 12);

  const result = await pool.query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, email, role, created_at`,
    [registration.name, registration.email, passwordHash, registration.role]
  );

  response.status(201).json({ message: "User registered", user: result.rows[0] });
});

app.post("/auth/login", async (request: Request, response: Response) => {
  const validation = userLoginSchema.safeParse(request.body);
  if (!validation.success) {
    return response.status(400).json({
      message: "Invalid login",
      errors: validation.error.flatten(),
    });
  }
  const { email, password } = validation.data;
  const result = await pool.query(
    `SELECT id, name, email, password_hash, role
     FROM users
     WHERE email = $1`,
    [email]
  );
  const user = result.rows[0];
  if (!user) {
    return response.status(401).json({ message: "Invalid email or password" });
  }
  const passwordMatches = await compare(password, user.password_hash);
  if (!passwordMatches) {
    return response.status(401).json({ message: "Invalid email or password" });
  }
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    console.error("JWT_SECRET is not configured");
    return response.status(500).json({ message: "Authentication is not configured" });
  }
  const token = jwt.sign(
    {
      userId: user.id,
      role: user.role,
    },
    jwtSecret,
    { expiresIn: "1h" }
  );
  return response.status(200).json({
    message: "Login successful",
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    },
  });
});

export default app;