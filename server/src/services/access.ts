import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  authUsers,
  companyMemberships,
  instanceUserRoles,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  PERMISSION_KEYS,
  type CompanyApprovalRole,
  type CompanyMembershipRole,
  type PermissionKey,
  type PrincipalType,
} from "@paperclipai/shared";
import { conflict } from "../errors.js";

type MembershipRow = typeof companyMemberships.$inferSelect;
type GrantInput = {
  permissionKey: PermissionKey;
  scope?: Record<string, unknown> | null;
};

const MEMBER_IMPLICIT_PERMISSIONS = new Set<PermissionKey>(["tasks:assign"]);
const ADMIN_IMPLICIT_PERMISSIONS = new Set<PermissionKey>(PERMISSION_KEYS);

function normalizeMembershipRole(
  membershipRole: string | null | undefined,
): CompanyMembershipRole | null {
  if (membershipRole === "owner") return "admin";
  if (membershipRole === "product_owner_head" || membershipRole === "tech_team") return "admin";
  if (membershipRole === "admin" || membershipRole === "member") {
    return membershipRole;
  }
  return null;
}

function normalizeApprovalRole(
  approvalRole: string | null | undefined,
): CompanyApprovalRole | null {
  if (approvalRole === "product_owner_head" || approvalRole === "tech_team") {
    return approvalRole;
  }
  return null;
}

function normalizeApprovalRoleFromMembership(
  row: Pick<MembershipRow, "membershipRole" | "approvalRole">,
): CompanyApprovalRole | null {
  return normalizeApprovalRole(row.approvalRole) ?? normalizeApprovalRole(row.membershipRole);
}

function normalizeMembershipRow(row: MembershipRow): MembershipRow {
  return {
    ...row,
    membershipRole: normalizeMembershipRole(row.membershipRole),
    approvalRole: normalizeApprovalRoleFromMembership(row),
  };
}

function isActiveUserAdminMembership(row: Pick<MembershipRow, "principalType" | "status" | "membershipRole">): boolean {
  return (
    row.principalType === "user" &&
    row.status === "active" &&
    normalizeMembershipRole(row.membershipRole) === "admin"
  );
}

async function assertCompanyKeepsAnAdmin(
  executor: Db | any,
  companyId: string,
  membershipId: string,
  nextMembershipRole: string | null,
  nextStatus: MembershipRow["status"],
) {
  const current = await executor
    .select()
    .from(companyMemberships)
    .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.id, membershipId)))
    .then((rows: MembershipRow[]) => rows[0] ?? null);
  if (!current || !isActiveUserAdminMembership(current)) return current;

  const nextRole = normalizeMembershipRole(nextMembershipRole);
  if (current.principalType === "user" && nextStatus === "active" && nextRole === "admin") {
    return current;
  }

  const activeUserMemberships = await executor
    .select({
      id: companyMemberships.id,
      principalType: companyMemberships.principalType,
      status: companyMemberships.status,
      membershipRole: companyMemberships.membershipRole,
    })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.status, "active"),
      ),
    );

  const adminCount = activeUserMemberships.filter(isActiveUserAdminMembership).length;
  if (adminCount <= 1) {
    throw conflict("Company must keep at least one active admin");
  }

  return current;
}

