CREATE TABLE "firm_recruiting_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"source_id" uuid,
	"external_id" text,
	"title" text NOT NULL,
	"event_kind" text DEFAULT 'other' NOT NULL,
	"event_date" timestamp,
	"registration_deadline" timestamp,
	"school" text,
	"location" text,
	"event_url" text NOT NULL,
	"description_raw" text,
	"evidence" text,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"last_confirmed_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_opening_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"reported_by_user_id" uuid NOT NULL,
	"program_category" "firm_program_category",
	"cycle_year" integer NOT NULL,
	"note" text,
	"source_url" text,
	"observed_at" timestamp DEFAULT now() NOT NULL,
	"dismissed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "firm_monitoring_sources" ADD COLUMN "last_page_text" text;--> statement-breakpoint
ALTER TABLE "internship_postings" ADD COLUMN "requirements_full" text;--> statement-breakpoint
ALTER TABLE "firm_recruiting_events" ADD CONSTRAINT "firm_recruiting_events_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_recruiting_events" ADD CONSTRAINT "firm_recruiting_events_source_id_firm_monitoring_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."firm_monitoring_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_opening_reports" ADD CONSTRAINT "student_opening_reports_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_opening_reports" ADD CONSTRAINT "student_opening_reports_reported_by_user_id_users_id_fk" FOREIGN KEY ("reported_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "firm_recruiting_events_firm_idx" ON "firm_recruiting_events" USING btree ("firm_id","event_date");--> statement-breakpoint
CREATE UNIQUE INDEX "firm_recruiting_events_identity_idx" ON "firm_recruiting_events" USING btree ("firm_id","event_url");--> statement-breakpoint
CREATE INDEX "student_opening_reports_firm_idx" ON "student_opening_reports" USING btree ("firm_id","cycle_year");--> statement-breakpoint
CREATE UNIQUE INDEX "student_opening_reports_unique_idx" ON "student_opening_reports" USING btree ("firm_id","reported_by_user_id","program_category","cycle_year");