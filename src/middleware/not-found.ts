import type { Request, Response } from "express";

export function notFoundHandler(request: Request, response: Response) {
  return response.status(404).json({
    message: "Route not found",
    path: request.originalUrl,
  });
}