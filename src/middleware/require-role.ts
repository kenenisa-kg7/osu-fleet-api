import type { NextFunction, Response } from "express";
import type { AuthenticatedRequest } from "./authenticate";

export function requireRole(...allowedRoles: string[]) {
  return (
    request: AuthenticatedRequest,
    response: Response,
    next: NextFunction
  ) => {
    if (!request.user) {
      return response.status(401).json({ message: "Authentication required" });
    }

    if (!allowedRoles.includes(request.user.role)) {
      return response.status(403).json({ message: "Forbidden" });
    }

    return next();
  };
}
