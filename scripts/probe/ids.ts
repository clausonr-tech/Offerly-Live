import { EMAIL_TYPES } from "../../src/lib/draft-templates";
const want = ["professor_recommendation","congratulations","keep_in_touch","linkedin_recommendation","visa_sponsorship_question","shadow_day_request","resume_review_request","speaker_invitation","mock_interview_request","withdraw_application","decline_offer","recorded_round_note","reference_request","thank_you_chat","thank_you_offered_help","thank_you_interview","thank_you_phone_screen","follow_up_1","follow_up_2","recruiting_inbox_follow_up","stalled_thread_nudge","interview_check_in","call_scheduling","recruiter_scheduling_reply","offer_deadline_extension","reschedule_call","cold_email","cold_not_alum","cold_referral","accept_offer","close_loop_referrer"];
const ids = new Set(EMAIL_TYPES.map(t=>t.id as string));
const bad = want.filter(w=>!ids.has(w));
console.log("label ids that DO NOT EXIST:", bad.length ? bad : "none");
console.log("all 41 ids:", EMAIL_TYPES.map(t=>t.id).join(", "));