export function accessService(db: Db) {
  async function isInstanceAdmin(userId: string | null | undefined): Promise<boolean> {
    if (!userId) return false;
    const row = await db
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows[0] ?? null);
    return Boolean(row);
  }

  async function getMembership(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
  ): Promise<MembershipRow | null> {
    return db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, principalType),
          eq(companyMemberships.principalId, principalId),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function hasPermission(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    permissionKey: PermissionKey,
  ): Promise<boolean> {
    const membership = await getMembership(companyId, principalType, principalId);
    if (!membership || membership.status !== "active") return false;
    const grant = await db
      .select({ id: principalPermissionGrants.id })
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, principalType),
          eq(principalPermissionGrants.principalId, principalId),
          eq(principalPermissionGrants.permissionKey, permissionKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
    return Boolean(grant);
  }

  async function canUser(
    companyId: string,
    userId: string | null | undefined,
    permissionKey: PermissionKey,
  ): Promise<boolean> {
    if (!userId) return false;
    if (await isInstanceAdmin(userId)) return true;
    const membership = await getMembership(companyId, "user", userId);
    if (!membership || membership.status !== "active") return false;

    const membershipRole = normalizeMembershipRole(membership.membershipRole);
    if (membershipRole === "admin" && ADMIN_IMPLICIT_PERMISSIONS.has(permissionKey)) {
      return true;
    }
    if (membershipRole === "member" && MEMBER_IMPLICIT_PERMISSIONS.has(permissionKey)) {
      return true;
    }

    return hasPermission(companyId, "user", userId, permissionKey);
  }

  async function isCompanyAdmin(
    companyId: string,
    userId: string | null | undefined,
  ): Promise<boolean> {
    if (!userId) return false;
    if (await isInstanceAdmin(userId)) return true;
    const membership = await getMembership(companyId, "user", userId);
    return Boolean(membership && membership.status === "active" && normalizeMembershipRole(membership.membershipRole) === "admin");
  }

  async function listMembers(companyId: string) {
    const rows = await db
      .select()
      .from(companyMemberships)
      .where(eq(companyMemberships.companyId, companyId))
      .orderBy(sql`${companyMemberships.createdAt} desc`);
    const userIds = rows
      .filter((row) => row.principalType === "user")
      .map((row) => row.principalId);
    const users = userIds.length === 0
      ? []
      : await db
        .select({
          id: authUsers.id,
          name: authUsers.name,
          email: authUsers.email,
          image: authUsers.image,
        })
        .from(authUsers)
        .where(inArray(authUsers.id, userIds));
    const userMap = new Map(users.map((user) => [user.id, user]));
    return rows.map((row) => ({
      ...normalizeMembershipRow(row),
      user: row.principalType === "user" ? (userMap.get(row.principalId) ?? null) : null,
    }));
  }

  async function listActiveUserMemberships(companyId: string) {
    const rows = await db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
        ),
      )
      .orderBy(sql`${companyMemberships.createdAt} asc`);
    return rows.map(normalizeMembershipRow);
  }

  async function setMemberPermissions(
    companyId: string,
    memberId: string,
    grants: GrantInput[],
    grantedByUserId: string | null,
  ) {
    const member = await db
      .select()
      .from(companyMemberships)
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.id, memberId)))
      .then((rows) => rows[0] ?? null);
    if (!member) return null;

    await db.transaction(async (tx) => {
      await tx
        .delete(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, companyId),
            eq(principalPermissionGrants.principalType, member.principalType),
            eq(principalPermissionGrants.principalId, member.principalId),
          ),
        );
      if (grants.length > 0) {
        await tx.insert(principalPermissionGrants).values(
          grants.map((grant) => ({
            companyId,
            principalType: member.principalType,
            principalId: member.principalId,
            permissionKey: grant.permissionKey,
            scope: grant.scope ?? null,
            grantedByUserId,
            createdAt: new Date(),
            updatedAt: new Date(),
          })),
        );
      }
    });

    return normalizeMembershipRow(member);
  }

  async function promoteInstanceAdmin(userId: string) {
    const existing = await db
      .select()
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows[0] ?? null);
    if (existing) return existing;
    return db
      .insert(instanceUserRoles)
      .values({
        userId,
        role: "instance_admin",
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function demoteInstanceAdmin(userId: string) {
    return db
      .delete(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function listUserCompanyAccess(userId: string) {
    const rows = await db
      .select()
      .from(companyMemberships)
      .where(and(eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId)))
      .orderBy(sql`${companyMemberships.createdAt} desc`);
    const user = await db
      .select({
        id: authUsers.id,
        name: authUsers.name,
        email: authUsers.email,
        image: authUsers.image,
      })
      .from(authUsers)
      .where(eq(authUsers.id, userId))
      .then((result) => result[0] ?? null);
    return rows.map((row) => ({
      ...normalizeMembershipRow(row),
      user,
    }));
  }

  async function setUserCompanyAccess(userId: string, companyIds: string[]) {
    const existing = await listUserCompanyAccess(userId);
    const existingByCompany = new Map(existing.map((row) => [row.companyId, row]));
    const target = new Set(companyIds);
    const membershipsToDelete = existing.filter((row) => !target.has(row.companyId));

    for (const membership of membershipsToDelete) {
      await assertCompanyKeepsAnAdmin(
        db,
        membership.companyId,
        membership.id,
        null,
        "suspended",
      );
    }

    await db.transaction(async (tx) => {
      const toDelete = membershipsToDelete.map((row) => row.id);
      if (toDelete.length > 0) {
        await tx.delete(companyMemberships).where(inArray(companyMemberships.id, toDelete));
      }

      for (const companyId of target) {
        if (existingByCompany.has(companyId)) continue;
        await tx.insert(companyMemberships).values({
          companyId,
          principalType: "user",
          principalId: userId,
          status: "active",
          membershipRole: "member",
          approvalRole: null,
        });
      }
    });

    return listUserCompanyAccess(userId);
  }

  async function ensureMembership(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    membershipRole: string | null = "member",
    status: "pending" | "active" | "suspended" = "active",
    approvalRole: string | null | undefined = undefined,
  ) {
    const normalizedMembershipRole = normalizeMembershipRole(membershipRole);
    const normalizedApprovalRole = approvalRole === undefined ? null : normalizeApprovalRole(approvalRole);
    const existing = await getMembership(companyId, principalType, principalId);
    if (existing) {
      const nextApprovalRole = approvalRole === undefined
        ? normalizeApprovalRoleFromMembership(existing)
        : normalizedApprovalRole;
      if (principalType === "user") {
        await assertCompanyKeepsAnAdmin(
          db,
          companyId,
          existing.id,
          normalizedMembershipRole,
          status,
        );
      }
      const existingMembershipRole = normalizeMembershipRole(existing.membershipRole);
      const existingApprovalRole = normalizeApprovalRoleFromMembership(existing);
      const requiresRoleNormalization = existing.membershipRole !== normalizedMembershipRole;
      const requiresApprovalRoleNormalization = existing.approvalRole !== nextApprovalRole;
      if (
        existing.status !== status
        || existingMembershipRole !== normalizedMembershipRole
        || existingApprovalRole !== nextApprovalRole
        || requiresRoleNormalization
        || requiresApprovalRoleNormalization
      ) {
        const updated = await db
          .update(companyMemberships)
          .set({
            status,
            membershipRole: normalizedMembershipRole,
            approvalRole: nextApprovalRole,
            updatedAt: new Date(),
          })
          .where(eq(companyMemberships.id, existing.id))
          .returning()
          .then((rows) => rows[0] ?? null);
        return updated ? normalizeMembershipRow(updated) : normalizeMembershipRow(existing);
      }
      return normalizeMembershipRow(existing);
    }

    return db
      .insert(companyMemberships)
      .values({
        companyId,
        principalType,
        principalId,
        status,
        membershipRole: normalizedMembershipRole,
        approvalRole: normalizedApprovalRole,
      })
      .returning()
      .then((rows) => normalizeMembershipRow(rows[0]));
  }

  async function updateMemberRole(
    companyId: string,
    memberId: string,
    membershipRole: CompanyMembershipRole,
  ) {
    const member = await assertCompanyKeepsAnAdmin(
      db,
      companyId,
      memberId,
      membershipRole,
      "active",
    );
    if (!member) return null;

    const updated = await db
      .update(companyMemberships)
      .set({
        membershipRole,
        updatedAt: new Date(),
      })
      .where(eq(companyMemberships.id, member.id))
      .returning()
      .then((rows) => rows[0] ?? null);

    return updated ? normalizeMembershipRow(updated) : normalizeMembershipRow(member);
  }

  async function updateMemberApprovalRole(
    companyId: string,
    memberId: string,
    approvalRole: CompanyApprovalRole | null,
  ) {
    const member = await db
      .select()
      .from(companyMemberships)
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.id, memberId)))
      .then((rows) => rows[0] ?? null);
    if (!member) return null;
    if (member.principalType !== "user") {
      throw conflict("Only user members can have approval roles");
    }

    const normalized = normalizeApprovalRole(approvalRole);
    const updated = await db
      .update(companyMemberships)
      .set({
        approvalRole: normalized,
        updatedAt: new Date(),
      })
      .where(eq(companyMemberships.id, member.id))
      .returning()
      .then((rows) => rows[0] ?? null);

    return updated ? normalizeMembershipRow(updated) : normalizeMembershipRow(member);
  }

  async function setPrincipalGrants(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    grants: GrantInput[],
    grantedByUserId: string | null,
  ) {
    await db.transaction(async (tx) => {
      await tx
        .delete(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, companyId),
            eq(principalPermissionGrants.principalType, principalType),
            eq(principalPermissionGrants.principalId, principalId),
          ),
        );
      if (grants.length === 0) return;
      await tx.insert(principalPermissionGrants).values(
        grants.map((grant) => ({
          companyId,
          principalType,
          principalId,
          permissionKey: grant.permissionKey,
          scope: grant.scope ?? null,
          grantedByUserId,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      );
    });
  }

  async function copyActiveUserMemberships(sourceCompanyId: string, targetCompanyId: string) {
    const sourceMemberships = await listActiveUserMemberships(sourceCompanyId);
    for (const membership of sourceMemberships) {
      await ensureMembership(
        targetCompanyId,
        "user",
        membership.principalId,
        normalizeMembershipRole(membership.membershipRole),
        "active",
        normalizeApprovalRoleFromMembership(membership),
      );
    }
    return sourceMemberships;
  }

  async function listPrincipalGrants(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
  ) {
    return db
      .select()
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, principalType),
          eq(principalPermissionGrants.principalId, principalId),
        ),
      )
      .orderBy(principalPermissionGrants.permissionKey);
  }

  async function setPrincipalPermission(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    permissionKey: PermissionKey,
    enabled: boolean,
    grantedByUserId: string | null,
    scope: Record<string, unknown> | null = null,
  ) {
    if (!enabled) {
      await db
        .delete(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, companyId),
            eq(principalPermissionGrants.principalType, principalType),
            eq(principalPermissionGrants.principalId, principalId),
            eq(principalPermissionGrants.permissionKey, permissionKey),
          ),
        );
      return;
    }

    await ensureMembership(companyId, principalType, principalId, "member", "active", undefined);

    const existing = await db
      .select()
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, principalType),
          eq(principalPermissionGrants.principalId, principalId),
          eq(principalPermissionGrants.permissionKey, permissionKey),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (existing) {
      await db
        .update(principalPermissionGrants)
        .set({
          scope,
          grantedByUserId,
          updatedAt: new Date(),
        })
        .where(eq(principalPermissionGrants.id, existing.id));
      return;
    }

    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType,
      principalId,
      permissionKey,
      scope,
      grantedByUserId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  return {
    isInstanceAdmin,
    canUser,
    isCompanyAdmin,
    hasPermission,
    getMembership,
    ensureMembership,
    updateMemberRole,
    updateMemberApprovalRole,
    listMembers,
    listActiveUserMemberships,
    copyActiveUserMemberships,
    setMemberPermissions,
    promoteInstanceAdmin,
    demoteInstanceAdmin,
    listUserCompanyAccess,
    setUserCompanyAccess,
    setPrincipalGrants,
    listPrincipalGrants,
    setPrincipalPermission,
  };
}
