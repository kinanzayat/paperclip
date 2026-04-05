import { Router, type Request, type Response } from "express";
import multer from "multer";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers } from "@paperclipai/db";
import { updateUserProfileSchema } from "@paperclipai/shared";
import type { StorageService } from "../storage/types.js";
import { MAX_ATTACHMENT_BYTES } from "../attachment-types.js";
import { badRequest, notFound, unauthorized } from "../errors.js";
import { assertBoard } from "./authz.js";
import {
  getAuthUserById,
  isStoredProfileImage,
  toUserProfile,
} from "../auth/profile.js";
import { logger } from "../middleware/logger.js";

const ALLOWED_AVATAR_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

type UploadedFile = {
  mimetype: string;
  buffer: Buffer;
  originalname: string;
};

function getActorUserId(req: Request): string {
  assertBoard(req);
  if (!req.actor.userId) {
    throw unauthorized("Board authentication required");
  }
  return req.actor.userId;
}

async function runSingleFileUpload(
  upload: ReturnType<typeof multer>,
  req: Request,
  res: Response,
) {
  await new Promise<void>((resolve, reject) => {
    upload.single("file")(req, res, (err: unknown) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function deleteStoredAvatarIfPresent(
  storage: StorageService,
  userId: string,
  image: string | null,
) {
  if (!image || !isStoredProfileImage(image)) return;
  try {
    await storage.deleteUserObject(userId, image);
  } catch (err) {
    logger.warn({ err, userId, objectKey: image }, "Failed to delete previous stored profile image");
  }
}

export function profileRoutes(db: Db, storage: StorageService) {
  const router = Router();
  const avatarUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
  });

  router.get("/", async (req, res) => {
    const userId = getActorUserId(req);
    const user = await getAuthUserById(db, userId);
    if (!user) throw notFound("User not found");
    res.json(toUserProfile(user, { isInstanceAdmin: Boolean(req.actor.isInstanceAdmin) }));
  });

  router.patch("/", async (req, res) => {
    const userId = getActorUserId(req);
    const body = updateUserProfileSchema.parse(req.body);
    const updated = await db
      .update(authUsers)
      .set({
        name: body.name.trim(),
        updatedAt: new Date(),
      })
      .where(eq(authUsers.id, userId))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) throw notFound("User not found");
    res.json(toUserProfile(updated, { isInstanceAdmin: Boolean(req.actor.isInstanceAdmin) }));
  });

  router.post("/avatar", async (req, res) => {
    const userId = getActorUserId(req);

    try {
      await runSingleFileUpload(avatarUpload, req, res);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `Image exceeds ${MAX_ATTACHMENT_BYTES} bytes` });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const file = (req as Request & { file?: UploadedFile }).file;
    if (!file) {
      throw badRequest("Missing file field 'file'");
    }

    const contentType = (file.mimetype || "").toLowerCase();
    if (!ALLOWED_AVATAR_CONTENT_TYPES.has(contentType)) {
      res.status(422).json({ error: `Unsupported image type: ${contentType || "unknown"}` });
      return;
    }
    if (file.buffer.length <= 0) {
      res.status(422).json({ error: "Image is empty" });
      return;
    }

    const existingUser = await getAuthUserById(db, userId);
    if (!existingUser) throw notFound("User not found");

    const stored = await storage.putUserFile({
      userId,
      namespace: "avatars",
      originalFilename: file.originalname || null,
      contentType,
      body: file.buffer,
    });

    const updated = await db
      .update(authUsers)
      .set({
        image: stored.objectKey,
        updatedAt: new Date(),
      })
      .where(eq(authUsers.id, userId))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) throw notFound("User not found");

    await deleteStoredAvatarIfPresent(storage, userId, existingUser.image);

    res.status(201).json(toUserProfile(updated, { isInstanceAdmin: Boolean(req.actor.isInstanceAdmin) }));
  });

  router.delete("/avatar", async (req, res) => {
    const userId = getActorUserId(req);
    const existingUser = await getAuthUserById(db, userId);
    if (!existingUser) throw notFound("User not found");

    await db
      .update(authUsers)
      .set({
        image: null,
        updatedAt: new Date(),
      })
      .where(eq(authUsers.id, userId));

    await deleteStoredAvatarIfPresent(storage, userId, existingUser.image);

    res.status(204).end();
  });

  router.get("/avatar/content", async (req, res, next) => {
    const userId = getActorUserId(req);
    const user = await getAuthUserById(db, userId);
    const imageKey = user?.image ?? null;
    if (!user || !imageKey || !isStoredProfileImage(imageKey)) {
      throw notFound("Avatar not found");
    }

    const object = await storage.getUserObject(userId, imageKey);
    const responseContentType = object.contentType || "application/octet-stream";
    res.setHeader("Content-Type", responseContentType);
    if (object.contentLength != null) {
      res.setHeader("Content-Length", String(object.contentLength));
    }
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", "inline; filename=\"avatar\"");

    object.stream.on("error", (err) => {
      next(err);
    });
    object.stream.pipe(res);
  });

  return router;
}
