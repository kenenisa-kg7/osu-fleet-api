import { z } from "zod";

export const vehicleCreationSchema = z.object({
  registrationNumber: z.string().trim().min(2).max(30),
  make: z.string().trim().min(2).max(80),
  model: z.string().trim().min(1).max(80),
  manufactureYear: z.number().int().min(1950).max(new Date().getFullYear()).optional(),
  capacity: z.number().int().positive().max(100),
});

export const vehicleStatusSchema = z.object({
  status: z.enum(["available", "maintenance", "inactive"]),
});
export const maintenanceRecordSchema = z.object({
  maintenanceType: z.enum(["inspection", "service", "repair", "accident"]),
  description: z.string().trim().min(3).max(1000),
  performedAt: z.coerce.date(),
  mileage: z.number().int().nonnegative().optional(),
  cost: z.number().nonnegative().optional(),
});