UPDATE "company_memberships"
SET
  "membership_role" = 'admin',
  "updated_at" = NOW()
WHERE "membership_role" = 'owner';
