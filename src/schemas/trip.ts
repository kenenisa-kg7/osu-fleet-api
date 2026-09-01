import { z } from "zod";

export const tripRequestSchema = z.object({
  purpose: z.string().min(1),
  origin: z.string().min(1),
  destination: z.string().min(1),
  pickupTime: z.string(),
  passengers: z.number().int().positive().max(50),
  department: z.string().min(1),
});
export const tripRequestDecisionSchema = z.object({
  status: z.enum(["approved", "rejected"]),
});
export const tripAssignmentSchema = z.object({
  driverId: z.string().uuid(),
});
export const tripProgressSchema = z.object({
  status: z.enum(["in_progress", "completed"]),
});