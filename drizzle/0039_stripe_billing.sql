-- Billing: the Pro+ tier and the Stripe linkage (customer + subscription)
-- the webhook uses to keep users.plan current. user_top_firms.position is NOT
-- re-added here: 0038 already carries it; this migration's snapshot simply
-- brings drizzle's metadata back in line with it.
--
-- Every statement is guarded: migrations from 0006 on replay against the
-- shared database (see scripts/test/migration-replay.test.ts), so each must
-- survive running over a database that already has it.
ALTER TYPE "public"."plan" ADD VALUE IF NOT EXISTS 'pro_plus';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "stripe_subscription_id" text;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_stripe_customer_id_unique') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_stripe_customer_id_unique" UNIQUE("stripe_customer_id");
  END IF;
END $$;
