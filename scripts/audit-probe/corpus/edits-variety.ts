// CORPUS-VARIETY: the second edit table, written against the MEASUREMENT of
// what the 138-edit pass actually did (docs/concepts/audit/CORPUS-VARIETY.md).
//
// Same data shape and same applier as edits.ts, so every row is checked rather
// than retyped. The diagnosis these rows answer, in one line: the 138 edits did
// NOT make the bodies more alike (every inter-body similarity measure fell,
// aggregate and within-type). What they did was halve the corpus's coverage of
// the TIMING-ACCOMMODATION move - the sentence that bends to the recipient's
// calendar - from 62 demonstrations to 30, while raising the share of those
// demonstrations that are one identical cliche from 13% to 23%. A move the
// drafter must still make, with nothing varied left to copy, is written from
// the model's own default instead, identically in every draft - which is
// exactly `repeatedSentences` across drafts going up.
//
// Three groups:
//   A  the 17 instances of "happy to work around your schedule" and its
//      variants, each rewritten into a DIFFERENT construction built from that
//      body's own content. This is the group that fixes the regression.
//   B  14 bodies in the cold-outreach types where the move was deleted and
//      nothing took its place, each given a different form of it.
//   C  Tier 4, which CORPUS-EDIT-PLAN.md specifies and deliberately leaves
//      unenumerated: the closing mix. 164 of 192 bodies closed on a thank-you.
//      These 26 change the mix ONLY in types where thanks is not the point -
//      cold outreach, follow-ups, check-ins, scheduling, keep-in-touch. No
//      thank-you type is touched: those should thank.
//
// Every replacement is built from words already in its own body, so no fact is
// added and none is lost. `shape` names the construction, and
// variety-check.ts asserts no two rows share one.

export type VarietyEdit = {
  key: string;
  find: string;
  replace: string;
  group: "A-move-cliche" | "B-move-restored" | "C-tier4-closing";
  shape: string;
};

