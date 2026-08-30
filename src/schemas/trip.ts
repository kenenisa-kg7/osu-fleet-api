import { z } from "zod";

export const tripRequestSchema = z.object({
  purpose: z.string().min(1),
  origin: z.string().min(1),
  destination: z.string().min(1),
  pickupTime: z.string(),
  passengers: z.number().int().positive().max(50),
  department: z.string().min(1),
});