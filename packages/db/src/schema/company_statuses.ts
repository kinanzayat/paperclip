import { pgTable, uuid, text, integer, boolean, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const companyStatuses = pgTable(
  "company_statuses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    label: text("label").notNull(),
    category: text("category").notNull(),
    color: text("color").notNull(),
    position: integer("position").notNull().default(0),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("company_statuses_company_idx").on(table.companyId),
    companyPositionIdx: uniqueIndex("company_statuses_company_position_idx").on(table.companyId, table.position),
    companySlugIdx: uniqueIndex("company_statuses_company_slug_idx").on(table.companyId, table.slug),
  }),
);
