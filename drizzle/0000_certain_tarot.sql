CREATE TYPE "public"."account_type" AS ENUM('student', 'club_lead', 'firm');--> statement-breakpoint
CREATE TYPE "public"."activity_kind" AS ENUM('joined', 'streak', 'offer', 'post');--> statement-breakpoint
CREATE TYPE "public"."ai_feature" AS ENUM('firmMatch', 'connectionAngle', 'draft', 'chat', 'behavioralFeedback', 'meetingTime', 'speakerEvent', 'technicalQuestion', 'technicalGrading', 'resumeReview', 'resumeRewrite');--> statement-breakpoint
CREATE TYPE "public"."application_category" AS ENUM('investment_banking', 'private_equity', 'real_estate', 'hedge_fund', 'asset_management', 'corporate_finance', 'consulting', 'other');--> statement-breakpoint
CREATE TYPE "public"."application_status" AS ENUM('not_started', 'in_progress', 'submitted', 'interviewing', 'offer', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."contact_sourcing_status" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."detected_listing_status" AS ENUM('open', 'closed', 'reopened', 'uncertain');--> statement-breakpoint
CREATE TYPE "public"."draft_kind" AS ENUM('cold_outreach', 'follow_up', 'thank_you', 'custom');--> statement-breakpoint
CREATE TYPE "public"."event_type" AS ENUM('meeting', 'coffee_chat', 'deadline', 'info_session', 'personal');--> statement-breakpoint
CREATE TYPE "public"."firm_program_category" AS ENUM('investment_banking', 'private_equity', 'venture_capital', 'private_credit', 'real_estate', 'hedge_fund', 'sales_trading', 'asset_wealth_management', 'commercial_banking', 'insurance', 'fintech', 'market_infrastructure', 'consulting', 'other_finance');--> statement-breakpoint
CREATE TYPE "public"."google_sync_status" AS ENUM('none', 'pending', 'synced', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."listing_review_status" AS ENUM('auto_approved', 'pending_review', 'approved', 'rejected', 'merged');--> statement-breakpoint
CREATE TYPE "public"."monitoring_check_outcome" AS ENUM('no_change', 'changed', 'error', 'rate_limited');--> statement-breakpoint
CREATE TYPE "public"."monitoring_source_health" AS ENUM('healthy', 'degraded', 'broken');--> statement-breakpoint
CREATE TYPE "public"."monitoring_source_type" AS ENUM('generic_html', 'jobposting_jsonld', 'greenhouse');--> statement-breakpoint
CREATE TYPE "public"."opening_signal_source" AS ENUM('firm_announcement', 'seen_live', 'student_report', 'prediction');--> statement-breakpoint
CREATE TYPE "public"."plan" AS ENUM('free', 'pro');--> statement-breakpoint
CREATE TYPE "public"."post_link_label" AS ENUM('details', 'sign_up', 'rsvp', 'apply', 'register');--> statement-breakpoint
CREATE TYPE "public"."post_type" AS ENUM('event', 'speaker_event', 'coffee_chat', 'deadline', 'announcement');--> statement-breakpoint
CREATE TYPE "public"."posting_deadline_status" AS ENUM('tbd', 'confirmed', 'rolling', 'closed');--> statement-breakpoint
CREATE TYPE "public"."relationship_status" AS ENUM('not_contacted', 'reached_out', 'in_conversation', 'ongoing', 'cold');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('student', 'admin');--> statement-breakpoint
CREATE TYPE "public"."training_outcome" AS ENUM('accepted', 'edited', 'delivered', 'discarded');--> statement-breakpoint
CREATE TYPE "public"."training_task" AS ENUM('email_draft', 'resume_tailor');--> statement-breakpoint
CREATE TYPE "public"."user_alert_kind" AS ENUM('watched_firm_opening', 'sector_digest');--> statement-breakpoint
CREATE TABLE "activity_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "activity_kind" NOT NULL,
	"dedupe_key" text NOT NULL,
	"firm" text,
	"role" text,
	"streak" integer,
	"body" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"feature" "ai_feature" NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"used_fallback" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"firm" text NOT NULL,
	"role" text NOT NULL,
	"status" "application_status" DEFAULT 'not_started' NOT NULL,
	"category" "application_category",
	"compensation" integer,
	"application_url" text,
	"notes" text,
	"applied_date" date,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "behavioral_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"answer_text" text NOT NULL,
	"ai_feedback" text,
	"feedback_generated_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "behavioral_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"category" text NOT NULL,
	"prompt" text NOT NULL,
	"guidance" text,
	"order_index" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "behavioral_questions_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "clubs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"school_id" uuid,
	"description" text,
	"website_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "clubs_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "contact_sourcing_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"firm_id" uuid NOT NULL,
	"credits_spent" integer DEFAULT 1 NOT NULL,
	"contacts_requested" integer DEFAULT 5 NOT NULL,
	"contacts_created" integer DEFAULT 0 NOT NULL,
	"status" "contact_sourcing_status" DEFAULT 'pending' NOT NULL,
	"provider" text DEFAULT 'crustdata' NOT NULL,
	"query_summary" text,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"firm" text,
	"role" text,
	"linkedin_url" text,
	"email" text,
	"email_confidence" text,
	"school" text,
	"grad_year" integer,
	"current_city" text,
	"background" text,
	"notes" text,
	"relationship_status" "relationship_status" DEFAULT 'not_contacted' NOT NULL,
	"last_contact_date" date,
	"source_url" text,
	"enriched_at" timestamp,
	"firm_recruiting_contact_id" uuid,
	"connection_angle" text,
	"connection_angle_feedback" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "detected_listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"external_job_id" text,
	"content_hash" text NOT NULL,
	"title" text NOT NULL,
	"division" text,
	"location" text,
	"description_raw" text NOT NULL,
	"employment_type" text,
	"application_url" text,
	"listing_url" text NOT NULL,
	"published_at" timestamp,
	"deadline_at" timestamp,
	"first_detected_at" timestamp DEFAULT now() NOT NULL,
	"last_confirmed_at" timestamp DEFAULT now() NOT NULL,
	"status" "detected_listing_status" DEFAULT 'open' NOT NULL,
	"classification" jsonb,
	"review_status" "listing_review_status" DEFAULT 'pending_review' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp,
	"promoted_posting_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "directory_people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid,
	"firm_name" text NOT NULL,
	"name" text NOT NULL,
	"title" text,
	"school" text,
	"degree" text,
	"school_years" text,
	"grad_year" integer,
	"job_history" text,
	"linkedin_url" text,
	"email" text,
	"import_batch" text,
	"delisted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_archive" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"draft_id" uuid,
	"email_type" text NOT NULL,
	"generated_ciphertext" text,
	"final_ciphertext" text,
	"resume_attached" boolean DEFAULT false NOT NULL,
	"push_count" integer DEFAULT 0 NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"pushed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "email_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text DEFAULT 'google' NOT NULL,
	"email" text,
	"access_token" text NOT NULL,
	"refresh_token" text,
	"expires_at" timestamp,
	"offerly_calendar_id" text,
	"connected_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"contact_id" uuid,
	"kind" "draft_kind" DEFAULT 'cold_outreach' NOT NULL,
	"purpose" text,
	"template_id" text,
	"gaps" jsonb,
	"inputs" jsonb,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"model_subject" text,
	"model_body" text,
	"pushed_to_gmail_at" timestamp,
	"got_reply" boolean,
	"replied_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "event_type" NOT NULL,
	"title" text NOT NULL,
	"notes" text,
	"event_date" timestamp NOT NULL,
	"end_date" timestamp,
	"completed" boolean DEFAULT false NOT NULL,
	"contact_id" uuid,
	"application_id" uuid,
	"google_event_id" text,
	"google_calendar_id" text,
	"google_meet_url" text,
	"google_sync_status" "google_sync_status" DEFAULT 'none' NOT NULL,
	"reminder_email_sent_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "firm_email_patterns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"shape" text NOT NULL,
	"domain" text NOT NULL,
	"samples" integer DEFAULT 1 NOT NULL,
	"tally" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "firm_email_patterns_firm_id_unique" UNIQUE("firm_id")
);
--> statement-breakpoint
CREATE TABLE "firm_monitoring_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"parent_firm_id" uuid,
	"careers_url" text NOT NULL,
	"source_type" "monitoring_source_type" NOT NULL,
	"connector_id" text NOT NULL,
	"sector_category" "firm_program_category" NOT NULL,
	"has_confirmed_internship_history" boolean DEFAULT false NOT NULL,
	"historical_opening_window" text,
	"is_rolling" boolean DEFAULT false NOT NULL,
	"tier_id" uuid NOT NULL,
	"priority_score" double precision DEFAULT 0 NOT NULL,
	"last_attempted_at" timestamp,
	"last_success_at" timestamp,
	"next_check_at" timestamp DEFAULT now() NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"source_health" "monitoring_source_health" DEFAULT 'healthy' NOT NULL,
	"last_etag" text,
	"last_content_hash" text,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "firm_programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"category" "firm_program_category" NOT NULL,
	"role_label" text NOT NULL,
	"timing_guidance" text NOT NULL,
	"careers_url" text NOT NULL,
	"recruiting_channel_label" text NOT NULL,
	"recruiting_channel_url" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "firm_recruiting_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"email" text,
	"source_url" text,
	"background" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "firms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"headquarters" text NOT NULL,
	"key_offices" text NOT NULL,
	"website" text NOT NULL,
	"description" text NOT NULL,
	"self_description" text,
	"self_description_source_url" text,
	"aum" bigint,
	"hq_state" text,
	"has_verified_program" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "firms_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "follows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"follower_id" uuid NOT NULL,
	"following_user_id" uuid,
	"club_id" uuid,
	"firm_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "internship_crawl_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mode" text NOT NULL,
	"firms_scanned" integer DEFAULT 0 NOT NULL,
	"postings_found" integer DEFAULT 0 NOT NULL,
	"postings_updated" integer DEFAULT 0 NOT NULL,
	"deadlines_resolved" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"web_searches" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "internship_postings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"categories" "firm_program_category"[] NOT NULL,
	"role_title" text NOT NULL,
	"location" text,
	"program_year" integer NOT NULL,
	"eligible_grad_years" integer[] NOT NULL,
	"deadline_status" "posting_deadline_status" DEFAULT 'tbd' NOT NULL,
	"deadline_text" text,
	"deadline_date" timestamp,
	"opens_text" text,
	"opens_at" timestamp,
	"description_full" text NOT NULL,
	"source_url" text NOT NULL,
	"application_url" text,
	"recruiter_name" text,
	"recruiter_title" text,
	"recruiter_email" text,
	"recruiter_phone" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_checked_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sender_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"body" text NOT NULL,
	"read_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitoring_check_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	"outcome" "monitoring_check_outcome",
	"http_status" integer,
	"response_bytes" integer,
	"listings_seen" integer DEFAULT 0 NOT NULL,
	"listings_new" integer DEFAULT 0 NOT NULL,
	"listings_closed" integer DEFAULT 0 NOT NULL,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "monitoring_tiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"check_interval_minutes" integer,
	"description" text NOT NULL,
	"sort_order" integer NOT NULL,
	CONSTRAINT "monitoring_tiers_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "opening_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"program_category" "firm_program_category",
	"cycle_year" integer NOT NULL,
	"source" "opening_signal_source" NOT NULL,
	"opens_start" timestamp,
	"opens_end" timestamp,
	"closes_start" timestamp,
	"closes_end" timestamp,
	"evidence" text NOT NULL,
	"source_url" text,
	"reported_by_user_id" uuid,
	"observed_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"author_user_id" uuid NOT NULL,
	"club_id" uuid,
	"firm_id" uuid,
	"type" "post_type" NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"category" "firm_program_category",
	"school_id" uuid,
	"location" text,
	"link_url" text,
	"link_label" "post_link_label" DEFAULT 'details' NOT NULL,
	"starts_at" timestamp,
	"ends_at" timestamp,
	"published_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "practice_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"difficulty" text NOT NULL,
	"format" text DEFAULT 'written' NOT NULL,
	"categories" text[] NOT NULL,
	"score" integer NOT NULL,
	"max_score" integer NOT NULL,
	"questions_answered" integer NOT NULL,
	"best_streak" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resume_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"storage_path" text NOT NULL,
	"score" integer NOT NULL,
	"dimensions" jsonb NOT NULL,
	"summary" text NOT NULL,
	"strengths" text[] NOT NULL,
	"improvements" jsonb NOT NULL,
	"rewrites" jsonb,
	"job_description" text,
	"revised" jsonb,
	"revised_updated_at" timestamp,
	"revised_original" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email_domain" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "schools_email_domain_unique" UNIQUE("email_domain")
);
--> statement-breakpoint
CREATE TABLE "sector_priorities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category" "firm_program_category" NOT NULL,
	"priority_rank" integer NOT NULL,
	"description" text,
	CONSTRAINT "sector_priorities_category_unique" UNIQUE("category")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "submitted_people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"firm" text NOT NULL,
	"role" text,
	"group" text,
	"school" text,
	"linkedin_url" text,
	"background" text,
	"submitted_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "technical_quiz_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"category" "firm_program_category" NOT NULL,
	"topic" text NOT NULL,
	"difficulty" text NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"feedback" text,
	"score" integer,
	"score_lenient" integer,
	"score_medium" integer,
	"score_harsh" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_examples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"task" "training_task" NOT NULL,
	"outcome" "training_outcome" NOT NULL,
	"policy_version" text NOT NULL,
	"prompt_context" jsonb NOT NULL,
	"model_output" jsonb NOT NULL,
	"human_output" jsonb,
	"got_reply" boolean,
	"source_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "user_alert_kind" NOT NULL,
	"posting_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"read_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_top_firms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"firm_id" uuid NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text,
	"school" text,
	"grad_year" integer,
	"target_internship_year" integer,
	"target_group" text,
	"hometown" text,
	"major" text,
	"interests" text,
	"about_me" text,
	"show_hometown_on_profile" boolean DEFAULT false NOT NULL,
	"show_interests_on_profile" boolean DEFAULT false NOT NULL,
	"motivations" text,
	"proud_experience" text,
	"work_style" text,
	"challenge_learned" text,
	"preferred_categories" text[],
	"niche_interests" text[],
	"ib_tier_preferences" text[],
	"pe_tier_preferences" text[],
	"target_locations" text[],
	"recruiting_stage" text,
	"prior_experience" text[],
	"clubs_and_activities" text,
	"technical_readiness" text,
	"practice_current_streak" integer DEFAULT 0 NOT NULL,
	"practice_best_streak" integer DEFAULT 0 NOT NULL,
	"sponsorship_needed" text,
	"gpa_band" text,
	"onboarding_unsure" text[],
	"resume_text" text,
	"resume_parsed_at" timestamp,
	"linkedin_url" text,
	"avatar_storage_path" text,
	"resume_filename" text,
	"resume_storage_path" text,
	"resume_share_token" text,
	"top_firms_eligible_count" integer,
	"top_firms_matched_at" timestamp,
	"top_firms_target" integer,
	"profile_links_prompted_at" timestamp,
	"onboarding_completed_at" timestamp,
	"consented_policy_version" text,
	"consented_at" timestamp,
	"phone" text,
	"school_email" text,
	"pending_school_email" text,
	"school_email_verified_at" timestamp,
	"school_verification_code_hash" text,
	"school_verification_expires_at" timestamp,
	"school_verification_attempts" integer DEFAULT 0 NOT NULL,
	"school_id" uuid,
	"claimed_school_id" uuid,
	"account_type" "account_type" DEFAULT 'student' NOT NULL,
	"org_approved" boolean DEFAULT false NOT NULL,
	"club_id" uuid,
	"org_firm_id" uuid,
	"plan" "plan" DEFAULT 'free' NOT NULL,
	"role" "role" DEFAULT 'student' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_contacts" ADD CONSTRAINT "application_contacts_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_contacts" ADD CONSTRAINT "application_contacts_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "behavioral_answers" ADD CONSTRAINT "behavioral_answers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "behavioral_answers" ADD CONSTRAINT "behavioral_answers_question_id_behavioral_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."behavioral_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clubs" ADD CONSTRAINT "clubs_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_sourcing_runs" ADD CONSTRAINT "contact_sourcing_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_sourcing_runs" ADD CONSTRAINT "contact_sourcing_runs_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "detected_listings" ADD CONSTRAINT "detected_listings_source_id_firm_monitoring_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."firm_monitoring_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "detected_listings" ADD CONSTRAINT "detected_listings_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "detected_listings" ADD CONSTRAINT "detected_listings_promoted_posting_id_internship_postings_id_fk" FOREIGN KEY ("promoted_posting_id") REFERENCES "public"."internship_postings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_people" ADD CONSTRAINT "directory_people_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_archive" ADD CONSTRAINT "email_archive_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_archive" ADD CONSTRAINT "email_archive_draft_id_email_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."email_drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_connections" ADD CONSTRAINT "email_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_drafts" ADD CONSTRAINT "email_drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_drafts" ADD CONSTRAINT "email_drafts_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_email_patterns" ADD CONSTRAINT "firm_email_patterns_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_monitoring_sources" ADD CONSTRAINT "firm_monitoring_sources_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_monitoring_sources" ADD CONSTRAINT "firm_monitoring_sources_parent_firm_id_firms_id_fk" FOREIGN KEY ("parent_firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_monitoring_sources" ADD CONSTRAINT "firm_monitoring_sources_tier_id_monitoring_tiers_id_fk" FOREIGN KEY ("tier_id") REFERENCES "public"."monitoring_tiers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_programs" ADD CONSTRAINT "firm_programs_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_recruiting_contacts" ADD CONSTRAINT "firm_recruiting_contacts_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_follower_id_users_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_following_user_id_users_id_fk" FOREIGN KEY ("following_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internship_postings" ADD CONSTRAINT "internship_postings_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_check_runs" ADD CONSTRAINT "monitoring_check_runs_source_id_firm_monitoring_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."firm_monitoring_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_signals" ADD CONSTRAINT "opening_signals_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_signals" ADD CONSTRAINT "opening_signals_reported_by_user_id_users_id_fk" FOREIGN KEY ("reported_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_sessions" ADD CONSTRAINT "practice_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_reviews" ADD CONSTRAINT "resume_reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submitted_people" ADD CONSTRAINT "submitted_people_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technical_quiz_attempts" ADD CONSTRAINT "technical_quiz_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_examples" ADD CONSTRAINT "training_examples_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_alerts" ADD CONSTRAINT "user_alerts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_alerts" ADD CONSTRAINT "user_alerts_posting_id_internship_postings_id_fk" FOREIGN KEY ("posting_id") REFERENCES "public"."internship_postings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_top_firms" ADD CONSTRAINT "user_top_firms_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_top_firms" ADD CONSTRAINT "user_top_firms_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_claimed_school_id_schools_id_fk" FOREIGN KEY ("claimed_school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_org_firm_id_firms_id_fk" FOREIGN KEY ("org_firm_id") REFERENCES "public"."firms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_events_created_idx" ON "activity_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "activity_events_dedupe_idx" ON "activity_events" USING btree ("user_id","kind","dedupe_key");--> statement-breakpoint
CREATE INDEX "ai_usage_user_created_idx" ON "ai_usage" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "contact_sourcing_user_created_idx" ON "contact_sourcing_runs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "contact_sourcing_user_firm_idx" ON "contact_sourcing_runs" USING btree ("user_id","firm_id");--> statement-breakpoint
CREATE INDEX "detected_listings_source_idx" ON "detected_listings" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "detected_listings_review_status_idx" ON "detected_listings" USING btree ("review_status");--> statement-breakpoint
CREATE INDEX "directory_people_firm_idx" ON "directory_people" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "directory_people_school_idx" ON "directory_people" USING btree ("school");--> statement-breakpoint
CREATE INDEX "email_archive_draft_idx" ON "email_archive" USING btree ("draft_id");--> statement-breakpoint
CREATE INDEX "firm_monitoring_sources_next_check_idx" ON "firm_monitoring_sources" USING btree ("next_check_at");--> statement-breakpoint
CREATE INDEX "firm_monitoring_sources_firm_idx" ON "firm_monitoring_sources" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "firm_programs_category_idx" ON "firm_programs" USING btree ("category");--> statement-breakpoint
CREATE INDEX "firm_programs_firm_idx" ON "firm_programs" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "firm_recruiting_contacts_firm_idx" ON "firm_recruiting_contacts" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "follows_follower_idx" ON "follows" USING btree ("follower_id");--> statement-breakpoint
CREATE INDEX "follows_user_idx" ON "follows" USING btree ("following_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "follows_user_unique" ON "follows" USING btree ("follower_id","following_user_id") WHERE following_user_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "follows_club_unique" ON "follows" USING btree ("follower_id","club_id") WHERE club_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "follows_firm_unique" ON "follows" USING btree ("follower_id","firm_id") WHERE firm_id is not null;--> statement-breakpoint
CREATE INDEX "internship_postings_year_idx" ON "internship_postings" USING btree ("program_year");--> statement-breakpoint
CREATE INDEX "internship_postings_categories_idx" ON "internship_postings" USING gin ("categories");--> statement-breakpoint
CREATE INDEX "internship_postings_deadline_status_idx" ON "internship_postings" USING btree ("deadline_status");--> statement-breakpoint
CREATE INDEX "internship_postings_firm_idx" ON "internship_postings" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "messages_sender_idx" ON "messages" USING btree ("sender_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_recipient_idx" ON "messages" USING btree ("recipient_id","created_at");--> statement-breakpoint
CREATE INDEX "monitoring_check_runs_source_idx" ON "monitoring_check_runs" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "opening_signals_key_idx" ON "opening_signals" USING btree ("firm_id","cycle_year","program_category");--> statement-breakpoint
CREATE UNIQUE INDEX "opening_signals_source_idx" ON "opening_signals" USING btree ("firm_id","cycle_year","program_category","source");--> statement-breakpoint
CREATE INDEX "posts_published_idx" ON "posts" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "posts_club_idx" ON "posts" USING btree ("club_id","published_at");--> statement-breakpoint
CREATE INDEX "posts_firm_idx" ON "posts" USING btree ("firm_id","published_at");--> statement-breakpoint
CREATE INDEX "practice_sessions_user_score_idx" ON "practice_sessions" USING btree ("user_id","score");--> statement-breakpoint
CREATE INDEX "resume_reviews_user_idx" ON "resume_reviews" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "submitted_people_email_idx" ON "submitted_people" USING btree ("email");--> statement-breakpoint
CREATE INDEX "technical_quiz_user_created_idx" ON "technical_quiz_attempts" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "training_examples_task_idx" ON "training_examples" USING btree ("task","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "training_examples_source_idx" ON "training_examples" USING btree ("task","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_alerts_user_posting_kind_idx" ON "user_alerts" USING btree ("user_id","posting_id","kind");--> statement-breakpoint
CREATE INDEX "user_alerts_user_idx" ON "user_alerts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_top_firms_user_firm_idx" ON "user_top_firms" USING btree ("user_id","firm_id");