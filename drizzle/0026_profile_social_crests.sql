-- Profile internships, discussions, sample students, club membership and
-- school crests. Written on a branch as 0025-0029 while main added its own
-- 0025 (stored_files); folded into this one migration at the merge.
-- Every statement is re-runnable, and all of it is already applied to the
-- live database.

-- (0025_user_internships)
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "internships" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint

-- (0026_discussions)
CREATE TABLE IF NOT EXISTS "discussions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"author_id" uuid CONSTRAINT "discussions_author_id_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
	"anonymous" boolean DEFAULT false NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"topic" text NOT NULL,
	"firm_id" uuid CONSTRAINT "discussions_firm_id_firms_id_fk" REFERENCES "firms"("id") ON DELETE SET NULL,
	"firm_name" text,
	"is_sample" boolean DEFAULT false NOT NULL,
	"sample_author" text,
	"reply_count" integer DEFAULT 0 NOT NULL,
	"last_activity_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discussions_last_activity_idx" ON "discussions" ("last_activity_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "discussion_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"discussion_id" uuid NOT NULL CONSTRAINT "discussion_replies_discussion_id_discussions_id_fk" REFERENCES "discussions"("id") ON DELETE CASCADE,
	"author_id" uuid CONSTRAINT "discussion_replies_author_id_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
	"anonymous" boolean DEFAULT false NOT NULL,
	"body" text NOT NULL,
	"is_sample" boolean DEFAULT false NOT NULL,
	"sample_author" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discussion_replies_discussion_idx" ON "discussion_replies" ("discussion_id","created_at");--> statement-breakpoint
ALTER TABLE "discussions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "discussion_replies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- (0027_user_is_sample)
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_sample" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- (0028_club_members)
ALTER TABLE "clubs" ADD COLUMN IF NOT EXISTS "is_sample" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "club_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL CONSTRAINT "club_members_club_id_clubs_id_fk" REFERENCES "clubs"("id") ON DELETE CASCADE,
	"user_id" uuid NOT NULL CONSTRAINT "club_members_user_id_users_id_fk" REFERENCES "users"("id") ON DELETE CASCADE,
	"title" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "club_members_club_user_idx" ON "club_members" ("club_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "club_members_user_idx" ON "club_members" ("user_id");--> statement-breakpoint
ALTER TABLE "club_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- (0029_school_crests)
ALTER TABLE "schools" ADD COLUMN IF NOT EXISTS "crest_url" text;--> statement-breakpoint
ALTER TABLE "schools" ADD COLUMN IF NOT EXISTS "crest_width" integer;--> statement-breakpoint
ALTER TABLE "schools" ADD COLUMN IF NOT EXISTS "crest_checked_at" timestamp with time zone;
