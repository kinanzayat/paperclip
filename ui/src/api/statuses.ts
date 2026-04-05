import type { CompanyIssueStatus, IssueStatusCategory } from "@paperclipai/shared";
import { api } from "./client";

export type CreateCompanyIssueStatusInput = {
  slug?: string;
  label: string;
  category: IssueStatusCategory;
  color: string;
  isDefault?: boolean;
};

export type UpdateCompanyIssueStatusInput = {
  slug?: string;
  label?: string;
  color?: string;
  isDefault?: boolean;
};

export const statusesApi = {
  list: (companyId: string) =>
    api.get<CompanyIssueStatus[]>(`/companies/${companyId}/statuses`),

  create: (companyId: string, input: CreateCompanyIssueStatusInput) =>
    api.post<CompanyIssueStatus>(`/companies/${companyId}/statuses`, input),

  update: (companyId: string, statusId: string, input: UpdateCompanyIssueStatusInput) =>
    api.patch<CompanyIssueStatus>(`/companies/${companyId}/statuses/${statusId}`, input),

  reorder: (companyId: string, statusIds: string[]) =>
    api.post<CompanyIssueStatus[]>(`/companies/${companyId}/statuses/reorder`, { statusIds }),

  remove: (companyId: string, statusId: string, replacementSlug?: string) =>
    api.delete<CompanyIssueStatus>(`/companies/${companyId}/statuses/${statusId}`, {
      replacementSlug,
    }),
};
