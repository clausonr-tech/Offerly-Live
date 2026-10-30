-- The live feed's engagement: emoji reactions, comments, and which posts each
-- student has already seen (the feed shows unseen posts first).
-- Every statement is re-runnable, and all of it is applied to the live
-- database before the schema that reads it (see feedback: database first).

CREATE TABLE IF NOT EXISTS "activity_reactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL CONSTRAINT "activity_reactions_event_id_activity_events_id_fk" REFERENCES "activity_events"("id") ON DELETE CASCADE,
	"user_id" uuid NOT NULL CONSTRAINT "activity_reactions_user_id_users_id_fk" REFERENCES "users"("id") ON DELETE CASCADE,
	"emoji" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "activity_reactions_unique_idx" ON "activity_reactions" ("event_id","user_id","emoji");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_reactions_user_idx" ON "activity_reactions" ("user_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "activity_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL CONSTRAINT "activity_comments_event_id_activity_events_id_fk" REFERENCES "activity_events"("id") ON DELETE CASCADE,
	"user_id" uuid NOT NULL CONSTRAINT "activity_comments_user_id_users_id_fk" REFERENCES "users"("id") ON DELETE CASCADE,
	"body" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_comments_event_idx" ON "activity_comments" ("event_id","created_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "activity_seen" (
	"user_id" uuid NOT NULL CONSTRAINT "activity_seen_user_id_users_id_fk" REFERENCES "users"("id") ON DELETE CASCADE,
	"event_id" uuid NOT NULL CONSTRAINT "activity_seen_event_id_activity_events_id_fk" REFERENCES "activity_events"("id") ON DELETE CASCADE,
	"seen_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "activity_seen_user_id_event_id_pk" PRIMARY KEY("user_id","event_id")
);--> statement-breakpoint

-- Supabase: new tables arrive with no grants (default privileges) but RLS
-- off; the app connects as a role that bypasses RLS, so enabling it closes
-- the PostgREST side without touching the app.
ALTER TABLE "activity_reactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "activity_comments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "activity_seen" ENABLE ROW LEVEL SECURITY;
