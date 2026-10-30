-- Standing training consent for the video coach: a student is asked once, at
-- their first "Start interview", whether to contribute their interviews'
-- recordings, and the answer stands for every interview after until they
-- change it on the setup page (src/lib/video-interview/consent.ts). The
-- answers go in the append-only consent log as two new kinds.
-- Widening a CHECK only: no row changes, and every existing row still passes.
-- Re-runnable: the constraint is dropped if present, then added back.

ALTER TABLE "video_interview_consent_events" DROP CONSTRAINT IF EXISTS "video_interview_consent_events_kind_check";--> statement-breakpoint
ALTER TABLE "video_interview_consent_events" ADD CONSTRAINT "video_interview_consent_events_kind_check" CHECK ("kind" IN ('analysis_granted', 'training_granted', 'training_revoked', 'training_standing_yes', 'training_standing_no'));
