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
  (_request, response) => {
    response.status(200).json({ message: "Fleet summary access granted" });
  }
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
           (purpose, origin, destination, pickup_time, passengers, requested_by, department, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, purpose, origin, destination, pickup_time, passengers,
                   requested_by, department, status, created_at`,
        [
          trip.purpose,
          trip.origin,
          trip.destination,
          trip.pickupTime,
          trip.passengers,
          authenticatedRequest.user.userId,
          trip.department,
          "pending",
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
      },
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

    const tripRequest = await withTransaction(async (client) => {
      const result = await client.query(
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
      const updated = result.rows[0];
      if (!updated) return null;

      await recordTripStatusChange(client, {
        tripRequestId: updated.id,
        changedBy: authenticatedRequest.user!.userId,
        previousStatus: "approved",
        newStatus: "assigned",
        note: `Assigned to ${driver.name}`,
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
        message: "Only approved trip requests can be assigned",
        status: existing.rows[0].status,
      });
    }

    return response.status(200).json({
      message: "Trip request assigned",
      tripRequest,
      driver,
    });
  })
);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;