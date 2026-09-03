import express from "express";
import type { Request, Response } from "express";
import { tripRequestSchema, tripProgressSchema } from "./schemas/trip";
import { pool, withTransaction } from "./db";
import { requireRole } from "./middleware/require-role";
import { authenticate, type AuthenticatedRequest } from "./middleware/authenticate";
import { compare, hash } from "bcryptjs";
import jwt from "jsonwebtoken";
import { userLoginSchema, userRegistrationSchema, adminUserCreationSchema, userStatusSchema, userRoleSchema } from "./schemas/user";
import { errorHandler } from "./middleware/error-handler";
import { asyncHandler } from "./middleware/async-handler";
import { notFoundHandler } from "./middleware/not-found";
import { requestIdMiddleware } from "./middleware/request-id";
import helmet from "helmet";
import cors from "cors";
import { authRateLimit } from "./middleware/auth-rate-limit";
import { roles } from "./middleware/roles";
import { recordAuditLog } from "./audit-log";
import { tripRequestDecisionSchema } from "./schemas/trip";
import { tripAssignmentSchema } from "./schemas/trip";
import { recordTripStatusChange } from "./trip-history";
import { vehicleCreationSchema } from "./schemas/vehicle";
import { vehicleStatusSchema } from "./schemas/vehicle";
import { vehicleAssignmentSchema } from "./schemas/trip";
import { vehicleHasConflict, driverHasConflict } from "./scheduling";
import { maintenanceRecordSchema } from "./schemas/vehicle";
import { tripCompletionSchema } from "./schemas/trip";
import { z } from "zod";
import { createNotification } from "./notifications";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const app = express();

app.use(helmet());
app.use(requestIdMiddleware);

const frontendOrigin = process.env.FRONTEND_ORIGIN || "http://localhost:3000";
app.use(
  cors({
    origin: (origin, callback) => {
      // Non-browser tools such as curl do not send an Origin header.
      if (!origin || origin === frontendOrigin) {
        return callback(null, true);
      }
      return callback(new Error("Origin is not allowed by CORS"));
    },
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
    credentials: true,
  })
);

app.use(express.json());

app.get("/health", (_request, response) => {
  response.status(200).json({ status: "ok", service: "osu-fleet-api", version: "0.1.0" });
});

app.get("/health/ready", async (_request, response) => {
  try {
    await pool.query("SELECT 1");
    return response.status(200).json({
      status: "ready",
      service: "osu-fleet-api",
      database: "reachable",
    });
  } catch (error) {
    console.error("Database readiness check failed:", error);
    return response.status(503).json({
      status: "not_ready",
      service: "osu-fleet-api",
      database: "unreachable",
    });
  }
});

app.get(
  "/admin/fleet-summary",
  authenticate,
  requireRole(roles.admin, roles.staff),
  asyncHandler(async (_request: Request, response: Response) => {
    const [tripCounts, vehicleCounts, unreadCounts] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
          COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
          COUNT(*) FILTER (WHERE status = 'assigned')::int AS assigned,
          COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
          COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
          COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
        FROM trip_requests
      `),
      pool.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status = 'available')::int AS available,
          COUNT(*) FILTER (WHERE status = 'assigned')::int AS assigned,
          COUNT(*) FILTER (WHERE status = 'maintenance')::int AS maintenance,
          COUNT(*) FILTER (WHERE status = 'inactive')::int AS inactive
        FROM vehicles
      `),
      pool.query(`
        SELECT COUNT(*)::int AS unread
        FROM notifications
        WHERE is_read = FALSE
      `),
    ]);
    return response.status(200).json({
      generatedAt: new Date().toISOString(),
      trips: tripCounts.rows[0],
      vehicles: vehicleCounts.rows[0],
      notifications: unreadCounts.rows[0],
    });
  })
);

