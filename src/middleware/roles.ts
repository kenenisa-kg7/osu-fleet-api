import type { UserRole } from "../types/user";

export const roles = {
  admin: "admin",
  staff: "staff",
  driver: "driver",
} as const satisfies Record<string, UserRole>;

export type { UserRole };