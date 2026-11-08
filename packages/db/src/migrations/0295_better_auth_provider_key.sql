-- Better Auth 1.7.3+ uses (provider_id, account_id), not issuer.
-- Preserve legacy issuer values. Abort on ambiguous identities; never merge accounts.
LOCK TABLE "account" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "account" GROUP BY "provider_id", "account_id" HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate account provider/account IDs: resolve identities before upgrading Better Auth';
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_account_id_uq" ON "account" USING btree ("provider_id","account_id");--> statement-breakpoint
DROP INDEX "account_issuer_account_id_uq";--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "issuer" DROP NOT NULL;
