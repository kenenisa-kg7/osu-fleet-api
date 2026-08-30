import type { NextFunction, Request, Response } from "express";

type DatabaseError = Error & {
  code?: string;
};

export function errorHandler(
  error: unknown,
  _request: Request,
  response: Response,
  _next: NextFunction
) {
  const requestId = response.locals.requestId;

  console.error(`[${requestId}] Unhandled API error:`, error);

  const databaseError = error as DatabaseError;

  // PostgreSQL unique-constraint violation, commonly caused by a duplicate email.
  if (databaseError.code === "23505") {
    return response.status(409).json({
      message: "A record with that value already exists",
      requestId,
    });
  }

  return response.status(500).json({
    message: "Internal server error",
    requestId,
  });
}