app.get(
  "/trip-requests",
  authenticate,
  requireRole(roles.admin, roles.staff),
  asyncHandler(async (request: Request, response: Response) => {
    const authenticatedRequest = request as AuthenticatedRequest;
    const userId = authenticatedRequest.user!.userId;
    const requestedPage = Number(request.query.page ?? 1);
    const requestedLimit = Number(request.query.limit ?? 20);
    const page = Number.isInteger(requestedPage) && requestedPage > 0
      ? requestedPage
      : 1;
    const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 100)
      : 20;
    const offset = (page - 1) * limit;
    const [requestsResult, countResult] = await Promise.all([
      pool.query(
        `SELECT id, purpose, origin, destination, pickup_time,
                passengers, requested_by, department, status, created_at
         FROM trip_requests
         WHERE requested_by = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total
         FROM trip_requests
         WHERE requested_by = $1`,
        [userId]
      ),
    ]);
    const total = countResult.rows[0].total;
    return response.status(200).json({
      tripRequests: requestsResult.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  })
);

app.get(
  "/driver/trip-requests",
  authenticate,
  requireRole(roles.driver),
  asyncHandler(async (request: Request, response: Response) => {
    const authenticatedRequest = request as AuthenticatedRequest;
    const driverId = authenticatedRequest.user!.userId;
    const requestedPage = Number(request.query.page ?? 1);
    const requestedLimit = Number(request.query.limit ?? 20);
    const page = Number.isInteger(requestedPage) && requestedPage > 0
      ? requestedPage
      : 1;
    const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 100)
      : 20;
    const offset = (page - 1) * limit;
    const [tripsResult, countResult] = await Promise.all([
      pool.query(
        `SELECT tr.id, tr.purpose, tr.origin, tr.destination,
                tr.pickup_time, tr.passengers, tr.requested_by,
                tr.department, tr.status, tr.driver_id,
                tr.assigned_at, tr.created_at,
                u.name AS requester_name,
                u.email AS requester_email
         FROM trip_requests tr
        JOIN users u ON u.id::text = tr.requested_by
         WHERE tr.driver_id = $1
         ORDER BY tr.pickup_time ASC
         LIMIT $2 OFFSET $3`,
        [driverId, limit, offset]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total
         FROM trip_requests
         WHERE driver_id = $1`,
        [driverId]
      ),
    ]);
    const total = countResult.rows[0].total;
    return response.status(200).json({
      tripRequests: tripsResult.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  })
);

app.patch(
  "/driver/trip-requests/:tripId/status",
  authenticate,
  requireRole(roles.driver),
  asyncHandler(async (request: Request, response: Response) => {
    const authenticatedRequest = request as AuthenticatedRequest;
    const driverId = authenticatedRequest.user!.userId;
    const tripId = request.params.tripId;

    if (!UUID_PATTERN.test(tripId)) {
      return response.status(400).json({ message: "Invalid trip ID" });
    }

    const validation = tripProgressSchema.safeParse(request.body);

    if (!validation.success) {
      return response.status(400).json({
        message: "Invalid trip progress",
        errors: validation.error.flatten(),
      });
    }

    const currentStatus = validation.data.status === "in_progress"
      ? "assigned"
      : "in_progress";

    const result = await pool.query(
      `UPDATE trip_requests
       SET status = $1
       WHERE id = $2
         AND driver_id = $3
         AND status = $4
       RETURNING id, purpose, origin, destination, pickup_time,
                 passengers, requested_by, department, status,
                 driver_id, assigned_at, created_at`,
      [validation.data.status, tripId, driverId, currentStatus]
    );

    const tripRequest = result.rows[0];

    if (!tripRequest) {
      const existing = await pool.query(
        `SELECT id, driver_id, status
         FROM trip_requests
         WHERE id = $1`,
        [tripId]
      );

      if (!existing.rows[0]) {
        return response.status(404).json({ message: "Trip request not found" });
      }

      if (existing.rows[0].driver_id !== driverId) {
        return response.status(403).json({ message: "Trip is assigned to another driver" });
      }

      return response.status(409).json({
        message: `Trip must be ${currentStatus} before this update`,
        status: existing.rows[0].status,
      });
    }

    return response.status(200).json({
      message: "Trip progress updated",
      tripRequest,
    });
  })
);
app.patch(
  "/driver/trip-requests/:tripId/complete",
  authenticate,
  requireRole(roles.driver),
  asyncHandler(async (request: Request, response: Response) => {
    const authenticatedRequest = request as AuthenticatedRequest;
    const driverId = authenticatedRequest.user!.userId;
    const tripId = request.params.tripId;

    if (!UUID_PATTERN.test(tripId)) {
      return response.status(400).json({ message: "Invalid trip ID" });
    }

    const validation = tripCompletionSchema.safeParse(request.body);

    if (!validation.success) {
      return response.status(400).json({
        message: "Invalid completion data",
        errors: validation.error.flatten(),
      });
    }

    const result = await withTransaction(async (client) => {
      const tripResult = await client.query(
        `SELECT id, driver_id, vehicle_id, status, start_mileage
         FROM trip_requests
         WHERE id = $1
         FOR UPDATE`,
        [tripId]
      );

      const trip = tripResult.rows[0];

      if (!trip) {
        return { error: "not_found" as const };
      }

      if (trip.driver_id !== driverId) {
        return { error: "not_assigned_to_driver" as const };
      }

      if (trip.status !== "in_progress") {
        return {
          error: "invalid_status" as const,
          status: trip.status,
        };
      }

      if (
        trip.start_mileage !== null &&
        validation.data.endMileage < trip.start_mileage
      ) {
        return { error: "mileage_decreased" as const };
      }

      const updatedTripResult = await client.query(
        `UPDATE trip_requests
         SET status = 'completed',
             end_mileage = $1,
             completion_notes = $2,
             completed_at = NOW()
         WHERE id = $3
         RETURNING id, purpose, origin, destination, pickup_time,
                   passengers, requested_by, department, status,
                   vehicle_id, driver_id, start_mileage,
                   end_mileage, completion_notes, completed_at, created_at`,
        [
          validation.data.endMileage,
          validation.data.completionNotes ?? null,
          tripId,
        ]
      );

      if (trip.vehicle_id) {
        await client.query(
          `UPDATE vehicles
           SET status = 'available', updated_at = NOW()
           WHERE id = $1 AND status = 'assigned'`,
          [trip.vehicle_id]
        );
      }

      return { tripRequest: updatedTripResult.rows[0] };
    });

    if (result.error === "not_found") {
      return response.status(404).json({ message: "Trip request not found" });
    }

    if (result.error === "not_assigned_to_driver") {
      return response.status(403).json({ message: "Trip is assigned to another driver" });
    }

    if (result.error === "invalid_status") {
      return response.status(409).json({
        message: "Only in-progress trips can be completed",
        status: result.status,
      });
    }

    if (result.error === "mileage_decreased") {
      return response.status(400).json({
        message: "End mileage cannot be less than start mileage",
      });
    }

    return response.status(200).json({
      message: "Trip completed",
      tripRequest: result.tripRequest,
    });
  })
);
app.get(
  "/trip-requests/:tripId",
  authenticate,
  requireRole(roles.admin, roles.staff, roles.driver),
  asyncHandler(async (request: Request, response: Response) => {
    const authenticatedRequest = request as AuthenticatedRequest;
    const user = authenticatedRequest.user!;
    const tripId = request.params.tripId;

    if (!UUID_PATTERN.test(tripId)) {
      return response.status(400).json({ message: "Invalid trip ID" });
    }

    const result = await pool.query(
      `SELECT tr.id, tr.purpose, tr.origin, tr.destination,
              tr.pickup_time, tr.passengers, tr.requested_by,
              tr.department, tr.status, tr.driver_id,
              tr.assigned_at, tr.created_at,
              requester.name AS requester_name,
              requester.email AS requester_email,
              driver.name AS driver_name,
              driver.email AS driver_email
       FROM trip_requests tr
       JOIN users requester ON requester.id::text = tr.requested_by
       LEFT JOIN users driver ON driver.id = tr.driver_id
       WHERE tr.id = $1
         AND (
           $2 = 'admin'
           OR ( $2 = 'staff' AND tr.requested_by = $3 )
           OR ( $2 = 'driver' AND tr.driver_id = $3::uuid )
         )`,
      [tripId, user.role, user.userId]
    );

    const tripRequest = result.rows[0];

    if (!tripRequest) {
      return response.status(404).json({ message: "Trip request not found" });
    }

    const historyResult = await pool.query(
      `SELECT h.id, h.previous_status, h.new_status,
              h.note, h.created_at,
              u.name AS changed_by_name
       FROM trip_request_status_history h
       LEFT JOIN users u ON u.id = h.changed_by
       WHERE h.trip_request_id = $1
       ORDER BY h.created_at ASC`,
      [tripRequest.id]
    );

    return response.status(200).json({
      tripRequest,
      statusHistory: historyResult.rows,
    });
  })
);

app.post(
  "/trip-requests",
  authenticate,
  requireRole(roles.admin, roles.staff),
  asyncHandler(async (request: Request, response: Response) => {
    const validation = tripRequestSchema.safeParse(request.body);

    if (!validation.success) {
      return response.status(400).json({ message: "Invalid trip request", errors: validation.error.flatten() });
    }

    const authenticatedRequest = request as AuthenticatedRequest;
    if (!authenticatedRequest.user) {
      return response.status(401).json({ message: "Authentication required" });
    }

    const trip = validation.data;

    const tripRequest = await withTransaction(async (client) => {
  const result = await client.query(
    `INSERT INTO trip_requests
       (purpose, origin, destination, pickup_time, passengers, requested_by, department, status, duration_minutes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, purpose, origin, destination, pickup_time, passengers,
               requested_by, department, status, duration_minutes, created_at`,
    [
      trip.purpose,
      trip.origin,
      trip.destination,
      trip.pickupTime,
      trip.passengers,
      authenticatedRequest.user.userId,
      trip.department,
      "pending",
      trip.durationMinutes,
    ]
  );
  const created = result.rows[0];

  await recordTripStatusChange(client, {
    tripRequestId: created.id,
    changedBy: authenticatedRequest.user!.userId,
    previousStatus: undefined,
    newStatus: "pending",
    note: "Trip request created",
  });

  return created;
});

    response.status(201).json({ message: "Trip request created", tripRequest });
  })
);
app.patch(
  "/trip-requests/:tripId/cancel",
  authenticate,
  requireRole(roles.admin, roles.staff),
  asyncHandler(async (request: Request, response: Response) => {
    const authenticatedRequest = request as AuthenticatedRequest;
    const userId = authenticatedRequest.user!.userId;
    const tripId = request.params.tripId;
    const isAdmin = authenticatedRequest.user!.role === roles.admin;

    if (!UUID_PATTERN.test(tripId)) {
      return response.status(400).json({ message: "Invalid trip ID" });
    }

    const allowedStates = isAdmin
      ? ["pending", "approved", "assigned"]
      : ["pending"];

    const result = await pool.query(
      `UPDATE trip_requests
       SET status = 'cancelled'
       WHERE id = $1
         AND status = ANY($2::text[])
         AND ($3::boolean = TRUE OR requested_by = $4)
       RETURNING id, purpose, origin, destination, pickup_time,
                 passengers, requested_by, department, status,
                 driver_id, assigned_at, created_at`,
      [tripId, allowedStates, isAdmin, userId]
    );

    const tripRequest = result.rows[0];

    if (!tripRequest) {
      const existing = await pool.query(
        `SELECT id, requested_by, status
         FROM trip_requests
         WHERE id = $1`,
        [tripId]
      );

      if (!existing.rows[0]) {
        return response.status(404).json({ message: "Trip request not found" });
      }

      if (!isAdmin && existing.rows[0].requested_by !== userId) {
        return response.status(403).json({ message: "You cannot cancel this trip request" });
      }

      return response.status(409).json({
        message: "Trip request cannot be cancelled from its current state",
        status: existing.rows[0].status,
      });
    }

    return response.status(200).json({
      message: "Trip request cancelled",
      tripRequest,
    });
  })
);

app.post(
  "/auth/register",
  authRateLimit,
  asyncHandler(async (request: Request, response: Response) => {
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
      [registration.name, registration.email, passwordHash, "staff"]
    );

    response.status(201).json({ message: "User registered", user: result.rows[0] });
  })
);

app.post(
  "/auth/login",
  authRateLimit,
  asyncHandler(async (request: Request, response: Response) => {
    const validation = userLoginSchema.safeParse(request.body);
    if (!validation.success) {
      return response.status(400).json({
        message: "Invalid login",
        errors: validation.error.flatten(),
      });
    }
    const { email, password } = validation.data;
    const result = await pool.query(
      `SELECT id, name, email, password_hash, role, is_active
       FROM users
       WHERE email = $1`,
      [email]
    );
    const user = result.rows[0];
    if (!user) {
      return response.status(401).json({ message: "Invalid email or password" });
    }
    if (!user.is_active) {
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
  })
);

app.get(
  "/auth/me",
  authenticate,
  asyncHandler(async (request: Request, response: Response) => {
    const authenticatedRequest = request as AuthenticatedRequest;
    if (!authenticatedRequest.user) {
      return response.status(401).json({ message: "Authentication required" });
    }
    const result = await pool.query(
      `SELECT id, name, email, role, created_at
       FROM users
       WHERE id = $1`,
      [authenticatedRequest.user.userId]
    );
    const user = result.rows[0];
    if (!user) {
      return response.status(404).json({ message: "User not found" });
    }
    return response.status(200).json({ user });
  })
);

app.post("/auth/logout", (_request: Request, response: Response) => {
  return response.status(200).json({
    message: "Logout successful. Remove the token from the client.",
  });
});

app.post(
  "/admin/users",
  authenticate,
  requireRole(roles.admin),
  asyncHandler(async (request: Request, response: Response) => {
    const validation = adminUserCreationSchema.safeParse(request.body);
    if (!validation.success) {
      return response.status(400).json({
        message: "Invalid user data",
        errors: validation.error.flatten(),
      });
    }
    const userData = validation.data;
    const passwordHash = await hash(userData.password, 12);
    const authenticatedRequest = request as AuthenticatedRequest;

    const user = await withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO users (name, email, password_hash, role)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, email, role, created_at`,
        [userData.name, userData.email, passwordHash, userData.role]
      );
      const createdUser = result.rows[0];

      await recordAuditLog(
        {
          actorUserId: authenticatedRequest.user!.userId,
          action: "user.created",
          targetUserId: createdUser.id,
          metadata: { role: createdUser.role },
        },
        client
      );

      return createdUser;
    });

    return response.status(201).json({
      message: "User created",
      user,
    });
  })
);

app.get(
  "/admin/trip-requests",
  authenticate,
  requireRole(roles.admin),
  asyncHandler(async (request: Request, response: Response) => {
    const requestedPage = Number(request.query.page ?? 1);
    const requestedLimit = Number(request.query.limit ?? 20);
    const requestedStatus = request.query.status;
    const requestedDepartment = request.query.department;
    const requestedDestination = request.query.destination;
    const requestedRequester = request.query.requester;
    const requestedFrom = request.query.from;
    const requestedTo = request.query.to;

    const page = Number.isInteger(requestedPage) && requestedPage > 0
      ? requestedPage
      : 1;
    const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 100)
      : 20;

    const allowedStatuses = [
      "pending",
      "approved",
      "rejected",
      "assigned",
      "in_progress",
      "completed",
      "cancelled",
    ];
    if (
      typeof requestedStatus === "string" &&
      !allowedStatuses.includes(requestedStatus)
    ) {
      return response.status(400).json({ message: "Invalid trip status filter" });
    }

    const conditions: string[] = [];
    const values: unknown[] = [];

    if (typeof requestedStatus === "string" && requestedStatus.length > 0) {
      values.push(requestedStatus);
      conditions.push(`tr.status = $${values.length}`);
    }

    if (typeof requestedDepartment === "string" && requestedDepartment.trim()) {
      values.push(`%${requestedDepartment.trim()}%`);
      conditions.push(`tr.department ILIKE $${values.length}`);
    }

    if (typeof requestedDestination === "string" && requestedDestination.trim()) {
      values.push(`%${requestedDestination.trim()}%`);
      conditions.push(`tr.destination ILIKE $${values.length}`);
    }

    if (typeof requestedRequester === "string" && requestedRequester.trim()) {
      values.push(`%${requestedRequester.trim()}%`);
      conditions.push(
        `(u.name ILIKE $${values.length} OR u.email ILIKE $${values.length})`
      );
    }

    if (typeof requestedFrom === "string" && requestedFrom.trim()) {
      const fromDate = new Date(requestedFrom);
      if (Number.isNaN(fromDate.getTime())) {
        return response.status(400).json({ message: "Invalid from date" });
      }
      values.push(fromDate);
      conditions.push(`tr.pickup_time >= $${values.length}`);
    }

    if (typeof requestedTo === "string" && requestedTo.trim()) {
      const toDate = new Date(requestedTo);
      if (Number.isNaN(toDate.getTime())) {
        return response.status(400).json({ message: "Invalid to date" });
      }
      values.push(toDate);
      conditions.push(`tr.pickup_time <= $${values.length}`);
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    const offset = (page - 1) * limit;
    const limitParameter = values.length + 1;
    const offsetParameter = values.length + 2;

    const [requestsResult, countResult] = await Promise.all([
      pool.query(
        `SELECT tr.id, tr.purpose, tr.origin, tr.destination,
                tr.pickup_time, tr.passengers, tr.requested_by,
                tr.department, tr.status, tr.created_at,
                u.name AS requester_name,
                u.email AS requester_email
         FROM trip_requests tr
         JOIN users u ON u.id::text = tr.requested_by
         ${whereClause}
         ORDER BY tr.created_at DESC
         LIMIT $${limitParameter} OFFSET $${offsetParameter}`,
        [...values, limit, offset]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total
         FROM trip_requests tr
         JOIN users u ON u.id::text = tr.requested_by
         ${whereClause}`,
        values
      ),
    ]);

    const total = countResult.rows[0].total;

    return response.status(200).json({
      tripRequests: requestsResult.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
      filters: {
        status: typeof requestedStatus === "string" ? requestedStatus : null,
        department: typeof requestedDepartment === "string" ? requestedDepartment.trim() : null,
        destination: typeof requestedDestination === "string" ? requestedDestination.trim() : null,
        requester: typeof requestedRequester === "string" ? requestedRequester.trim() : null,
        from: typeof requestedFrom === "string" ? requestedFrom : null,
        to: typeof requestedTo === "string" ? requestedTo : null,
      },
    });
  })
);
app.get(
  "/admin/vehicles",
  authenticate,
  requireRole(roles.admin),
  asyncHandler(async (request: Request, response: Response) => {
    const requestedPage = Number(request.query.page ?? 1);
    const requestedLimit = Number(request.query.limit ?? 20);
    const requestedStatus = request.query.status;
    const page = Number.isInteger(requestedPage) && requestedPage > 0
      ? requestedPage
      : 1;
    const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 100)
      : 20;
    const allowedStatuses = [
      "available",
      "assigned",
      "maintenance",
      "inactive",
    ];
    if (
      typeof requestedStatus === "string" &&
      !allowedStatuses.includes(requestedStatus)
    ) {
      return response.status(400).json({ message: "Invalid vehicle status filter" });
    }
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (typeof requestedStatus === "string" && requestedStatus.length > 0) {
      values.push(requestedStatus);
      conditions.push(`status = $${values.length}`);
    }
    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(" AND ")}`
      : "";
    const offset = (page - 1) * limit;
    const limitParameter = values.length + 1;
    const offsetParameter = values.length + 2;
    const [vehiclesResult, countResult] = await Promise.all([
      pool.query(
        `SELECT id, registration_number, make, model,
                manufacture_year, capacity, status,
                created_at, updated_at
         FROM vehicles
         ${whereClause}
         ORDER BY registration_number ASC
         LIMIT $${limitParameter} OFFSET $${offsetParameter}`,
        [...values, limit, offset]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total
         FROM vehicles
         ${whereClause}`,
        values
      ),
    ]);
    const total = countResult.rows[0].total;
    return response.status(200).json({
      vehicles: vehiclesResult.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
      filters: {
        status: typeof requestedStatus === "string" ? requestedStatus : null,
      },
    });
  })
);
app.get(
  "/admin/trip-requests/:tripId/history",
  authenticate,
  requireRole(roles.admin),
  asyncHandler(async (request: Request, response: Response) => {
    const tripId = request.params.tripId;

    if (!UUID_PATTERN.test(tripId)) {
      return response.status(400).json({ message: "Invalid trip ID" });
    }

    const requestedPage = Number(request.query.page ?? 1);
    const requestedLimit = Number(request.query.limit ?? 20);
    const page = Number.isInteger(requestedPage) && requestedPage > 0
      ? requestedPage
      : 1;
    const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 100)
      : 20;
    const offset = (page - 1) * limit;

    const [historyResult, countResult] = await Promise.all([
      pool.query(
        `SELECT h.id, h.trip_request_id, h.previous_status,
                h.new_status, h.note, h.created_at,
                u.id AS changed_by,
                u.name AS changed_by_name,
                u.email AS changed_by_email
         FROM trip_request_status_history h
         LEFT JOIN users u ON u.id = h.changed_by
         WHERE h.trip_request_id = $1
         ORDER BY h.created_at ASC
         LIMIT $2 OFFSET $3`,
        [tripId, limit, offset]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total
         FROM trip_request_status_history
         WHERE trip_request_id = $1`,
        [tripId]
      ),
    ]);

    const total = countResult.rows[0].total;

    return response.status(200).json({
      tripRequestId: tripId,
      history: historyResult.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  })
);

app.post(
  "/admin/vehicles",
  authenticate,
  requireRole(roles.admin),
  asyncHandler(async (request: Request, response: Response) => {
    const validation = vehicleCreationSchema.safeParse(request.body);

    if (!validation.success) {
      return response.status(400).json({
        message: "Invalid vehicle data",
        errors: validation.error.flatten(),
      });
    }

    const vehicle = validation.data;

    const result = await pool.query(
      `INSERT INTO vehicles
         (registration_number, make, model, manufacture_year, capacity)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, registration_number, make, model,
                 manufacture_year, capacity, status, created_at, updated_at`,
      [
        vehicle.registrationNumber,
        vehicle.make,
        vehicle.model,
        vehicle.manufactureYear ?? null,
        vehicle.capacity,
      ]
    );

    return response.status(201).json({
      message: "Vehicle created",
      vehicle: result.rows[0],
    });
  })
);
app.post(
  "/admin/vehicles/:vehicleId/maintenance",
  authenticate,
  requireRole(roles.admin),
  asyncHandler(async (request: Request, response: Response) => {
    const vehicleId = request.params.vehicleId;

    if (!UUID_PATTERN.test(vehicleId)) {
      return response.status(400).json({ message: "Invalid vehicle ID" });
    }

    const validation = maintenanceRecordSchema.safeParse(request.body);

    if (!validation.success) {
      return response.status(400).json({
        message: "Invalid maintenance record",
        errors: validation.error.flatten(),
      });
    }

    const authenticatedRequest = request as AuthenticatedRequest;

    const vehicleResult = await pool.query(
      `SELECT id, registration_number
       FROM vehicles
       WHERE id = $1`,
      [vehicleId]
    );

    if (!vehicleResult.rows[0]) {
      return response.status(404).json({ message: "Vehicle not found" });
    }
    const maintenance = validation.data;
    const maintenanceRecord = await withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO vehicle_maintenance_records
           (vehicle_id, maintenance_type, description, performed_at,
            mileage, cost, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, vehicle_id, maintenance_type, description,
                   performed_at, mileage, cost, created_by, created_at`,
        [
          vehicleId,
          maintenance.maintenanceType,
          maintenance.description,
          maintenance.performedAt,
          maintenance.mileage ?? null,
          maintenance.cost ?? null,
          authenticatedRequest.user!.userId,
        ]
      );
      const record = result.rows[0];
      if (["repair", "accident"].includes(maintenance.maintenanceType)) {
        await client.query(
          `UPDATE vehicles
           SET status = 'maintenance', updated_at = NOW()
           WHERE id = $1
             AND status <> 'assigned'`,
          [vehicleId]
        );
      }
      return record;
    });
    return response.status(201).json({
      message: "Maintenance record created",
      maintenanceRecord,
    });
  })
);
app.get(
  "/admin/vehicles/:vehicleId/maintenance",
  authenticate,
  requireRole(roles.admin),
  asyncHandler(async (request: Request, response: Response) => {
    const vehicleId = request.params.vehicleId;

    if (!UUID_PATTERN.test(vehicleId)) {
      return response.status(400).json({ message: "Invalid vehicle ID" });
    }

    const result = await pool.query(
      `SELECT id, vehicle_id, maintenance_type, description,
              performed_at, mileage, cost, created_by, created_at
       FROM vehicle_maintenance_records
       WHERE vehicle_id = $1
       ORDER BY performed_at DESC`,
      [vehicleId]
    );

    return response.status(200).json({
      vehicleId,
      maintenanceRecords: result.rows,
    });
  })
);
app.patch(
  "/admin/vehicles/:vehicleId/status",
  authenticate,
  requireRole(roles.admin),
  asyncHandler(async (request: Request, response: Response) => {
    const vehicleId = request.params.vehicleId;

    if (!UUID_PATTERN.test(vehicleId)) {
      return response.status(400).json({ message: "Invalid vehicle ID" });
    }

    const validation = vehicleStatusSchema.safeParse(request.body);
    if (!validation.success) {
      return response.status(400).json({
        message: "Invalid vehicle status",
        errors: validation.error.flatten(),
      });
    }

    const requestedStatus = validation.data.status;

    if (["maintenance", "inactive"].includes(requestedStatus)) {
      const activeAssignment = await pool.query(
        `SELECT id
         FROM trip_requests
         WHERE driver_id IS NOT NULL
           AND status IN ('assigned', 'in_progress')
           AND vehicle_id = $1
         LIMIT 1`,
        [vehicleId]
      );
      if (activeAssignment.rows[0]) {
        return response.status(409).json({
          message: "Vehicle has an active trip assignment",
        });
      }
    }

    const result = await pool.query(
      `UPDATE vehicles
       SET status = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, registration_number, make, model,
                 manufacture_year, capacity, status,
                 created_at, updated_at`,
      [requestedStatus, vehicleId]
    );

    const vehicle = result.rows[0];
    if (!vehicle) {
      return response.status(404).json({ message: "Vehicle not found" });
    }

    return response.status(200).json({
      message: "Vehicle status updated",
      vehicle,
    });
  })
);
app.get(
  "/admin/users",
  authenticate,
  requireRole(roles.admin),
  asyncHandler(async (request: Request, response: Response) => {
    const requestedPage = Number(request.query.page ?? 1);
    const requestedLimit = Number(request.query.limit ?? 20);
    const requestedRole = request.query.role;
    const requestedSearch = request.query.search;

    const page = Number.isInteger(requestedPage) && requestedPage > 0
      ? requestedPage
      : 1;

    const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 100)
      : 20;

    const conditions: string[] = [];
    const values: unknown[] = [];

    if (typeof requestedRole === "string" && requestedRole.length > 0) {
      const validRoles = [roles.admin, roles.staff, roles.driver] as string[];

      if (!validRoles.includes(requestedRole)) {
        return response.status(400).json({
          message: "Invalid role filter",
        });
      }

      values.push(requestedRole);
      conditions.push(`role = $${values.length}`);
    }

    if (typeof requestedSearch === "string" && requestedSearch.trim().length > 0) {
      values.push(`%${requestedSearch.trim()}%`);
      conditions.push(`(name ILIKE $${values.length} OR email ILIKE $${values.length})`);
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    const offset = (page - 1) * limit;
    const dataValues = [...values, limit, offset];
    const limitParameter = values.length + 1;
    const offsetParameter = values.length + 2;

    const [usersResult, countResult] = await Promise.all([
      pool.query(
        `SELECT id, name, email, role, created_at
         FROM users
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT $${limitParameter} OFFSET $${offsetParameter}`,
        dataValues
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total
         FROM users
         ${whereClause}`,
        values
      ),
    ]);

    const total = countResult.rows[0].total;

    return response.status(200).json({
      users: usersResult.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
      filters: {
        role: typeof requestedRole === "string" ? requestedRole : null,
        search: typeof requestedSearch === "string" ? requestedSearch.trim() : null,
      },
    });
  })
);

app.patch(
  "/admin/users/:userId/status",
  authenticate,
  requireRole(roles.admin),
  asyncHandler(async (request: Request, response: Response) => {
    const userId = request.params.userId;
    if (!userId || typeof userId !== "string") {
      return response.status(400).json({ message: "Invalid user ID" });
    }
    const validation = userStatusSchema.safeParse(request.body);
    if (!validation.success) {
      return response.status(400).json({
        message: "Invalid status data",
        errors: validation.error.flatten(),
      });
    }
    const authenticatedRequest = request as AuthenticatedRequest;
    const user = await withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE users
         SET is_active = $1
         WHERE id = $2
         RETURNING id, name, email, role, is_active, created_at`,
        [validation.data.isActive, userId]
      );
      const updatedUser = result.rows[0];
      if (!updatedUser) {
        return null;
      }
      await recordAuditLog(
        {
          actorUserId: authenticatedRequest.user!.userId,
          action: "user.status_updated",
          targetUserId: updatedUser.id,
          metadata: { isActive: updatedUser.is_active },
        },
        client
      );
      return updatedUser;
    });
    if (!user) {
      return response.status(404).json({ message: "User not found" });
    }
    return response.status(200).json({
      message: "User status updated",
      user,
    });
  })
);

app.patch(
  "/admin/users/:userId/role",
  authenticate,
  requireRole(roles.admin),
  asyncHandler(async (request: Request, response: Response) => {
    const userId = request.params.userId;
    if (!userId || typeof userId !== "string") {
      return response.status(400).json({ message: "Invalid user ID" });
    }
    const validation = userRoleSchema.safeParse(request.body);
    if (!validation.success) {
      return response.status(400).json({
        message: "Invalid role data",
        errors: validation.error.flatten(),
      });
    }
    const authenticatedRequest = request as AuthenticatedRequest;
    const user = await withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE users
         SET role = $1
         WHERE id = $2
         RETURNING id, name, email, role, is_active, created_at`,
        [validation.data.role, userId]
      );
      const updatedUser = result.rows[0];
      if (!updatedUser) {
        return null;
      }
      await recordAuditLog(
        {
          actorUserId: authenticatedRequest.user!.userId,
          action: "user.role_updated",
          targetUserId: updatedUser.id,
          metadata: { role: updatedUser.role },
        },
        client
      );
      return updatedUser;
    });
    if (!user) {
      return response.status(404).json({ message: "User not found" });
    }
    return response.status(200).json({
      message: "User role updated",
      user,
    });
  })
);

app.patch(
  "/admin/trip-requests/:tripId/status",
  authenticate,
  requireRole(roles.admin),
  asyncHandler(async (request: Request, response: Response) => {
    const authenticatedRequest = request as AuthenticatedRequest;
    const tripId = request.params.tripId;
    if (!UUID_PATTERN.test(tripId)) {
      return response.status(400).json({ message: "Invalid trip ID" });
    }
    const validation = tripRequestDecisionSchema.safeParse(request.body);
    if (!validation.success) {
      return response.status(400).json({
        message: "Invalid trip decision",
        errors: validation.error.flatten(),
      });
    }

    const tripRequest = await withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE trip_requests
         SET status = $1
         WHERE id = $2 AND status = 'pending'
         RETURNING id, purpose, origin, destination, pickup_time,
                   passengers, requested_by, department, status, created_at`,
        [validation.data.status, tripId]
      );
      const updated = result.rows[0];
      if (!updated) return null;

          await recordTripStatusChange(client, {
        tripRequestId: updated.id,
        changedBy: authenticatedRequest.user!.userId,
        previousStatus: "pending",
        newStatus: updated.status,
        note: "Trip request decision recorded",
      });
      await createNotification(client, {
        recipientUserId: updated.requested_by,
        type: `trip_request_${updated.status}`,
        title: `Trip request ${updated.status}`,
        message: `Your trip request has been ${updated.status}.`,
        tripRequestId: updated.id,
      });
      return updated;
    });

    if (!tripRequest) {
      const existing = await pool.query(
        `SELECT id, status FROM trip_requests WHERE id = $1`,
        [tripId]
      );
      if (!existing.rows[0]) {
        return response.status(404).json({ message: "Trip request not found" });
      }
      return response.status(409).json({
        message: "Only pending trip requests can be decided",
        status: existing.rows[0].status,
      });
    }

    return response.status(200).json({
      message: `Trip request ${validation.data.status}`,
      tripRequest,
    });
  })
);

app.patch(
  "/admin/trip-requests/:tripId/assign",
  authenticate,
  requireRole(roles.admin),
  asyncHandler(async (request: Request, response: Response) => {
    const authenticatedRequest = request as AuthenticatedRequest;
    const tripId = request.params.tripId;

    if (!UUID_PATTERN.test(tripId)) {
      return response.status(400).json({ message: "Invalid trip ID" });
    }

    const validation = tripAssignmentSchema.safeParse(request.body);

    if (!validation.success) {
      return response.status(400).json({
        message: "Invalid driver assignment",
        errors: validation.error.flatten(),
      });
    }

    const driverResult = await pool.query(
      `SELECT id, name, email, role, is_active
       FROM users
       WHERE id = $1`,
      [validation.data.driverId]
    );

    const driver = driverResult.rows[0];

    if (!driver) {
      return response.status(404).json({ message: "Driver not found" });
    }

    if (driver.role !== roles.driver || !driver.is_active) {
      return response.status(409).json({
        message: "User is not an active driver",
      });
    }

    const assignment = await withTransaction(async (client) => {
      const tripResult = await client.query(
        `SELECT id, pickup_time, duration_minutes, status
         FROM trip_requests
         WHERE id = $1
         FOR UPDATE`,
        [tripId]
      );

      const trip = tripResult.rows[0];

      if (!trip) {
        return { error: "trip_not_found" as const };
      }

      if (trip.status !== "approved") {
        return { error: "trip_not_approved" as const, status: trip.status };
      }

      if (
        await driverHasConflict(client, driver.id, trip.pickup_time, trip.duration_minutes, trip.id)
      ) {
        return { error: "driver_schedule_conflict" as const };
      }

      const updateResult = await client.query(
        `UPDATE trip_requests
         SET driver_id = $1,
             assigned_at = NOW(),
             status = 'assigned'
         WHERE id = $2 AND status = 'approved'
         RETURNING id, purpose, origin, destination, pickup_time,
                   passengers, requested_by, department, status,
                   driver_id, assigned_at, created_at`,
        [driver.id, tripId]
      );
      const updated = updateResult.rows[0];
      if (!updated) return { error: "trip_not_approved" as const, status: trip.status };

          await recordTripStatusChange(client, {
        tripRequestId: updated.id,
        changedBy: authenticatedRequest.user!.userId,
        previousStatus: "approved",
        newStatus: "assigned",
        note: `Assigned to ${driver.name}`,
      });
      await createNotification(client, {
        recipientUserId: driver.id,
        type: "trip_assigned",
        title: "Trip assigned",
        message: "A trip has been assigned to you.",
        tripRequestId: updated.id,
      });
      return { tripRequest: updated };
    });

    if ("error" in assignment) {
      if (assignment.error === "trip_not_found") {
        return response.status(404).json({ message: "Trip request not found" });
      }
      if (assignment.error === "driver_schedule_conflict") {
        return response.status(409).json({
          message: "Driver is already scheduled for an overlapping trip",
        });
      }
      return response.status(409).json({
        message: "Only approved trip requests can be assigned",
        status: assignment.status,
      });
    }

    return response.status(200).json({
      message: "Trip request assigned",
      tripRequest: assignment.tripRequest,
      driver,
    });
  })
);
app.patch(
  "/admin/trip-requests/:tripId/vehicle",
  authenticate,
  requireRole(roles.admin),
  asyncHandler(async (request: Request, response: Response) => {
    const tripId = request.params.tripId;

    if (!UUID_PATTERN.test(tripId)) {
      return response.status(400).json({ message: "Invalid trip ID" });
    }

    const validation = vehicleAssignmentSchema.safeParse(request.body);

    if (!validation.success) {
      return response.status(400).json({
        message: "Invalid vehicle assignment",
        errors: validation.error.flatten(),
      });
    }

    const assignment = await withTransaction(async (client) => {
      const tripResult = await client.query(
  `SELECT id, passengers, pickup_time, duration_minutes, status, vehicle_id
   FROM trip_requests
   WHERE id = $1
   FOR UPDATE`,
  [tripId]
);

      const trip = tripResult.rows[0];

      if (!trip) {
        return { error: "trip_not_found" as const };
      }

      if (trip.status !== "approved") {
        return {
          error: "trip_not_approved" as const,
          status: trip.status,
        };
      }

      if (trip.vehicle_id) {
        return { error: "trip_already_has_vehicle" as const };
      }

      const vehicleResult = await client.query(
        `SELECT id, registration_number, make, model,
                capacity, status
         FROM vehicles
         WHERE id = $1
         FOR UPDATE`,
        [validation.data.vehicleId]
      );

      const vehicle = vehicleResult.rows[0];

      if (!vehicle) {
        return { error: "vehicle_not_found" as const };
      }

      if (vehicle.status !== "available") {
        return {
          error: "vehicle_unavailable" as const,
          status: vehicle.status,
        };
      }

      if (vehicle.capacity < trip.passengers) {
        return {
          error: "vehicle_capacity_too_small" as const,
          capacity: vehicle.capacity,
          passengers: trip.passengers,
        };
      }
      if (
  await vehicleHasConflict(
    client,
    vehicle.id,
    trip.pickup_time,
    trip.duration_minutes,
    trip.id
  )
) {
  return { error: "vehicle_schedule_conflict" as const };
}

      const conflictResult = await client.query(
        `SELECT id
         FROM trip_requests
         WHERE vehicle_id = $1
           AND status IN ('assigned', 'in_progress')
         LIMIT 1
         FOR UPDATE`,
        [vehicle.id]
      );

      if (conflictResult.rows[0]) {
        return { error: "vehicle_has_active_trip" as const };
      }

      const updatedTripResult = await client.query(
        `UPDATE trip_requests
         SET vehicle_id = $1
         WHERE id = $2 AND status = 'approved'
         RETURNING id, purpose, origin, destination, pickup_time,
                   passengers, requested_by, department, status,
                   vehicle_id, driver_id, created_at`,
        [vehicle.id, tripId]
      );

      await client.query(
        `UPDATE vehicles
         SET status = 'assigned', updated_at = NOW()
         WHERE id = $1`,
        [vehicle.id]
      );

      return {
        tripRequest: updatedTripResult.rows[0],
        vehicle,
      };
    });

    if ("error" in assignment) {
      if (assignment.error === "trip_not_found" || assignment.error === "vehicle_not_found") {
        return response.status(404).json({ message: "Trip request or vehicle not found" });
      }
      if (assignment.error === "vehicle_schedule_conflict") {
  return response.status(409).json({
    message: "Vehicle is already scheduled for an overlapping trip",
  });
}

      if (assignment.error === "trip_not_approved") {
        return response.status(409).json({
          message: "Only approved trip requests can receive a vehicle",
          status: assignment.status,
        });
      }

      if (assignment.error === "vehicle_capacity_too_small") {
        return response.status(409).json({
          message: "Vehicle capacity is too small for this trip",
          capacity: assignment.capacity,
          passengers: assignment.passengers,
        });
      }

      return response.status(409).json({
        message: "Vehicle is unavailable or already assigned",
      });
    }

    return response.status(200).json({
      message: "Vehicle assigned to trip request",
      tripRequest: assignment.tripRequest,
      vehicle: assignment.vehicle,
    });
  })
);
app.get(
  "/notifications",
  authenticate,
  asyncHandler(async (request: Request, response: Response) => {
    const authenticatedRequest = request as AuthenticatedRequest;
    const userId = authenticatedRequest.user!.userId;

    const result = await pool.query(
      `SELECT id, type, title, message,
              related_trip_request_id, related_vehicle_id,
              is_read, created_at
       FROM notifications
       WHERE recipient_user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [userId]
    );

    const unreadResult = await pool.query(
      `SELECT COUNT(*)::int AS unread
       FROM notifications
       WHERE recipient_user_id = $1 AND is_read = FALSE`,
      [userId]
    );

    return response.status(200).json({
      notifications: result.rows,
      unreadCount: unreadResult.rows[0].unread,
    });
  })
);

