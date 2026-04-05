import { z } from "zod";

export const updateUserProfileSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

export type UpdateUserProfile = z.infer<typeof updateUserProfileSchema>;
