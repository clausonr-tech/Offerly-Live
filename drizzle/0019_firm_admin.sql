-- Offerly's admin side of the firm portal: an audit log of every admin
-- change, and a "taken down by Offerly" marker on firm posts that the firm
-- itself cannot undo. See lib/firm-admin.ts.
--
-- Written to be re-runnable like 0010-0017: IF NOT EXISTS where Postgres has
-- it, drop-then-add for constraints. Otherwise what drizzle-kit generated.
--
-- ADDITIVE ONLY. One new table and four nullable columns.

CREATE TABLE IF NOT EXISTS "firm_admin_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"target_user_id" uuid,
	"target_firm_id" uuid,
	"target_post_id" uuid,
	"detail" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "firm_recruiting_events" ADD COLUMN IF NOT EXISTS "taken_down_at" timestamp;--> statement-breakpoint
ALTER TABLE "firm_recruiting_events" ADD COLUMN IF NOT EXISTS "taken_down_reason" text;--> statement-breakpoint
ALTER TABLE "internship_postings" ADD COLUMN IF NOT EXISTS "taken_down_at" timestamp;--> statement-breakpoint
ALTER TABLE "internship_postings" ADD COLUMN IF NOT EXISTS "taken_down_reason" text;--> statement-breakpoint

ALTER TABLE "firm_admin_audit" DROP CONSTRAINT IF EXISTS "firm_admin_audit_actor_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "firm_admin_audit" ADD CONSTRAINT "firm_admin_audit_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_admin_audit" DROP CONSTRAINT IF EXISTS "firm_admin_audit_target_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "firm_admin_audit" ADD CONSTRAINT "firm_admin_audit_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_admin_audit" DROP CONSTRAINT IF EXISTS "firm_admin_audit_target_firm_id_firms_id_fk";--> statement-breakpoint
ALTER TABLE "firm_admin_audit" ADD CONSTRAINT "firm_admin_audit_target_firm_id_firms_id_fk" FOREIGN KEY ("target_firm_id") REFERENCES "public"."firms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "firm_admin_audit_created_idx" ON "firm_admin_audit" USING btree ("created_at");
