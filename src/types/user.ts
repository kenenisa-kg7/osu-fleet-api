export const userRoles = ["admin", "staff", "driver"] as const;
export type UserRole = (typeof userRoles)[number];

export type UserRegistration = {
  name: string;
  email: string;
  password: string;
  role: UserRole;
};

export type StoredUser = Omit<UserRegistration, "password"> & {
  id: string;
  createdAt: string;
};