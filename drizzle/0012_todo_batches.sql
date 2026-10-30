-- The "Today" to-do list: which five tasks a student was shown each day, and
-- which tasks they ticked off by hand. See lib/today-list.ts.
--
-- Written to be re-runnable like 0010 and 0011: IF NOT EXISTS on everything
-- that has it, and drop-then-add for the constraints that do not. The
-- statements are otherwise what drizzle-kit generated from src/db/schema.ts.
--
-- ADDITIVE ONLY. Two new tables; nothing existing is touched.

CREATE TABLE IF NOT EXISTS "todo_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"batch" integer NOT NULL,
	"items" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "todo_dismissals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"task_id" text NOT NULL,
	"dismissed_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "todo_batches" DROP CONSTRAINT IF EXISTS "todo_batches_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "todo_batches" ADD CONSTRAINT "todo_batches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todo_dismissals" DROP CONSTRAINT IF EXISTS "todo_dismissals_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "todo_dismissals" ADD CONSTRAINT "todo_dismissals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "todo_batches_user_day_batch_idx" ON "todo_batches" USING btree ("user_id","day","batch");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "todo_dismissals_user_task_idx" ON "todo_dismissals" USING btree ("user_id","task_id");