export const VARIETY_EDITS: VarietyEdit[] = [
  // =====================================================================
  // GROUP A - the cliche, 17 times, each into a different construction.
  // "I am very flexible and happy to work around your schedule" is the most
  // repeated sentence in the corpus: 7 verbatim copies plus 5 near ones,
  // across six types the 138 edits never touched.
  // =====================================================================
  { key: "conference_follow_up#3", group: "A-move-cliche", shape: "names two concrete windows",
    find: "I am very flexible and more than happy to work around your schedule.",
    replace: "I can take a call between classes on most days, or after five on any of them." },
  { key: "follow_up_1#1", group: "A-move-cliche", shape: "names the two easy ends of the day",
    find: "I am more than happy to work around your schedule!",
    replace: "Early mornings and late afternoons are both easy for me." },
  { key: "follow_up_1#3", group: "A-move-cliche", shape: "takes the leftovers",
    find: "I am very flexible and happy to work around your schedule.",
    replace: "I will take whatever time your week has left over." },
  { key: "follow_up_1#4", group: "A-move-cliche", shape: "shrinks the ask to a gap between their meetings",
    find: "I am more than happy to work around your schedule!",
    replace: "Even a few minutes between your own meetings would help." },
  { key: "follow_up_1#5", group: "A-move-cliche", shape: "enumerates availability instead of claiming it",
    find: "I am very flexible and happy to work around your schedule.",
    replace: "Mornings, evenings and weekends are all open on my side." },
  { key: "follow_up_1#6", group: "A-move-cliche", shape: "imperative hand-off, keeps the hour free",
    find: "I am more than happy to work around your schedule.",
    replace: "Name an hour and I will keep it free." },
  { key: "follow_up_1#7", group: "A-move-cliche", shape: "prices the call at nothing",
    find: "I am very flexible and happy to work around your schedule.",
    replace: "I can be free at an hour that costs you nothing." },
  // The sentence sits immediately before this body's own table of windows, so
  // it says in the abstract what the next four lines say concretely. Deleting
  // it leaves the move demonstrated twice over, by the table and by "name a
  // time and I will make it work" further down.
  { key: "call_scheduling#1", group: "A-move-cliche", shape: "deleted: the table below already is the move",
    find: "I am happy to work entirely around your schedule. A few windows",
    replace: "A few windows" },
  { key: "not_now_reply#2", group: "A-move-cliche", shape: "accommodation as a later date, not a claim of flexibility",
    find: "I am very flexible and glad to work around your schedule, and if the timing is still difficult, I am happy to try again after the new year.",
    replace: "If the timing is still difficult, I am glad to come back again after the new year." },
  { key: "thank_you_event#1", group: "A-move-cliche", shape: "any hour, smallest unit",
    find: "I am more than happy to work around your schedule.",
    replace: "Any ten minutes you have, at any hour, would be plenty." },
  { key: "thank_you_event#2", group: "A-move-cliche", shape: "fits the recipient's own staffing answer",
    find: "I am very flexible and happy to work around your schedule.",
    replace: "I can dial in at whatever hour suits a two-person deal team." },
  { key: "thank_you_event#3", group: "A-move-cliche", shape: "around the trading day the body is about",
    find: "I am more than happy to work around your schedule.",
    replace: "I can be free before the market opens or well after it closes." },
  { key: "thank_you_event#5", group: "A-move-cliche", shape: "states the absence of commitments, hands over the choice",
    find: "I am very flexible and happy to work around your schedule.",
    replace: "I have no fixed commitments most afternoons, so you can choose the hour." },
  { key: "second_conversation#1", group: "A-move-cliche", shape: "callback to the write-ups the body reports",
    find: "I am very flexible and happy to work around your schedule.",
    replace: "I can clear an afternoon for it, the way I cleared them for the write-ups." },
  { key: "second_conversation#2", group: "A-move-cliche", shape: "bounded by the body's own deadline",
    find: "I am glad to work entirely around your schedule.",
    replace: "Any hour between now and the thirtieth works on my end." },
  { key: "second_conversation#3", group: "A-move-cliche", shape: "fits around the job the body names",
    find: "I am very flexible and happy to work around your schedule.",
    replace: "I can take the call on a break at the shop if that is what fits." },
  { key: "reschedule_call#1", group: "A-move-cliche", shape: "builds the week around their answer",
    find: "If none of those fit, I am happy to work entirely around whatever is easiest for you.",
    replace: "If none of those fit, say the word and I will build the week around it." },

  // =====================================================================
  // GROUP B - the move restored where the 138 edits deleted it and put
  // nothing in its place. In cold_email, cold_after_meeting, cold_not_alum
  // and conference_follow_up the deletion was the whole edit, so the type
  // stopped demonstrating a move its own format still requires.
  // =====================================================================
  { key: "cold_email#5", group: "B-move-restored", shape: "around the job the body names (library desk)",
    find: "I attached a copy of my resume.",
    replace: "I attached a copy of my resume. I can fit a call around a shift at the circulation desk, so almost any hour works." },
  { key: "cold_email#6", group: "B-move-restored", shape: "counts the free afternoons",
    find: "I attached a copy of my resume.",
    replace: "I attached a copy of my resume. My afternoons are free three days a week, so you can choose what is least trouble." },
  { key: "cold_email#7", group: "B-move-restored", shape: "offers the two unsociable hours",
    find: "I attached my resume.",
    replace: "I attached my resume. Seven in the morning or nine at night are both fine by me." },
  { key: "cold_email#8", group: "B-move-restored", shape: "steps out of the shift the body names",
    find: "A resume is attached.",
    replace: "A resume is attached. I can step outside the coffee shop for a call at any point in a shift." },
  { key: "cold_after_meeting#5", group: "B-move-restored", shape: "adds the weekend",
    find: "I attached my resume, though it is still a work in progress.",
    replace: "I attached my resume, though it is still a work in progress. Any afternoon works for me, and weekends too if that is easier." },
  { key: "cold_after_meeting#6", group: "B-move-restored", shape: "two named days, wide open",
    find: "I included my resume.",
    replace: "I included my resume. Evenings and Fridays are wide open on my end." },
  { key: "cold_not_alum#1", group: "B-move-restored", shape: "one half of every weekday",
    find: "I attached a copy of my resume.",
    replace: "I attached a copy of my resume. Any weekday before noon is free for me, and most evenings are as well." },
  { key: "cold_not_alum#3", group: "B-move-restored", shape: "defers to a deal timeline over a student one",
    find: "I included a copy of my resume.",
    replace: "I included a copy of my resume. I can make any hour work, including one that suits a deal timeline rather than a student schedule." },
  { key: "cold_not_alum#5", group: "B-move-restored", shape: "least in the way of their day",
    find: "I attached my resume.",
    replace: "I attached my resume. I can be free at whatever hour is least in the way of your day." },
  { key: "cold_not_alum#7", group: "B-move-restored", shape: "time zones, from the body's own international-student fact",
    find: "I attached my resume.",
    replace: "I attached my resume. I am five hours ahead of you most of the year, so an early call on your side is easy on mine." },
  { key: "cold_referral#1", group: "B-move-restored", shape: "short notice",
    find: "Resume attached.",
    replace: "Resume attached. I can be free at short notice if a gap opens up." },
  { key: "cold_referral#7", group: "B-move-restored", shape: "a whole month, either end of the day",
    find: "Would you have 15 minutes for a call?",
    replace: "Would you have 15 minutes for a call? Any day this month works, early or late." },
  { key: "conference_follow_up#1", group: "B-move-restored", shape: "from campus, almost any hour",
    find: "I attached my resume.",
    replace: "I attached my resume. I can take the call from campus at almost any hour." },
  { key: "conference_follow_up#2", group: "B-move-restored", shape: "mornings between classes, or an evening",
    find: "A resume is attached.",
    replace: "A resume is attached. Between classes I am free most mornings, and I can make an evening work too." },

  // =====================================================================
  // GROUP C - TIER 4. The closing mix, in types where thanks is not the
  // point. 164 of 192 bodies closed on a thank-you and the top four strings
  // accounted for 34 of them. Not one thank-you type is touched here.
  // =====================================================================
  // "Thank you again!" x12 -> x6. The six changed are the six that are not
  // thank-you types.
  { key: "follow_up_1#3", group: "C-tier4-closing", shape: "appreciation, no thanks: the second email",
    find: "Thank you again!", replace: "I appreciate you reading a second email." },
  { key: "follow_up_1#7", group: "C-tier4-closing", shape: "specific thanks: the article, named",
    find: "Thank you again!", replace: "Thank you for the supplier financing piece." },
  { key: "interview_check_in#4", group: "C-tier4-closing", shape: "closes on the outcome, not on thanks",
    find: "Thank you again!", replace: "Whatever the outcome, I will be glad I met the team." },
  { key: "interview_check_in#6", group: "C-tier4-closing", shape: "callback to the body's own thirty minutes",
    find: "Thank you again!", replace: "Those thirty minutes are still paying off." },
  { key: "redirect_sequence#1", group: "C-tier4-closing", shape: "closes on the next step",
    find: "Thank you again!", replace: "Let me know which you prefer and I will take it from there." },
  { key: "keep_in_touch#5", group: "C-tier4-closing", shape: "closes on a promise, not a thanks",
    find: "Thank you again!", replace: "I owe you a good update next time." },

  // "Thank you so much!" x9 -> x1.
  { key: "cold_referral#2", group: "C-tier4-closing", shape: "specific thanks: the subject of the ask",
    find: "Thank you so much!", replace: "Thank you for whatever you can tell me about restructuring." },
  { key: "cold_referral#4", group: "C-tier4-closing", shape: "specific thanks: reading it in a busy week",
    find: "Thank you so much!", replace: "Thank you for reading it on a busy week." },
  { key: "cold_referral#6", group: "C-tier4-closing", shape: "specific thanks: the body's own joke",
    find: "Thank you so much!", replace: "Thank you for having had that conversation with yourself first." },
  { key: "follow_up_1#2", group: "C-tier4-closing", shape: "closes by naming what it wants to hear",
    find: "Thank you so much!", replace: "Nyquist Wells is the part I most want to hear about." },
  { key: "follow_up_1#6", group: "C-tier4-closing", shape: "credits the referrer the body names",
    find: "Thank you so much!", replace: "Professor Halliwell was right to put us in touch." },
  { key: "keep_in_touch#3", group: "C-tier4-closing", shape: "closes on a wish about their news",
    find: "Thank you so much!", replace: "I hope Fund IV treats you well." },
  { key: "second_conversation#2", group: "C-tier4-closing", shape: "closes on what the student will do",
    find: "Thank you so much!", replace: "I will submit either way, but I would rather do it informed." },
  { key: "not_now_reply#2", group: "C-tier4-closing", shape: "appreciation for the timing they gave",
    find: "Thank you so much!", replace: "I appreciate you saying when to come back." },

  // "Thank you so much for your time!" x5 -> x1.
  { key: "conference_follow_up#1", group: "C-tier4-closing", shape: "closes on why the email exists",
    find: "Thank you so much for your time!", replace: "That conversation is why I am writing at all." },
  { key: "follow_up_2#6", group: "C-tier4-closing", shape: "names what silence will mean, closing the last email",
    find: "Thank you so much for your time!", replace: "I will take silence as a no and leave it there." },
  { key: "interview_check_in#2", group: "C-tier4-closing", shape: "acknowledges the wait is not theirs either",
    find: "Thank you so much for your time!", replace: "I appreciate the wait being out of your hands too." },
  { key: "redirect_sequence#2", group: "C-tier4-closing", shape: "makes a refusal as welcome as a yes",
    find: "Thank you so much for your time!", replace: "A quick no is just as useful to me." },

  // "Thank you again for your time!" x6 -> x4 (the other four are thank-you types).
  { key: "interview_check_in#1", group: "C-tier4-closing", shape: "gratitude for the conversation, not the time",
    find: "Thank you again for your time!", replace: "I am grateful the first conversation happened at all." },
  { key: "recruiter_follow_up#1", group: "C-tier4-closing", shape: "closes by making the reply cheap",
    find: "Thank you again for your time!", replace: "A link would save you the typing." },

  // "Thank you very much for your time!" x4 -> x2.
  { key: "recruiter_outreach#3", group: "C-tier4-closing", shape: "closes on how little would suffice",
    find: "Thank you very much for your time!", replace: "Either answer, however short, would help a great deal." },
  { key: "recruiter_outreach#4", group: "C-tier4-closing", shape: "closes on a one-line answer",
    find: "Thank you very much for your time!", replace: "A one-line answer to either question would be plenty." },

  // "Thank you again for coming to campus!" x3 -> x1.
  { key: "cold_after_meeting#1", group: "C-tier4-closing", shape: "specific thanks: the answer, named",
    find: "Thank you again for coming to campus!", replace: "Thank you for the half-size answer in particular!" },
  { key: "follow_up_1#5", group: "C-tier4-closing", shape: "closes on the event being worth it",
    find: "Thank you again for coming to campus!", replace: "Either way, the Career Night was worth attending." },

  // "Thank you again for everything!" x7 -> x5 (the other five are thank-you types).
  { key: "keep_in_touch#4", group: "C-tier4-closing", shape: "closes on a wish about their move",
    find: "Thank you again for everything!", replace: "I hope Houston is treating you well." },
  { key: "referral_ask#4", group: "C-tier4-closing", shape: "the offer counted even unfulfilled",
    find: "Thank you again for everything!", replace: "The offer itself already helped." },
];
