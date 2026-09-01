import express from "express";
import type { Request, Response } from "express";
import { tripRequestSchema } from "./schemas/trip";
import { pool } from "./db";
import { requireRole } from "./middleware/require-role";
import { authenticate, type AuthenticatedRequest } from "./middleware/authenticate";
import { compare, hash } from "bcryptjs";
import jwt from "jsonwebtoken";
import { userLoginSchema, userRegistrationSchema } from "./schemas/user";
import { errorHandler } from "./middleware/error-handler";
import { asyncHandler } from "./middleware/async-handler";
import { notFoundHandler } from "./middleware/not-found";
import { requestIdMiddleware } from "./middleware/request-id";
import helmet from "helmet";
import cors from "cors";
import { authRateLimit } from "./middleware/auth-rate-limit";
import { roles } from "./middleware/roles";
import { adminUserCreationSchema } from "./schemas/user";
import { roles } from "./middleware/roles";
import { userStatusSchema } from "./schemas/user";
import { userRoleSchema } from "./schemas/user";
import { recordAuditLog } from "./audit-log";

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

    const result = await pool.query(
      `INSERT INTO trip_requests (purpose, origin, destination, pickup_time, passengers, requested_by, department)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, purpose, origin, destination, pickup_time, passengers, requested_by, department, status, created_at`,
      [trip.purpose, trip.origin, trip.destination, trip.pickupTime, trip.passengers, authenticatedRequest.user.userId, trip.department]
    );

    response.status(201).json({ message: "Trip request created", tripRequest: result.rows[0] });
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
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, role, created_at`,
      [userData.name, userData.email, passwordHash, userData.role]
    );
    return response.status(201).json({
      message: "User created",
      user: result.rows[0],
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
    const authenticatedRequest = request as AuthenticatedRequest;
await recordAuditLog({
  actorUserId: authenticatedRequest.user!.userId,
  action: "user.created",
  targetUserId: user.id,
  metadata: {
    role: user.role,
  },
});

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
    const result = await pool.query(
      `UPDATE users
       SET is_active = $1
       WHERE id = $2
       RETURNING id, name, email, role, is_active, created_at`,
      [validation.data.isActive, userId]
    );
    const user = result.rows[0];
    const authenticatedRequest = request as AuthenticatedRequest;
await recordAuditLog({
  actorUserId: authenticatedRequest.user!.userId,
  action: "user.status_updated",
  targetUserId: user.id,
  metadata: {
    isActive: user.is_active,
  },
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
    const result = await pool.query(
      `UPDATE users
       SET role = $1
       WHERE id = $2
       RETURNING id, name, email, role, is_active, created_at`,
      [validation.data.role, userId]
    );
    const user = result.rows[0];
    const authenticatedRequest = request as AuthenticatedRequest;
await recordAuditLog({
  actorUserId: authenticatedRequest.user!.userId,
  action: "user.role_updated",
  targetUserId: user.id,
  metadata: {
    role: user.role,
  },
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

app.use(notFoundHandler);
app.use(errorHandler);

export default app;