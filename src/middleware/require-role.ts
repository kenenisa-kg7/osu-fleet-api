import type { Request, Response, NextFunction } from "express";
import type { UserRole } from "../types/user";
import { userRoles } from "../types/user";

export function requireRole(...allowedRoles: UserRole[]) {
  return (request: Request, response: Response, next: NextFunction) => {
    const roleFromHeader = request.header("x-user-role");

    if (!roleFromHeader || !userRoles.includes(roleFromHeader as UserRole)) {
      return response.status(401).json({ message: "Missing or invalid role header" });
    }

    if (!allowedRoles.includes(roleFromHeader as UserRole)) {
      return response.status(403).json({ message: "You don't have permission to do that" });
    }

    next();
  };
}