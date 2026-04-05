import type { IssueStatusCategory } from "../constants.js";

export interface CompanyIssueStatus {
  id: string;
  companyId: string;
  slug: string;
  label: string;
  category: IssueStatusCategory;
  color: string;
  position: number;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}
