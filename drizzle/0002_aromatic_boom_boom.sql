ALTER TYPE "public"."ai_feature" ADD VALUE 'postingExtract';--> statement-breakpoint
CREATE TABLE "classifier_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"title" text NOT NULL,
	"machine_relevant" boolean NOT NULL,
	"machine_confidence" double precision,
	"machine_reason" text,
	"machine_evidence" jsonb,
	"human_verdict" "listing_review_status" NOT NULL,
	"reviewed_by" uuid,
	"disagreed" boolean NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "peer_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"peer_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "classifier_feedback" ADD CONSTRAINT "classifier_feedback_listing_id_detected_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."detected_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classifier_feedback" ADD CONSTRAINT "classifier_feedback_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peer_links" ADD CONSTRAINT "peer_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peer_links" ADD CONSTRAINT "peer_links_peer_id_users_id_fk" FOREIGN KEY ("peer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "classifier_feedback_disagreed_idx" ON "classifier_feedback" USING btree ("disagreed");--> statement-breakpoint
CREATE INDEX "classifier_feedback_listing_idx" ON "classifier_feedback" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "peer_links_user_idx" ON "peer_links" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "peer_links_peer_idx" ON "peer_links" USING btree ("peer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "peer_links_pair_unique" ON "peer_links" USING btree ("user_id","peer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "internship_postings_firm_role_year_key" ON "internship_postings" USING btree ("firm_id","role_title","program_year");