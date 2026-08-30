import { z } from "zod";
import { userRoles } from "../types/user";

export const userRegistrationSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(userRoles),
});

export const userLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});