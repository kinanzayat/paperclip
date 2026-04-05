import { z } from "zod";
import { ISSUE_STATUS_CATEGORIES } from "../constants.js";

export const issueStatusCategorySchema = z.enum(ISSUE_STATUS_CATEGORIES);

export const companyIssueStatusSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  slug: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(64),
  category: issueStatusCategorySchema,
  color: z.string().regex(/^#(?:[0-9a-fA-F]{6})$/, "Color must be a 6-digit hex value"),
  position: z.number().int().nonnegative(),
  isDefault: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const createCompanyIssueStatusSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, "Status slug must be lowercase letters, numbers, _ or -"),
  label: z.string().trim().min(1).max(64),
  category: issueStatusCategorySchema,
  color: z.string().regex(/^#(?:[0-9a-fA-F]{6})$/, "Color must be a 6-digit hex value"),
  isDefault: z.boolean().optional(),
});

export const updateCompanyIssueStatusSchema = createCompanyIssueStatusSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);

export const reorderCompanyIssueStatusesSchema = z.object({
  statusIds: z.array(z.string().uuid()).min(1),
});

export const deleteCompanyIssueStatusSchema = z.object({
  replacementSlug: z.string().trim().min(1).max(64).optional(),
});

export type CompanyIssueStatusInput = z.infer<typeof companyIssueStatusSchema>;
export type CreateCompanyIssueStatus = z.infer<typeof createCompanyIssueStatusSchema>;
export type UpdateCompanyIssueStatus = z.infer<typeof updateCompanyIssueStatusSchema>;
export type ReorderCompanyIssueStatuses = z.infer<typeof reorderCompanyIssueStatusesSchema>;
export type DeleteCompanyIssueStatus = z.infer<typeof deleteCompanyIssueStatusSchema>;