app.patch(
  "/notifications/:notificationId/read",
  authenticate,
  asyncHandler(async (request: Request, response: Response) => {
    const authenticatedRequest = request as AuthenticatedRequest;
    const userId = authenticatedRequest.user!.userId;
    const notificationId = request.params.notificationId;

    if (!UUID_PATTERN.test(notificationId)) {
      return response.status(400).json({ message: "Invalid notification ID" });
    }

    const result = await pool.query(
      `UPDATE notifications
       SET is_read = TRUE
       WHERE id = $1 AND recipient_user_id = $2
       RETURNING id, is_read`,
      [notificationId, userId]
    );

    if (!result.rows[0]) {
      return response.status(404).json({ message: "Notification not found" });
    }

    return response.status(200).json({
      message: "Notification marked as read",
      notification: result.rows[0],
    });
  })
);
app.get(
  "/admin/audit-logs",
  authenticate,
  requireRole(roles.admin),
  asyncHandler(async (request: Request, response: Response) => {
    const requestedPage = Number(request.query.page ?? 1);
    const requestedLimit = Number(request.query.limit ?? 20);
    const page = Number.isInteger(requestedPage) && requestedPage > 0
      ? requestedPage
      : 1;
    const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 100)
      : 20;
    const offset = (page - 1) * limit;

    const [logsResult, countResult] = await Promise.all([
      pool.query(
        `SELECT
           al.id, al.actor_user_id, actor.name AS actor_name, actor.email AS actor_email,
           al.action, al.target_user_id, target.name AS target_name, target.email AS target_email,
           al.metadata, al.created_at
         FROM audit_logs al
         LEFT JOIN users actor ON actor.id = al.actor_user_id
         LEFT JOIN users target ON target.id = al.target_user_id
         ORDER BY al.created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
      pool.query(`SELECT COUNT(*)::int AS total FROM audit_logs`),
    ]);

    const total = countResult.rows[0].total;

    return response.status(200).json({
      auditLogs: logsResult.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  })
);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;