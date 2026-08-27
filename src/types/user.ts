export const userRoles = ["admin", "staff", "driver"] as const;
export type UserRole = (typeof userRoles)[number];