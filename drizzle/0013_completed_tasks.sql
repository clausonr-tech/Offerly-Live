-- Every task a student has finished, kept for good with what it said, for the
-- "See all completed" history. See lib/today-list.ts.
--
-- Written to be re-runnable like 0010-0012: IF NOT EXISTS where Postgres has
-- it, drop-then-add for the constraint. Otherwise what drizzle-kit generated.
--
-- ADDITIVE ONLY. One new table; nothing existing is touched.

CREATE TABLE IF NOT EXISTS "completed_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"task_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"detail" text NOT NULL,
	"href" text NOT NULL,
	"source" text NOT NULL,
	"completed_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "completed_tasks" DROP CONSTRAINT IF EXISTS "completed_tasks_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "completed_tasks" ADD CONSTRAINT "completed_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "completed_tasks_user_task_idx" ON "completed_tasks" USING btree ("user_id","task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "completed_tasks_user_time_idx" ON "completed_tasks" USING btree ("user_id","completed_at");
