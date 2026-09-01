import type { NextFunction, Request, Response } from "express";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { pool } from "../db";

export type AuthenticatedUser = {
  userId: string;
  role: string;
};

export type AuthenticatedRequest = Request & {
  user?: AuthenticatedUser;
};

export async function authenticate(
  request: Request,
  response: Response,
  next: NextFunction
) {
  const authorization = request.headers.authorization;

  if (!authorization || !authorization.startsWith("Bearer ")) {
    return response.status(401).json({ message: "Authentication required" });
  }

  const token = authorization.slice("Bearer ".length).trim();
  const jwtSecret = process.env.JWT_SECRET;

  if (!jwtSecret) {
    console.error("JWT_SECRET is not configured");
    return response.status(500).json({ message: "Authentication is not configured" });
  }

  try {
    const decoded = jwt.verify(token, jwtSecret) as JwtPayload;

    if (typeof decoded.userId !== "string") {
      return response.status(401).json({ message: "Invalid token" });
    }

    const result = await pool.query(
      `SELECT id, role, is_active
       FROM users
       WHERE id = $1`,
      [decoded.userId]
    );

    const user = result.rows[0];

    if (!user || !user.is_active) {
      return response.status(401).json({ message: "Account is inactive or unavailable" });
    }

    // The database is authoritative for the current role. This means a role
    // change takes effect even if the old JWT has not expired yet.
    (request as AuthenticatedRequest).user = {
      userId: user.id,
      role: user.role,
    };

    return next();
  } catch {
    return response.status(401).json({ message: "Invalid or expired token" });
  }
}