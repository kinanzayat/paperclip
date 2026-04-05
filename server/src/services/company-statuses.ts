import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyStatuses, issues } from "@paperclipai/db";
import {
  DEFAULT_ISSUE_STATUSES,
  type CompanyIssueStatus,
  type CreateCompanyIssueStatus,
  type IssueStatusCategory,
  type UpdateCompanyIssueStatus,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type CompanyStatusRow = typeof companyStatuses.$inferSelect;

const TERMINAL_STATUS_CATEGORIES = new Set<IssueStatusCategory>(["completed", "cancelled"]);
const ACTIVE_STATUS_CATEGORIES = new Set<IssueStatusCategory>(["started", "blocked"]);

function normalizeSlug(slug: string) {
  return slug.trim().toLowerCase();
}

function normalizeLabel(label: string) {
  return label.trim();
}

function normalizeColor(color: string) {
  return color.trim().toLowerCase();
}

function toSharedStatus(row: CompanyStatusRow): CompanyIssueStatus {
  return {
    id: row.id,
    companyId: row.companyId,
    slug: row.slug,
    label: row.label,
    category: row.category as IssueStatusCategory,
    color: row.color,
    position: row.position,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function listRows(executor: Executor, companyId: string) {
  return executor
    .select()
    .from(companyStatuses)
    .where(eq(companyStatuses.companyId, companyId))
    .orderBy(asc(companyStatuses.position), asc(companyStatuses.createdAt), asc(companyStatuses.id));
}

async function ensureCategoryDefault(executor: Executor, companyId: string, category: IssueStatusCategory) {
  const rows = await executor
    .select({
      id: companyStatuses.id,
      isDefault: companyStatuses.isDefault,
    })
    .from(companyStatuses)
    .where(and(eq(companyStatuses.companyId, companyId), eq(companyStatuses.category, category)))
    .orderBy(asc(companyStatuses.position), asc(companyStatuses.createdAt), asc(companyStatuses.id));

  if (rows.length === 0) return;
  if (rows.some((row) => row.isDefault)) return;

  await executor
    .update(companyStatuses)
    .set({
      isDefault: true,
      updatedAt: new Date(),
    })
    .where(eq(companyStatuses.id, rows[0]!.id));
}

async function clearCategoryDefault(
  executor: Executor,
  companyId: string,
  category: IssueStatusCategory,
  keepId: string,
) {
  await executor
    .update(companyStatuses)
    .set({
      isDefault: false,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(companyStatuses.companyId, companyId),
        eq(companyStatuses.category, category),
        sql`${companyStatuses.id} <> ${keepId}`,
      ),
    );
}

export function companyStatusService(db: Db) {
  async function ensureDefaults(companyId: string, executor: Executor = db) {
    const existing = await executor
      .select({ id: companyStatuses.id })
      .from(companyStatuses)
      .where(eq(companyStatuses.companyId, companyId))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (!existing) {
      await executor.insert(companyStatuses).values(
        DEFAULT_ISSUE_STATUSES.map((status) => ({
          companyId,
          slug: status.slug,
          label: status.label,
          category: status.category,
          color: status.color,
          position: status.position,
          isDefault: status.isDefault,
        })),
      );
    }

    for (const status of DEFAULT_ISSUE_STATUSES) {
      await ensureCategoryDefault(executor, companyId, status.category);
    }

    return list(companyId, executor);
  }

  async function list(companyId: string, executor: Executor = db): Promise<CompanyIssueStatus[]> {
    const rows = await listRows(executor, companyId);
    if (rows.length === 0) {
      return ensureDefaults(companyId, executor);
    }
    return rows.map(toSharedStatus);
  }

  async function getBySlug(companyId: string, slug: string, executor: Executor = db): Promise<CompanyIssueStatus | null> {
    const normalizedSlug = normalizeSlug(slug);
    const rows = await list(companyId, executor);
    return rows.find((row) => row.slug === normalizedSlug) ?? null;
  }

  async function getById(companyId: string, id: string, executor: Executor = db): Promise<CompanyIssueStatus | null> {
    const rows = await list(companyId, executor);
    return rows.find((row) => row.id === id) ?? null;
  }

  async function requireBySlug(companyId: string, slug: string, executor: Executor = db) {
    const status = await getBySlug(companyId, slug, executor);
    if (!status) {
      throw unprocessable(`Unknown issue status: ${slug}`);
    }
    return status;
  }

  async function getDefault(companyId: string, category: IssueStatusCategory, executor: Executor = db) {
    const rows = await list(companyId, executor);
    const preferred = rows.find((row) => row.category === category && row.isDefault);
    if (preferred) return preferred;
    const fallback = rows.find((row) => row.category === category);
    if (fallback) return fallback;
    throw conflict(`Company has no ${category} issue status configured`);
  }

  async function resolveCreateStatus(companyId: string, slug: string | null | undefined, executor: Executor = db) {
    if (slug && slug.trim().length > 0) {
      return requireBySlug(companyId, slug, executor);
    }
    const backlog = await getBySlug(companyId, "backlog", executor);
    if (backlog) return backlog;
    return getDefault(companyId, "unstarted", executor);
  }

  async function listSlugsByCategory(
    companyId: string,
    category: IssueStatusCategory,
    executor: Executor = db,
  ) {
    const rows = await list(companyId, executor);
    return rows.filter((row) => row.category === category).map((row) => row.slug);
  }

  async function listOpenSlugs(companyId: string, executor: Executor = db) {
    const rows = await list(companyId, executor);
    return rows.filter((row) => !TERMINAL_STATUS_CATEGORIES.has(row.category)).map((row) => row.slug);
  }

  async function create(companyId: string, input: CreateCompanyIssueStatus) {
    const rows = await list(companyId);
    const slug = normalizeSlug(input.slug);
    if (rows.some((row) => row.slug === slug)) {
      throw conflict("A status with that slug already exists");
    }
    const position = rows.length === 0 ? 0 : Math.max(...rows.map((row) => row.position)) + 1;

    return db.transaction(async (tx) => {
      const created = await tx
        .insert(companyStatuses)
        .values({
          companyId,
          slug,
          label: normalizeLabel(input.label),
          category: input.category,
          color: normalizeColor(input.color),
          position,
          isDefault: Boolean(input.isDefault),
        })
        .returning()
        .then((result) => result[0] ?? null);

      if (!created) {
        throw conflict("Failed to create company status");
      }

      if (created.isDefault) {
        await clearCategoryDefault(tx, companyId, created.category as IssueStatusCategory, created.id);
      } else {
        await ensureCategoryDefault(tx, companyId, created.category as IssueStatusCategory);
      }

      return getById(companyId, created.id, tx);
    }).then((status) => {
      if (!status) throw notFound("Status not found after creation");
      return status;
    });
  }

  async function update(companyId: string, statusId: string, input: UpdateCompanyIssueStatus) {
    return db.transaction(async (tx) => {
      const current = await tx
        .select()
        .from(companyStatuses)
        .where(and(eq(companyStatuses.companyId, companyId), eq(companyStatuses.id, statusId)))
        .then((rows) => rows[0] ?? null);
      if (!current) return null;

      const nextSlug = input.slug ? normalizeSlug(input.slug) : current.slug;
      const nextCategory = input.category ?? (current.category as IssueStatusCategory);
      const nextIsDefault = input.isDefault ?? current.isDefault;

      if (nextSlug !== current.slug) {
        const conflictStatus = await tx
          .select({ id: companyStatuses.id })
          .from(companyStatuses)
          .where(
            and(
              eq(companyStatuses.companyId, companyId),
              eq(companyStatuses.slug, nextSlug),
              sql`${companyStatuses.id} <> ${statusId}`,
            ),
          )
          .then((rows) => rows[0] ?? null);
        if (conflictStatus) {
          throw conflict("A status with that slug already exists");
        }
      }

      const updated = await tx
        .update(companyStatuses)
        .set({
          slug: nextSlug,
          label: input.label ? normalizeLabel(input.label) : current.label,
          category: nextCategory,
          color: input.color ? normalizeColor(input.color) : current.color,
          isDefault: nextIsDefault,
          updatedAt: new Date(),
        })
        .where(eq(companyStatuses.id, statusId))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!updated) return null;

      if (nextIsDefault) {
        await clearCategoryDefault(tx, companyId, nextCategory, statusId);
      }
      await ensureCategoryDefault(tx, companyId, current.category as IssueStatusCategory);
      await ensureCategoryDefault(tx, companyId, nextCategory);

      return getById(companyId, statusId, tx);
    });
  }

  async function reorder(companyId: string, statusIds: string[]) {
    return db.transaction(async (tx) => {
      const rows = await list(companyId, tx);
      if (rows.length !== statusIds.length) {
        throw unprocessable("Status reorder request must include every company status");
      }

      const existingIds = new Set(rows.map((row) => row.id));
      if (statusIds.some((id) => !existingIds.has(id))) {
        throw unprocessable("Status reorder request contains unknown status ids");
      }

      for (const [position, statusId] of statusIds.entries()) {
        await tx
          .update(companyStatuses)
          .set({ position, updatedAt: new Date() })
          .where(and(eq(companyStatuses.companyId, companyId), eq(companyStatuses.id, statusId)));
      }

      return list(companyId, tx);
    });
  }

  async function remove(companyId: string, statusId: string, replacementSlug?: string | null) {
    return db.transaction(async (tx) => {
      const current = await tx
        .select()
        .from(companyStatuses)
        .where(and(eq(companyStatuses.companyId, companyId), eq(companyStatuses.id, statusId)))
        .then((rows) => rows[0] ?? null);
      if (!current) return null;

      const category = current.category as IssueStatusCategory;
      const sameCategory = await tx
        .select({
          id: companyStatuses.id,
          slug: companyStatuses.slug,
          isDefault: companyStatuses.isDefault,
        })
        .from(companyStatuses)
        .where(and(eq(companyStatuses.companyId, companyId), eq(companyStatuses.category, category)))
        .orderBy(asc(companyStatuses.position), asc(companyStatuses.createdAt), asc(companyStatuses.id));

      if (sameCategory.length <= 1) {
        throw conflict(`Cannot delete the last ${category} status`);
      }

      const usage = await tx
        .select({ count: count() })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.status, current.slug)))
        .then((rows) => Number(rows[0]?.count ?? 0));

      let replacement = null as { id: string; slug: string; category: string } | null;
      if (replacementSlug) {
        replacement = await tx
          .select({ id: companyStatuses.id, slug: companyStatuses.slug, category: companyStatuses.category })
          .from(companyStatuses)
          .where(
            and(
              eq(companyStatuses.companyId, companyId),
              eq(companyStatuses.slug, normalizeSlug(replacementSlug)),
            ),
          )
          .then((rows) => rows[0] ?? null);
        if (!replacement) {
          throw notFound("Replacement status not found");
        }
        if (replacement.id === current.id) {
          throw unprocessable("Replacement status must be different");
        }
        if (replacement.category !== category) {
          throw unprocessable("Replacement status must be in the same category");
        }
      }

      if (usage > 0 && !replacement) {
        throw conflict("Status is in use and requires a same-category replacement");
      }

      if (usage > 0 && replacement) {
        await tx
          .update(issues)
          .set({
            status: replacement.slug,
            updatedAt: new Date(),
          })
          .where(and(eq(issues.companyId, companyId), eq(issues.status, current.slug)));
      }

      await tx.delete(companyStatuses).where(eq(companyStatuses.id, statusId));

      if (current.isDefault) {
        const promotedId = replacement?.id ?? sameCategory.find((row) => row.id !== current.id)?.id;
        if (promotedId) {
          await tx
            .update(companyStatuses)
            .set({
              isDefault: true,
              updatedAt: new Date(),
            })
            .where(eq(companyStatuses.id, promotedId));
        }
      }

      await ensureCategoryDefault(tx, companyId, category);

      return toSharedStatus(current);
    });
  }

  return {
    list,
    listOpenSlugs,
    listSlugsByCategory,
    ensureDefaults,
    getBySlug,
    getById,
    requireBySlug,
    getDefault,
    resolveCreateStatus,
    create,
    update,
    reorder,
    remove,
    isTerminalCategory: (category: IssueStatusCategory) => TERMINAL_STATUS_CATEGORIES.has(category),
    isActiveCategory: (category: IssueStatusCategory) => ACTIVE_STATUS_CATEGORIES.has(category),
  };
}
