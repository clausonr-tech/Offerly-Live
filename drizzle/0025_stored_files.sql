-- Uploaded files (resumes, profile photos, post images), moved off the local
-- disk so they work on Vercel and on every machine sharing the database
-- (lib/file-store). IF NOT EXISTS so a replay is harmless, like 0010-0024.
CREATE TABLE IF NOT EXISTS "stored_files" (
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"byte_size" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "stored_files_kind_key_pk" PRIMARY KEY("kind","key")
);
