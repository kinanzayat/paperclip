import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { profileRoutes } from "../routes/profile.js";
import { errorHandler } from "../middleware/index.js";

const userId = "user-1";

const baseUser: {
  id: string;
  email: string;
  name: string;
  image: string | null;
  createdAt: Date;
  updatedAt: Date;
} = {
  id: userId,
  email: "user@example.com",
  name: "Test User",
  image: null,
  createdAt: new Date("2026-04-05T00:00:00.000Z"),
  updatedAt: new Date("2026-04-05T00:00:00.000Z"),
};

const mockProfileAuth = vi.hoisted(() => ({
  getAuthUserById: vi.fn(),
  isStoredProfileImage: vi.fn(),
  toUserProfile: vi.fn(),
}));

vi.mock("../auth/profile.js", () => mockProfileAuth);

function createDbStub(updatedUser = baseUser) {
  const returning = vi.fn().mockResolvedValue([updatedUser]);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  const update = vi.fn().mockReturnValue({ set });
  return { update } as any;
}

function createStorageStub() {
  return {
    provider: "local_disk",
    putFile: vi.fn(),
    putUserFile: vi.fn(),
    getObject: vi.fn(),
    getUserObject: vi.fn(),
    headObject: vi.fn(),
    headUserObject: vi.fn(),
    deleteObject: vi.fn(),
    deleteUserObject: vi.fn(),
  } as any;
}

function createApp(opts?: {
  db?: any;
  storage?: any;
  actor?: Record<string, unknown>;
}) {
  const db = opts?.db ?? createDbStub();
  const storage = opts?.storage ?? createStorageStub();
  const actor = opts?.actor ?? {
    type: "board",
    userId,
    source: "session",
    isInstanceAdmin: false,
    companyIds: ["company-1"],
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api/auth/profile", profileRoutes(db, storage));
  app.use(errorHandler);
  return { app, db, storage };
}

describe("profile routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProfileAuth.getAuthUserById.mockResolvedValue(baseUser);
    mockProfileAuth.isStoredProfileImage.mockImplementation((image: string | null | undefined) =>
      typeof image === "string" && image.startsWith("users/"),
    );
    mockProfileAuth.toUserProfile.mockImplementation((user: any, opts: { isInstanceAdmin: boolean }) => ({
      id: user.id,
      email: user.email,
      name: user.name,
      image: user.image,
      isInstanceAdmin: opts.isInstanceAdmin,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    }));
  });

  it("returns current profile", async () => {
    const { app } = createApp();

    const res = await request(app).get("/api/auth/profile");

    expect(res.status).toBe(200);
    expect(mockProfileAuth.getAuthUserById).toHaveBeenCalledWith(expect.anything(), userId);
    expect(res.body).toMatchObject({ id: userId, email: "user@example.com" });
  });

  it("updates profile name", async () => {
    const updatedUser = { ...baseUser, name: "Updated Name", updatedAt: new Date("2026-04-05T10:00:00.000Z") };
    const db = createDbStub(updatedUser);
    const { app } = createApp({ db });

    const res = await request(app)
      .patch("/api/auth/profile")
      .send({ name: "  Updated Name  " });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: userId, name: "Updated Name" });
  });

  it("rejects unsupported avatar content type", async () => {
    const { app } = createApp();

    const res = await request(app)
      .post("/api/auth/profile/avatar")
      .attach("file", Buffer.from("hello"), {
        filename: "avatar.txt",
        contentType: "text/plain",
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/unsupported image type/i);
  });

  it("uploads avatar and stores object key", async () => {
    const storage = createStorageStub();
    storage.putUserFile.mockResolvedValue({
      provider: "local_disk",
      objectKey: "users/user-1/avatars/2026/04/05/avatar.png",
      contentType: "image/png",
      byteSize: 4,
      sha256: "abc",
      originalFilename: "avatar.png",
    });
    mockProfileAuth.getAuthUserById.mockResolvedValue({ ...baseUser, image: null });

    const updatedUser = {
      ...baseUser,
      image: "users/user-1/avatars/2026/04/05/avatar.png",
      updatedAt: new Date("2026-04-05T10:00:00.000Z"),
    };
    const db = createDbStub(updatedUser);
    const { app } = createApp({ db, storage });

    const res = await request(app)
      .post("/api/auth/profile/avatar")
      .attach("file", Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
        filename: "avatar.png",
        contentType: "image/png",
      });

    expect(res.status).toBe(201);
    expect(storage.putUserFile).toHaveBeenCalled();
    expect(res.body.image).toContain("users/user-1/avatars");
  });

  it("deletes avatar and clears stored image", async () => {
    const storage = createStorageStub();
    mockProfileAuth.getAuthUserById.mockResolvedValue({
      ...baseUser,
      image: "users/user-1/avatars/2026/04/05/avatar.png",
    });
    const db = createDbStub(baseUser);
    const { app } = createApp({ db, storage });

    const res = await request(app).delete("/api/auth/profile/avatar");

    expect(res.status).toBe(204);
    expect(storage.deleteUserObject).toHaveBeenCalledWith(
      userId,
      "users/user-1/avatars/2026/04/05/avatar.png",
    );
  });
});
