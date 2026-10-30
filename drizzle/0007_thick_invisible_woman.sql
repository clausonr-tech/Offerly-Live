ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "email_domain_relevant" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "email_raw_provider" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "email_status_raw" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "email_rejection_reason" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "email_source" text;--> statement-breakpoint
ALTER TABLE "firms" ADD COLUMN IF NOT EXISTS "approved_email_domains" text[] DEFAULT '{}' NOT NULL;