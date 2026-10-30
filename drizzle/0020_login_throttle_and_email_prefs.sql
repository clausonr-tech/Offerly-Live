-- Slowing down password guessing (lib/login-throttle.ts), and a student's
-- email choices - first, whether to be emailed when a matched firm posts
-- (lib/firm-post-emails.ts).
--
-- Written to be re-runnable like 0010-0018: IF NOT EXISTS where Postgres has
-- it, drop-then-add for the constraint. Otherwise what drizzle-kit generated.
--
-- ADDITIVE ONLY. Two new tables; nothing existing is touched. The app runs
-- unchanged before this is applied - both features fall back safely.

CREATE TABLE IF NOT EXISTS "login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"ip" text,
	"success" boolean NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "student_email_prefs" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"firm_posts" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "student_email_prefs" DROP CONSTRAINT IF EXISTS "student_email_prefs_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "student_email_prefs" ADD CONSTRAINT "student_email_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "login_attempts_email_idx" ON "login_attempts" USING btree ("email","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "login_attempts_ip_idx" ON "login_attempts" USING btree ("ip","created_at");
