import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers } from "@paperclipai/db";
import type { UserProfile } from "@paperclipai/shared";

type AuthUserRow = typeof authUsers.$inferSelect;

export function isStoredProfileImage(image: string | null | undefined): boolean {
  return typeof image === "string" && image.startsWith("users/");
}

export function resolveProfileImageUrl(userId: string, image: string | null | undefined): string | null {
  if (!image) return null;
  if (isStoredProfileImage(image)) {
    return `/api/auth/profile/avatar/content`;
  }
  if (image.startsWith("http://") || image.startsWith("https://") || image.startsWith("data:") || image.startsWith("/")) {
    return image;
  }
  return image;
}

export async function getAuthUserById(db: Db, userId: string): Promise<AuthUserRow | null> {
  return db
    .select()
    .from(authUsers)
    .where(eq(authUsers.id, userId))
    .then((rows) => rows[0] ?? null);
}

export function toUserProfile(
  user: Pick<AuthUserRow, "id" | "email" | "name" | "image" | "createdAt" | "updatedAt">,
  opts: { isInstanceAdmin: boolean },
): UserProfile {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: resolveProfileImageUrl(user.id, user.image),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    isInstanceAdmin: opts.isInstanceAdmin,
  };
}
