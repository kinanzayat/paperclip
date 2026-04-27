ALTER TABLE "company_memberships" ADD COLUMN "approval_role" text;
--> statement-breakpoint
UPDATE "company_memberships"
SET
  "approval_role" = "membership_role",
  "membership_role" = 'admin',
  "updated_at" = now()
WHERE "membership_role" IN ('product_owner_head', 'tech_team');
