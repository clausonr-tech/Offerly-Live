// Artifact 7: the date flagging in finishDraft.
import { finishDraft, type DraftPromptInput } from "../../../src/lib/draft-prompt";
import { base } from "./base";

const probe = (label: string, typed: Partial<DraftPromptInput>, bodyLine: string, subject = "Quick question") => {
  const body = `Hi Rachel,\n\n${bodyLine}\n\nBest,\nMaya`;
  const out = finishDraft({ ...base, ...typed }, { subject, body, connectionUsed: null, gaps: [] });
  console.log(`CASE: ${label}`);
  console.log(`  TYPED: ${JSON.stringify(typed.brief ?? typed.purpose ?? typed)}`);
  console.log(`  DRAFT: ${JSON.stringify(bodyLine)}  subject ${JSON.stringify(subject)}`);
  console.log(`  NOTES: ${JSON.stringify(out.notesForStudent)}`);
  console.log("");
};

const typed = (s: string): Partial<DraftPromptInput> => ({ brief: { conversationDetails: s } });

probe('student typed "10/5", draft says "October 5"', typed("call on 10/5"), "Thank you for the call on October 5.");
probe('student typed "10/5", draft says "Oct. 5th"', typed("call on 10/5"), "Thank you for the call on Oct. 5th.");
probe('student typed "10/5", draft says "5 October"', typed("call on 10/5"), "Thank you for the call on 5 October.");
probe('student typed "10/5", draft says "3rd of September"', typed("call on 10/5"), "Thank you for the call on the 3rd of September.");
probe('student typed "10/5", draft says "May 10" (the flipped reading)', typed("call on 10/5"), "Thank you for the call on May 10.");
probe('student typed nothing, draft says "October 5"', {}, "Thank you for the call on October 5.");
probe('student typed nothing, draft says "October 5" twice', {}, "On October 5 we spoke; October 5 was useful.");
probe('student typed nothing, draft says "Oct 5" and "Nov 6"', {}, "We spoke Oct 5 and I will follow up Nov 6.");
probe("date only in the SUBJECT", {}, "Thank you for your time.", "Following up on October 5");
probe("date inside a URL (month name path)", {}, "My calendar is at https://cal.com/maya/October 5 slot.");
probe("date inside a URL (hyphenated path)", {}, "My calendar is at https://cal.com/maya/October-5.");
probe("date inside a numeric URL path", {}, "See https://cal.com/maya/10/5 for slots.");
probe("February 30, not typed", {}, "Could we speak on February 30?");
probe("February 30, typed by the student", typed("maybe February 30?"), "Could we speak on February 30?");
probe('"1/2 hour" in what the student typed whitelists Jan 2 and Feb 1', typed("we spoke for 1/2 hour"), "Could we speak on January 2 or February 1?");
probe("a phone number in the profile does not whitelist", { studentPhone: "208/315" }, "Could we speak on August 15?");
probe("date in the resume summary counts as given", { studentResumeSummary: "WORK EXPERIENCE\n- Evercore · Analyst · started August 15" }, "Could we speak on August 15?");
probe("date in the model's signature block (stripped before flagging)", {}, "Thanks.\n\nBest,\nMaya\nIntern since October 5");
probe("May (the month that is also a verb)", {}, "May 5 suits me, and I may 6 be free.");
probe("'June 2026' with no day", {}, "I graduate in June 2026.");
probe("a year that reads as a day: 'March 2026'", {}, "I start in March 2026.");
probe("'Sept 5'", {}, "Could we speak Sept 5?");
probe("'09/05' typed, draft says 'September 5'", typed("09/05 works"), "Could we speak September 5?");
probe("'13/5' typed (day-first only), draft says 'May 13'", typed("13/5 works"), "Could we speak May 13?");
probe("ordinal with no month: 'the 5th'", {}, "Could we speak on the 5th?");
probe("time range '2-3pm' is not a date", {}, "Could we speak 2-3pm on October 5?");
