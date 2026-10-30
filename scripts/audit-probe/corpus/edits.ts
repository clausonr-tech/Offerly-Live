// CORPUS-PLAN: the edit table as data, so it can be applied and checked
// mechanically rather than read and retyped.
//
// Each row is one find/replace against one gold body. `find` must occur EXACTLY
// ONCE in that body; apply-check.ts asserts it. Nothing here is written to
// disk by any probe - apply-check.ts applies these in memory only.
//
// Tags in `fixes`:
//   pleasantry  the opener was a pleasantry in front of an actual hook
//   canned-fyr  "for your reference"
//   canned-flex the flexibility/"very flexible" courtesy line
//   canned-lfth "I look forward to hearing from you"
//   closing     the closing was a thanks-for-your-time formula
//   contraction adds a contraction (full form -> contracted; no fact changes)
//   throat      "I wanted to ..." throat-clearing
//   repeat      a sentence repeated verbatim elsewhere in the corpus
//
// `shape` names the variety slot, so a reviewer can check at a glance that the
// replacements are not 32 copies of one new sentence.

export type Edit = {
  /** Where the body lives. */
  file: "email-examples.ts" | "email-examples-v3.json" | "email-examples-v4.json";
  /** EMAIL_EXAMPLES key, 1-based within the type. */
  key: string;
  find: string;
  replace: string;
  fixes: string[];
  shape: string;
};

export const EDITS: Edit[] = [
  // =====================================================================
  // TIER 1a - cold_referral (8 bodies). The playbook's own Volume V
  // section 1 format rule says "open the first sentence with the
  // referrer's name"; all 8 gold bodies put a pleasantry in front of it.
  // Deleting the pleasantry makes the gold corpus agree with the
  // playbook, costs no words and changes no fact.
  // =====================================================================
  {
    file: "email-examples.ts", key: "cold_referral#1",
    find: "I hope this email finds you well! Sarah Chen suggested",
    replace: "Sarah Chen suggested",
    fixes: ["pleasantry", "repeat"], shape: "delete-pleasantry",
  },
  {
    file: "email-examples.ts", key: "cold_referral#1",
    find: "I am more than happy to work around your schedule, so please let me know if a specific time works best for you. I also attached a copy of my resume for your reference.",
    replace: "Resume attached.",
    fixes: ["canned-flex", "canned-fyr"], shape: "flex-delete + R1-fragment",
  },
  {
    file: "email-examples.ts", key: "cold_referral#1",
    find: "Thank you so much for your time, and I look forward to hearing from you!",
    replace: "Thank you for considering it, and for whatever you can tell me about the credit team.",
    fixes: ["closing", "canned-lfth"], shape: "C1-thanks-for-the-specific-thing",
  },

  {
    file: "email-examples.ts", key: "cold_referral#2",
    find: "I hope you are doing well! Professor Ellis Vance",
    replace: "Professor Ellis Vance",
    fixes: ["pleasantry", "repeat"], shape: "delete-pleasantry",
  },
  {
    file: "email-examples.ts", key: "cold_referral#2",
    find: " I am very flexible and happy to work around your schedule, and I attached my resume for your reference.",
    replace: " I attached my resume in case the background is useful.",
    fixes: ["canned-flex", "canned-fyr"], shape: "flex-delete + R2-purpose-clause",
  },

  {
    file: "email-examples.ts", key: "cold_referral#3",
    find: "I hope all is well with you! Dan Pruitt",
    replace: "Dan Pruitt",
    fixes: ["pleasantry", "repeat"], shape: "delete-pleasantry",
  },
  {
    file: "email-examples.ts", key: "cold_referral#3",
    find: "I have developed an immense passion for the finance world over the past two years",
    replace: "I’ve developed an immense passion for the finance world over the past two years",
    fixes: ["contraction"], shape: "contraction-swap",
  },
  {
    file: "email-examples.ts", key: "cold_referral#3",
    find: " I am more than happy to work around your schedule. I also attached a copy of my resume for your reference.",
    replace: "",
    fixes: ["canned-flex", "canned-fyr"], shape: "flex-delete + R0-no-resume-sentence",
  },
  {
    file: "email-examples.ts", key: "cold_referral#3",
    find: "Thank you so much for your time, and I look forward to hopefully speaking with you!",
    replace: "Thank you either way, and please pass my regards to Dan.",
    fixes: ["closing"], shape: "C3-close-on-the-person",
  },

  {
    file: "email-examples.ts", key: "cold_referral#4",
    find: "I hope you are having a great week! I spoke with Jake Abbott",
    replace: "I spoke with Jake Abbott",
    fixes: ["pleasantry"], shape: "delete-pleasantry",
  },
  {
    file: "email-examples.ts", key: "cold_referral#4",
    find: " I am very flexible and more than happy to work around your schedule, and I attached a copy of my resume for your reference.",
    replace: " A resume is attached.",
    fixes: ["canned-flex", "canned-fyr"], shape: "flex-delete + R2-impersonal",
  },

  {
    file: "email-examples-v3.json", key: "cold_referral#5",
    find: "I hope you are having a good week! Harriet Loewen",
    replace: "Harriet Loewen",
    fixes: ["pleasantry"], shape: "delete-pleasantry",
  },
  {
    file: "email-examples-v3.json", key: "cold_referral#5",
    find: "I do not have an internship yet, but I help run",
    replace: "I don’t have an internship yet, but I help run",
    fixes: ["contraction"], shape: "contraction-swap",
  },
  {
    file: "email-examples-v3.json", key: "cold_referral#5",
    find: " I am very flexible and more than happy to work around your schedule, and I attached my resume for your reference.",
    replace: " I have no constraints on my end, and I attached a resume.",
    fixes: ["canned-flex", "canned-fyr"], shape: "F-c-no-constraints + R1-bare",
  },
  {
    file: "email-examples-v3.json", key: "cold_referral#5",
    find: "Thank you so much for your time!",
    replace: "Thank you for even reading a freshman’s email!",
    fixes: ["closing"], shape: "C1-thanks-for-the-specific-thing",
  },

  {
    file: "email-examples-v3.json", key: "cold_referral#6",
    find: "I hope this email finds you well! Professor Imogen Halliwell",
    replace: "Professor Imogen Halliwell",
    fixes: ["pleasantry", "repeat"], shape: "delete-pleasantry",
  },
  {
    file: "email-examples-v3.json", key: "cold_referral#6",
    find: " I am very flexible and happy to work around your schedule, and I attached my resume for your reference.",
    replace: " I attached my resume, though the engineering half of it will be more legible than the finance half.",
    fixes: ["canned-flex", "canned-fyr"], shape: "flex-delete + R3-honest-caveat",
  },

  {
    file: "email-examples-v4.json", key: "cold_referral#7",
    find: "I hope this email finds you well! Devin Oyelaran",
    replace: "Devin Oyelaran",
    fixes: ["pleasantry", "repeat"], shape: "delete-pleasantry",
  },
  {
    file: "email-examples-v4.json", key: "cold_referral#7",
    find: "My name is Grant Feldstrom, and I am a sophomore at Halverson",
    replace: "My name is Grant Feldstrom, and I’m a sophomore at Halverson",
    fixes: ["contraction"], shape: "contraction-swap",
  },
  {
    file: "email-examples-v4.json", key: "cold_referral#7",
    find: " I am very flexible and happy to work around your schedule, and I attached my resume for your reference.",
    replace: "",
    fixes: ["canned-flex", "canned-fyr"], shape: "flex-delete + R0-no-resume-sentence",
  },
  {
    file: "email-examples-v4.json", key: "cold_referral#7",
    find: "Thank you so much for your time!",
    replace: "Thank you, and I hope the speaker night was worth the trip.",
    fixes: ["closing"], shape: "C3-close-on-the-specific-thing",
  },

  {
    file: "email-examples-v4.json", key: "cold_referral#8",
    find: "I hope this email finds you well! My uncle, Rob Osgood, suggested",
    replace: "My uncle, Rob Osgood, suggested",
    fixes: ["pleasantry", "repeat"], shape: "delete-pleasantry",
  },
  {
    file: "email-examples-v4.json", key: "cold_referral#8",
    find: "My name is Dani Osgood, and I am a senior at Marchbank",
    replace: "My name is Dani Osgood, and I’m a senior at Marchbank",
    fixes: ["contraction"], shape: "contraction-swap",
  },
  {
    file: "email-examples-v4.json", key: "cold_referral#8",
    find: "If you have 15 minutes for a call, I would be grateful, and I am very flexible.",
    replace: "If you have 15 minutes for a call, I would be grateful. I can move anything on my end.",
    fixes: ["canned-flex"], shape: "F-h-move-anything + short-sentence",
  },
  {
    file: "email-examples-v4.json", key: "cold_referral#8",
    find: "I attached my resume for your reference. Thank you so much for your time!",
    replace: "I attached my resume. Thank you for treating it as a normal student email.",
    fixes: ["canned-fyr", "closing"], shape: "R4-plain + C1-thanks-for-the-specific-thing",
  },

  // =====================================================================
  // TIER 1b - cold_after_meeting (7 bodies). Only 1 of 7 opens on a
  // pleasantry and that one is SPECIFIC ("made it home safely on
  // Thursday") - the corpus's single good example of the shape, kept
  // deliberately. The defect here is the courtesy block and the closing.
  // =====================================================================
  {
    file: "email-examples.ts", key: "cold_after_meeting#1",
    find: " I am more than happy to work around your schedule, so please let me know if a specific time works better for you. I also attached a copy of my resume for your reference.",
    replace: "",
    fixes: ["canned-flex", "canned-fyr"], shape: "flex-delete + R0-no-resume-sentence",
  },
  {
    file: "email-examples.ts", key: "cold_after_meeting#1",
    find: "Thank you again for coming to campus, and I look forward to hearing from you!",
    replace: "Thank you again for coming to campus!",
    fixes: ["canned-lfth"], shape: "C5-keep-the-specific-close",
  },

  {
    file: "email-examples.ts", key: "cold_after_meeting#2",
    find: "I attached one here as well so that it does not get lost.",
    replace: "I attached one here as well so it doesn’t get lost.",
    fixes: ["contraction"], shape: "contraction-swap",
  },
  {
    file: "email-examples.ts", key: "cold_after_meeting#2",
    find: " I am very flexible and more than happy to work around your schedule!",
    replace: "",
    fixes: ["canned-flex"], shape: "flex-delete",
  },
  {
    file: "email-examples.ts", key: "cold_after_meeting#2",
    find: "Thank you so much for your time!",
    replace: "Thank you for standing in that line with me!",
    fixes: ["closing"], shape: "C1-thanks-for-the-specific-thing",
  },

  {
    file: "email-examples.ts", key: "cold_after_meeting#3",
    find: " I am more than happy to work around your schedule, and I attached a copy of my resume for your reference.",
    replace: " I attached my resume, in case the advisory question is easier to answer with it in front of you.",
    fixes: ["canned-flex", "canned-fyr"], shape: "flex-delete + R2-purpose-clause",
  },

  {
    file: "email-examples.ts", key: "cold_after_meeting#4",
    find: "which I have not stopped thinking about since",
    replace: "which I haven’t stopped thinking about since",
    fixes: ["contraction"], shape: "contraction-swap",
  },
  {
    file: "email-examples.ts", key: "cold_after_meeting#4",
    find: " I am very flexible and happy to work around your schedule, and I attached my resume for your reference.",
    replace: " Whatever is least disruptive for you is fine. I attached a resume.",
    fixes: ["canned-flex", "canned-fyr"], shape: "F-d-least-disruptive + R1-bare",
  },
  {
    file: "email-examples.ts", key: "cold_after_meeting#4",
    find: "Thank you so much for your time!",
    replace: "Thank you for judging, and for the exit question in particular!",
    fixes: ["closing"], shape: "C1-thanks-for-the-specific-thing",
  },

  {
    file: "email-examples-v3.json", key: "cold_after_meeting#5",
    find: " I am very flexible and more than happy to work around your schedule. I attached my resume, though it is still a work in progress.",
    replace: " I attached my resume, though it is still a work in progress.",
    fixes: ["canned-flex"], shape: "flex-delete + R3-honest-caveat-kept",
  },

  {
    file: "email-examples-v3.json", key: "cold_after_meeting#6",
    find: "who asked whether your team ever hires people who cannot yet build a model",
    replace: "who asked whether your team ever hires people who can’t yet build a model",
    fixes: ["contraction"], shape: "contraction-swap",
  },
  {
    file: "email-examples-v3.json", key: "cold_after_meeting#6",
    find: "and I am working through the financial half now",
    replace: "and I’m working through the financial half now",
    fixes: ["contraction"], shape: "contraction-swap",
  },
  {
    file: "email-examples-v3.json", key: "cold_after_meeting#6",
    find: " I am very flexible and happy to work around your schedule, and I attached a copy of my resume for your reference.",
    replace: " I included my resume.",
    fixes: ["canned-flex", "canned-fyr"], shape: "flex-delete + R3-included",
  },
  {
    file: "email-examples-v3.json", key: "cold_after_meeting#6",
    find: "Thank you so much for your time!",
    replace: "Thank you for staying to talk to the engineers!",
    fixes: ["closing"], shape: "C1-thanks-for-the-specific-thing",
  },

  {
    file: "email-examples-v4.json", key: "cold_after_meeting#7",
    find: " I am very flexible and glad to work around your schedule, and I attached my resume for your reference.",
    replace: " I’m easy on timing. The resume is attached.",
    fixes: ["canned-flex", "canned-fyr", "contraction"], shape: "F-g-short-sentence + R1-bare",
  },

  // =====================================================================
  // TIER 1c - cold_email (9 bodies). 9 of 9 open on a pleasantry and 9 of 9
  // carry a flexibility line. Three pleasantries are KEPT on purpose: this
  // is the one type that can genuinely have no hook (a name out of an
  // alumni directory), and VOICE_RULES permits a pleasantry exactly there.
  // =====================================================================
  {
    file: "email-examples-v3.json", key: "cold_email#1",
    find: "I hope this email finds you well!",
    replace: "I hope your week is going well!",
    fixes: ["repeat"], shape: "vary-the-kept-pleasantry",
  },
  {
    file: "email-examples-v3.json", key: "cold_email#1",
    find: " I am more than happy to work around your schedule, so please let me know if a specific time works better for you. In addition, I attached a copy of my resume for your reference.",
    replace: " Please pick whatever time is easiest; I attached a resume.",
    fixes: ["canned-flex", "canned-fyr"], shape: "F-i-please-pick + R5-semicolon",
  },
  {
    file: "email-examples-v3.json", key: "cold_email#1",
    find: "Thank you for your time, and I look forward to hearing back from you!",
    replace: "Thank you for reading this far!",
    fixes: ["closing"], shape: "C1-thanks-for-the-specific-thing",
  },

  {
    file: "email-examples-v3.json", key: "cold_email#2",
    find: "I hope this email finds you well! My name is Nadia",
    replace: "My name is Nadia",
    fixes: ["pleasantry", "repeat"], shape: "delete-pleasantry",
  },
  {
    file: "email-examples-v3.json", key: "cold_email#2",
    find: " I am more than happy to work around your schedule, so please let me know if a certain time works for you. Additionally, I have attached a copy of my resume for your reference.",
    replace: " Additionally, I have attached a copy of my resume.",
    fixes: ["canned-flex", "canned-fyr"], shape: "flex-delete + R6-drop-fyr-only",
  },
  {
    file: "email-examples-v3.json", key: "cold_email#2",
    find: "Thank you for your time, and I look forward to hearing from you!",
    replace: "I appreciate you reading this.",
    fixes: ["closing", "canned-lfth"], shape: "C4-appreciation-not-thanks",
  },

  {
    file: "email-examples-v3.json", key: "cold_email#3",
    find: "I hope all is well with you! My name is Owen",
    replace: "My name is Owen",
    fixes: ["pleasantry", "repeat"], shape: "delete-pleasantry",
  },
  {
    file: "email-examples-v3.json", key: "cold_email#3",
    find: "I do not have a professional internship yet",
    replace: "I don’t have a professional internship yet",
    fixes: ["contraction"], shape: "contraction-swap",
  },
  {
    file: "email-examples-v3.json", key: "cold_email#3",
    find: " I am very flexible and more than happy to work around your schedule. I attached a copy of my resume for your reference, though it is still fairly light.",
    replace: " I can work around you entirely. I attached a resume, though it is still fairly light.",
    fixes: ["canned-flex", "canned-fyr"], shape: "F-a-work-around-you + R7-honest-caveat",
  },
  {
    file: "email-examples-v3.json", key: "cold_email#3",
    find: "Thank you so much for your time!",
    replace: "Thank you for whatever you can spare!",
    fixes: ["closing", "repeat"], shape: "C3-close-on-the-ask",
  },

  {
    file: "email-examples-v3.json", key: "cold_email#4",
    find: "alumni network and wanted to reach out regarding a startup that I am building",
    replace: "alumni network, and I am writing about a startup I am building",
    fixes: ["throat"], shape: "cut-throat-clearing",
  },
  {
    file: "email-examples-v3.json", key: "cold_email#4",
    find: " I am more than happy to work around your schedule.",
    replace: "",
    fixes: ["canned-flex"], shape: "flex-delete",
  },

  {
    file: "email-examples-v3.json", key: "cold_email#5",
    find: "I hope this email finds you well! My name is Owen",
    replace: "My name is Owen",
    fixes: ["pleasantry", "repeat"], shape: "delete-pleasantry",
  },
  {
    file: "email-examples-v3.json", key: "cold_email#5",
    find: "I am early enough that I do not have an internship to point to yet.",
    replace: "I’m early enough that I don’t have an internship to point to yet.",
    fixes: ["contraction"], shape: "contraction-swap",
  },
  {
    file: "email-examples-v3.json", key: "cold_email#5",
    find: " I am very flexible and more than happy to work around your schedule. I attached a copy of my resume for your reference.",
    replace: " I attached a copy of my resume.",
    fixes: ["canned-flex", "canned-fyr"], shape: "flex-delete + R6-drop-fyr-only",
  },
  {
    file: "email-examples-v3.json", key: "cold_email#5",
    find: "Thank you so much for your time!",
    replace: "Thank you, and I hope the fall is treating you well.",
    fixes: ["closing", "repeat"], shape: "C6-thanks-plus-a-wish",
  },

  {
    file: "email-examples-v3.json", key: "cold_email#6",
    find: "I hope you are doing well! My name is Priya",
    replace: "My name is Priya",
    fixes: ["pleasantry", "repeat"], shape: "delete-pleasantry",
  },
  {
    file: "email-examples-v3.json", key: "cold_email#6",
    find: "and it is what I have been reading about ever since",
    replace: "and it’s what I’ve been reading about ever since",
    fixes: ["contraction"], shape: "contraction-swap",
  },
  {
    file: "email-examples-v3.json", key: "cold_email#6",
    find: " I am happy to work entirely around your schedule, and I attached a copy of my resume for your reference.",
    replace: " I attached a copy of my resume.",
    fixes: ["canned-flex", "canned-fyr"], shape: "flex-delete + R6-drop-fyr-only",
  },
  {
    file: "email-examples-v3.json", key: "cold_email#6",
    find: "Thank you so much for your time!",
    replace: "I appreciate the time either way.",
    fixes: ["closing", "repeat"], shape: "C4-appreciation-not-thanks",
  },

  {
    file: "email-examples-v4.json", key: "cold_email#7",
    find: "I hope this email finds you well! My name is Elliot",
    replace: "My name is Elliot",
    fixes: ["pleasantry", "repeat"], shape: "delete-pleasantry",
  },
  {
    file: "email-examples-v4.json", key: "cold_email#7",
    find: " I am happy to work entirely around your schedule, and I attached my resume for your reference.",
    replace: " I attached my resume.",
    fixes: ["canned-flex", "canned-fyr"], shape: "flex-delete + R4-plain",
  },
  {
    file: "email-examples-v4.json", key: "cold_email#7",
    find: "Thank you for your time!",
    replace: "Thank you for considering it.",
    fixes: ["closing"], shape: "C2-short-thanks",
  },

  {
    file: "email-examples-v4.json", key: "cold_email#8",
    find: "I hope this email finds you well! My name is Jocelyn",
    replace: "My name is Jocelyn",
    fixes: ["pleasantry", "repeat"], shape: "delete-pleasantry",
  },
  {
    file: "email-examples-v4.json", key: "cold_email#8",
    find: "My name is Jocelyn Ampofo, and I am a junior at Halverson",
    replace: "My name is Jocelyn Ampofo, and I’m a junior at Halverson",
    fixes: ["contraction"], shape: "contraction-swap",
  },
  {
    file: "email-examples-v4.json", key: "cold_email#8",
    find: " I am very flexible and happy to work around your schedule, and I attached my resume for your reference.",
    replace: " A resume is attached.",
    fixes: ["canned-flex", "canned-fyr"], shape: "flex-delete + R2-impersonal",
  },
  {
    file: "email-examples-v4.json", key: "cold_email#8",
    find: "Thank you so much for your time!",
    replace: "Thank you for reading this.",
    fixes: ["closing", "repeat"], shape: "C2-short-thanks",
  },

  {
    file: "email-examples-v4.json", key: "cold_email#9",
    find: "I hope this email finds you well! My name is Dani",
    replace: "My name is Dani",
    fixes: ["pleasantry", "repeat"], shape: "delete-pleasantry",
  },
  {
    file: "email-examples-v4.json", key: "cold_email#9",
    find: "I know that is not the same as two years of clubs.",
    replace: "I know that’s not the same as two years of clubs.",
    fixes: ["contraction"], shape: "contraction-swap",
  },
  {
    file: "email-examples-v4.json", key: "cold_email#9",
    find: " I am very flexible and happy to work around your schedule, and I attached my resume.",
    replace: " I’ll take whatever slot is easiest to give, and I attached my resume.",
    fixes: ["canned-flex", "contraction"], shape: "F-e-whatever-slot",
  },

  // =====================================================================
  // TIER 1d - cold_not_alum (8 bodies). 8 of 8 open on a pleasantry even
  // though the type's whole premise is that the student has a specific
  // hook (a deal, a podcast, an article, a hometown). Every pleasantry
  // here sits in front of the hook, so all 8 delete.
  // =====================================================================
  {
    file: "email-examples.ts", key: "cold_not_alum#1",
    find: "I hope this email finds you well! My name is Kai",
    replace: "My name is Kai",
    fixes: ["pleasantry", "repeat"], shape: "delete-pleasantry",
  },
  {
    file: "email-examples.ts", key: "cold_not_alum#1",
    find: " I am more than happy to work around your schedule, and I attached a copy of my resume for your reference.",
    replace: " I attached a copy of my resume.",
    fixes: ["canned-flex", "canned-fyr"], shape: "flex-delete + R6-drop-fyr-only",
  },
  {
    file: "email-examples.ts", key: "cold_not_alum#1",
    find: "Thank you so much for your time!",
    replace: "Thank you for reading an email from a stranger!",
    fixes: ["closing", "repeat"], shape: "C1-thanks-for-the-specific-thing",
  },

  {
    file: "email-examples.ts", key: "cold_not_alum#2",
    find: "I hope you are doing well! My name is Kai",
    replace: "My name is Kai",
    fixes: ["pleasantry", "repeat"], shape: "delete-pleasantry",
  },
  {
    file: "email-examples.ts", key: "cold_not_alum#2",
    find: "I do not think I have ever met another person from home working in this industry.",
    replace: "I don’t think I’ve ever met another person from home working in this industry.",
    fixes: ["contraction"], shape: "contraction-swap",
  },
  {
    file: "email-examples.ts", key: "cold_not_alum#2",
    find: " I am very flexible and more than happy to work around your schedule, and I attached my resume for your reference.",
    replace: " You pick the time and I’ll make it work. I attached my resume.",
    fixes: ["canned-flex", "canned-fyr", "contraction"], shape: "F-b-you-pick + R4-plain",
  },

  {
    file: "email-examples.ts", key: "cold_not_alum#3",
    find: "I hope this email finds you well! My name is Kai",
    replace: "My name is Kai",
    fixes: ["pleasantry", "repeat"], shape: "delete-pleasantry",
  },
  {
    file: "email-examples.ts", key: "cold_not_alum#3",
    find: " I am happy to work entirely around your schedule, and I attached a copy of my resume for your reference.",
    replace: " I included a copy of my resume.",
    fixes: ["canned-flex", "canned-fyr"], shape: "flex-delete + R3-included",
  },
  {
    file: "email-examples.ts", key: "cold_not_alum#3",
    find: "Thank you very much for your time!",
    replace: "Thank you for whatever you can say about that deal!",
    fixes: ["closing", "repeat"], shape: "C1-thanks-for-the-specific-thing",
  },

  {
    file: "email-examples.ts", key: "cold_not_alum#4",
    find: "I hope all is well with you! My name is Kai",
    replace: "My name is Kai",
    fixes: ["pleasantry", "repeat"], shape: "delete-pleasantry",
  },
  {
    file: "email-examples.ts", key: "cold_not_alum#4",
    find: " I am very flexible and more than happy to work around your schedule.\n\nI attached a copy of my resume for your reference.",
    replace: "\n\nI attached a copy of my resume.",
    fixes: ["canned-flex", "canned-fyr"], shape: "flex-delete + R6-drop-fyr-only",
  },
  {
    file: "email-examples.ts", key: "cold_not_alum#4",
    find: "Thank you so much for your time!",
    replace: "Thank you for the episode, and for whatever time you can spare!",
    fixes: ["closing", "repeat"], shape: "C1-thanks-for-the-specific-thing",
  },

  {
    file: "email-examples-v3.json", key: "cold_not_alum#5",
    find: "I hope this email finds you well! My name is Owen",
    replace: "My name is Owen",
    fixes: ["pleasantry", "repeat"], shape: "delete-pleasantry",
  },
  {
    file: "email-examples-v3.json", key: "cold_not_alum#5",
    find: "and I have not been able to stop thinking about it",
    replace: "and I haven’t been able to stop thinking about it",
    fixes: ["contraction"], shape: "contraction-swap",
  },
  {
    file: "email-examples-v3.json", key: "cold_not_alum#5",
    find: " I am very flexible and happy to work around your schedule, and I attached my resume for your reference.",
    replace: " I attached my resume.",
    fixes: ["canned-flex", "canned-fyr"], shape: "flex-delete + R4-plain",
  },
  {
    file: "email-examples-v3.json", key: "cold_not_alum#5",
    find: "Thank you so much for your time!",
    replace: "Thank you for writing the piece, and for reading this!",
    fixes: ["closing", "repeat"], shape: "C1-thanks-for-the-specific-thing",
  },

  {
    file: "email-examples-v3.json", key: "cold_not_alum#6",
    find: "I hope you are doing well! My name is Priya",
    replace: "My name is Priya",
    fixes: ["pleasantry", "repeat"], shape: "delete-pleasantry",
  },
  {
    file: "email-examples-v3.json", key: "cold_not_alum#6",
    find: "My interest in this area is not abstract.",
    replace: "My interest in this area isn’t abstract.",
    fixes: ["contraction"], shape: "contraction-swap",
  },
  {
    file: "email-examples-v3.json", key: "cold_not_alum#6",
    find: " I am happy to work entirely around your schedule, and I attached my resume for your reference.",
    replace: " Pick whatever is least inconvenient and I’ll be there. A resume is attached.",
    fixes: ["canned-flex", "canned-fyr", "contraction"], shape: "F-f-least-inconvenient + R2-impersonal",
  },
  {
    file: "email-examples-v3.json", key: "cold_not_alum#6",
    find: "Thank you very much for your time!",
    replace: "Thank you for reading it either way.",
    fixes: ["closing", "repeat"], shape: "C2-short-thanks",
  },

  {
    file: "email-examples-v4.json", key: "cold_not_alum#7",
    find: "I hope this email finds you well! My name is Kofi",
    replace: "My name is Kofi",
    fixes: ["pleasantry", "repeat"], shape: "delete-pleasantry",
  },
  {
    file: "email-examples-v4.json", key: "cold_not_alum#7",
    find: "That is the exact sequence I have been trying to understand, and nobody I have spoken with has done both.",
    replace: "That’s the exact sequence I’ve been trying to understand, and nobody I’ve spoken with has done both.",
    fixes: ["contraction"], shape: "contraction-swap",
  },
  {
    file: "email-examples-v4.json", key: "cold_not_alum#7",
    find: " I am glad to work entirely around your schedule, and I attached my resume for your reference. Thank you very much for your time!",
    replace: " I attached my resume. Thank you for being the first person I have found who has done both!",
    fixes: ["canned-flex", "canned-fyr", "closing"], shape: "R4-plain + C1-thanks-for-the-specific-thing",
  },

  {
    file: "email-examples-v4.json", key: "cold_not_alum#8",
    find: "I hope you are doing well! My name is Grant",
    replace: "My name is Grant",
    fixes: ["pleasantry", "repeat"], shape: "delete-pleasantry",
  },
  {
    file: "email-examples-v4.json", key: "cold_not_alum#8",
    find: "My name is Grant Feldstrom, and I am a sophomore at Halverson",
    replace: "My name is Grant Feldstrom, and I’m a sophomore at Halverson",
    fixes: ["contraction"], shape: "contraction-swap",
  },
  {
    file: "email-examples-v4.json", key: "cold_not_alum#8",
    find: " I am very flexible and happy to work around your schedule, and I attached my resume. Thank you so much for your time!",
    replace: " I attached my resume. Thank you for whatever you can tell me about the move!",
    fixes: ["canned-flex", "closing"], shape: "R4-plain + C1-thanks-for-the-specific-thing",
  },

  // =====================================================================
  // TIER 2 - recruiting_inbox (9 bodies). A DIFFERENT defect: 0
  // pleasantries, 0 flexibility lines, but 8 of 9 use "I wanted to ..."
  // throat-clearing and 6 of 9 close on a thanks-for-your-time formula.
  // Contractions are deliberately NOT added: VOICE_RULES says to keep full
  // forms in emails to a recruiting team or inbox, and this type is the
  // reason that clause exists.
  // =====================================================================
  {
    file: "email-examples.ts", key: "recruiting_inbox#1",
    find: "I wanted to confirm that my application was received in full, as I did not receive a confirmation email after submitting.",
    replace: "Could you confirm that my application was received in full? No confirmation email arrived after I submitted.",
    fixes: ["throat"], shape: "throat-to-direct-question",
  },

  {
    file: "email-examples.ts", key: "recruiting_inbox#2",
    find: "and I wanted to confirm whether students graduating in 2029 are eligible this cycle",
    replace: "and please confirm whether students graduating in 2029 are eligible this cycle",
    fixes: ["throat"], shape: "throat-to-please-confirm",  // keeps draft-lint ASK
  },
  {
    file: "email-examples.ts", key: "recruiting_inbox#2",
    find: " I attached my resume for your reference.",
    replace: " My resume is attached.",
    fixes: ["canned-fyr"], shape: "R1-bare",
  },
  {
    file: "email-examples.ts", key: "recruiting_inbox#2",
    find: "Thank you for your time, and I look forward to hearing back.",
    replace: "Thank you for clarifying either way.",
    fixes: ["closing"], shape: "C3-close-on-the-ask",
  },

  {
    file: "email-examples.ts", key: "recruiting_inbox#3",
    find: "Please let me know if there is anything else the team needs from me, or any other step I should take in the process.",
    replace: "If there is another step I should take in the process, I would be glad to know it.",
    fixes: ["canned-anyelse"], shape: "anything-else-to-one-real-question",
  },

  {
    file: "email-examples.ts", key: "recruiting_inbox#4",
    find: "I wanted to ask when candidates can expect to hear about first-round interviews, so that I can plan around my exam schedule if needed.",
    replace: "Could you tell me when candidates can expect to hear about first-round interviews? I ask so that I can plan around my exam schedule.",
    fixes: ["throat"], shape: "throat-to-could-you-tell-me",
  },

  {
    file: "email-examples-v4.json", key: "recruiting_inbox#5",
    find: "I wanted to ask whether eligibility for the Sophomore Insight Program is based on class year, on years completed at the current institution, or on expected graduation date.",
    replace: "Would you mind confirming whether eligibility for the Sophomore Insight Program is based on class year, on years completed at the current institution, or on expected graduation date?",
    fixes: ["throat"], shape: "throat-to-would-you-mind",
  },
  {
    file: "email-examples-v4.json", key: "recruiting_inbox#5",
    find: "Thank you very much for your time and consideration.",
    replace: "Thank you for sorting out which of those it is.",
    fixes: ["closing", "repeat"], shape: "C3-close-on-the-ask",
  },

  {
    file: "email-examples-v4.json", key: "recruiting_inbox#6",
    find: "Before I apply, I wanted to ask whether the 2027 Summer Analyst Program in the markets division considers candidates who will need sponsorship for the subsequent full-time role.",
    replace: "Before I apply, please confirm whether the 2027 Summer Analyst Program in the markets division considers candidates who will need sponsorship for the subsequent full-time role.",
    fixes: ["throat"], shape: "throat-to-please-confirm",
  },

  {
    file: "email-examples-v4.json", key: "recruiting_inbox#7",
    find: "I wanted to ask whether the firm considers candidates for off-cycle analyst positions, January start dates, or full-time roles that open outside the campus cycle, and if so, how those postings are advertised.",
    replace: "Would you be willing to say whether the firm considers candidates for off-cycle analyst positions, January start dates, or full-time roles that open outside the campus cycle, and if so, how those postings are advertised?",
    fixes: ["throat"], shape: "throat-to-would-you-be-willing",
  },

  {
    file: "email-examples-v4.json", key: "recruiting_inbox#8",
    find: "I wanted to confirm that my application was received in full, as I did not receive a confirmation from the portal.",
    replace: "Could you check that the application was received in full? The portal sent no confirmation.",
    fixes: ["throat"], shape: "throat-to-could-you-check",
  },

  {
    file: "email-examples-v4.json", key: "recruiting_inbox#9",
    find: "I wanted to ask whether one would be read, so that I can submit it if it is useful.",
    replace: "Let me know whether a cover letter would be read and I will include one if it is useful.",
    fixes: ["throat"], shape: "throat-to-let-me-know",
  },

  // =====================================================================
  // TIER 3a - the 4 "for your reference" outside the five priority types.
  // =====================================================================
  {
    file: "email-examples-v4.json", key: "conference_follow_up#1",
    find: " I am very flexible and happy to work around your schedule, and I attached my resume for your reference.",
    replace: " I attached my resume.",
    fixes: ["canned-flex", "canned-fyr"], shape: "flex-delete + R4-plain",
  },
  {
    file: "email-examples-v4.json", key: "conference_follow_up#2",
    find: " I am glad to work entirely around your schedule, and I attached my resume for your reference.",
    replace: " A resume is attached.",
    fixes: ["canned-flex", "canned-fyr"], shape: "flex-delete + R2-impersonal",
  },
  {
    file: "email-examples-v4.json", key: "conference_follow_up#3",
    find: "I attached a copy of my resume for your reference.",
    replace: "I included a copy of my resume.",
    fixes: ["canned-fyr"], shape: "R3-included",
  },
  {
    file: "email-examples-v4.json", key: "redirect_sequence#2",
    find: " I am very flexible and happy to work around your schedule, and I attached my resume for your reference.",
    replace: " I attached my resume.",
    fixes: ["canned-flex", "canned-fyr"], shape: "flex-delete + R4-plain",
  },

  // =====================================================================
  // TIER 3b - the repeated pleasantry openers. These 16 bodies are NOT in
  // the four cold types: they are follow-ups, check-ins, keep-in-touch and
  // referral asks, where VOICE_RULES positively permits a pleasantry
  // because there is often nothing more specific than "it has been three
  // months". The defect is that 16 of them are the SAME STRING. Six delete
  // (the next sentence is a real hook); ten vary, every one differently,
  // using only a season, a stretch of time, or a fact already in the body.
  // =====================================================================
  { file: "email-examples-v3.json", key: "follow_up_1#2",
    find: "I hope you are doing well! I reached out", replace: "I reached out",
    fixes: ["pleasantry", "repeat"], shape: "delete-pleasantry" },
  { file: "email-examples-v3.json", key: "follow_up_1#5",
    find: "I hope you are doing well! I emailed", replace: "I emailed",
    fixes: ["pleasantry", "repeat"], shape: "delete-pleasantry" },
  { file: "email-examples.ts", key: "interview_check_in#1",
    find: "I hope you are doing well! I interviewed", replace: "I interviewed",
    fixes: ["pleasantry", "repeat"], shape: "delete-pleasantry" },
  { file: "email-examples-v4.json", key: "interview_check_in#6",
    find: "I hope you are doing well! I interviewed", replace: "I interviewed",
    fixes: ["pleasantry", "repeat"], shape: "delete-pleasantry" },
  { file: "email-examples-v4.json", key: "second_conversation#1",
    find: "I hope you are doing well! We spoke", replace: "We spoke",
    fixes: ["pleasantry", "repeat"], shape: "delete-pleasantry" },
  { file: "email-examples-v4.json", key: "second_conversation#3",
    find: "I hope you are doing well! Since our call", replace: "Since our call",
    fixes: ["pleasantry", "repeat"], shape: "delete-pleasantry" },

  { file: "email-examples.ts", key: "keep_in_touch#1",
    find: "I hope you are doing well!", replace: "I hope the semester has been a good one!",
    fixes: ["repeat"], shape: "vary-pleasantry-season" },
  { file: "email-examples.ts", key: "keep_in_touch#4",
    find: "I hope you are doing well!", replace: "I hope the year has been kind to you!",
    fixes: ["repeat"], shape: "vary-pleasantry-stretch-of-time" },
  { file: "email-examples-v4.json", key: "keep_in_touch#5",
    find: "I hope you are doing well!", replace: "I hope things have been steady on your end!",
    fixes: ["repeat"], shape: "vary-pleasantry-neutral" },
  { file: "email-examples-v3.json", key: "referral_ask#1",
    find: "I hope you are doing well!", replace: "I hope the fall has been good to you!",
    fixes: ["repeat"], shape: "vary-pleasantry-season" },
  { file: "email-examples-v3.json", key: "referral_ask#2",
    find: "I hope you are doing well!", replace: "I hope the months since September have gone well!",
    fixes: ["repeat"], shape: "vary-pleasantry-grounded-in-the-body" },
  { file: "email-examples-v4.json", key: "referral_ask#4",
    find: "I hope you are doing well!", replace: "I hope the week has been a reasonable one!",
    fixes: ["repeat"], shape: "vary-pleasantry-neutral" },
  { file: "email-examples-v3.json", key: "referral_ask#5",
    find: "I hope you are doing well!", replace: "I hope you are keeping well!",
    fixes: ["repeat"], shape: "vary-pleasantry-short" },
  { file: "email-examples-v3.json", key: "follow_up_2#2",
    find: "I hope you are doing well! I just wanted to reach out one last time about setting up a call.",
    replace: "I am writing one last time about setting up a call.",
    fixes: ["pleasantry", "repeat", "throat"], shape: "delete-pleasantry + cut-throat-clearing" },
  { file: "email-examples.ts", key: "interview_check_in#3",
    find: "I hope you are doing well! I wanted to follow up on my interview",
    replace: "Following up on my interview",
    fixes: ["pleasantry", "repeat", "throat"], shape: "delete-pleasantry + cut-throat-clearing" },
  { file: "email-examples-v4.json", key: "interview_check_in#4",
    find: "I hope this email finds you well! I wanted to reach out one final time regarding",
    replace: "I am writing one final time about",
    fixes: ["pleasantry", "repeat", "throat"], shape: "delete-pleasantry + cut-throat-clearing" },

  // =====================================================================
  // TIER 3c - "please do not hesitate to", 8 bodies, banned by name in
  // VOICE_RULES. Each replacement is built from what that email is
  // actually offering, so no two read alike.
  // =====================================================================
  { file: "email-examples.ts", key: "interview_check_in#1",
    find: "If there is any additional information you need from me, please do not hesitate to reach out.",
    replace: "If anything else would help, I can send it over.",
    fixes: ["canned-hesitate"], shape: "offer-in-this-email's-words" },
  { file: "email-examples.ts", key: "call_scheduling#2",
    find: "If anything comes up between now and then, please do not hesitate to move it, as I am very flexible.",
    replace: "If anything comes up between now and then, move it and I will adjust.",
    fixes: ["canned-hesitate", "canned-flex"], shape: "offer-as-an-imperative" },
  { file: "email-examples-v4.json", key: "call_scheduling#6",
    find: "If anything comes up between now and then, please do not hesitate to move it.",
    replace: "If the time stops working, I can take a different one.",
    fixes: ["canned-hesitate"], shape: "offer-stated-as-a-fact" },
  { file: "email-examples-v3.json", key: "referral_ask#1",
    find: "I know that a referral carries your name with it, so please do not hesitate to say no.",
    replace: "A referral carries your name with it, so no is a complete answer.",
    fixes: ["canned-hesitate"], shape: "easy-out-rewritten" },
  { file: "email-examples-v3.json", key: "thank_you_interview#1",
    find: "If there is any additional information that you need from me, please do not hesitate to reach out.",
    replace: "Whatever else the team needs, I can get it over quickly.",
    fixes: ["canned-hesitate"], shape: "offer-fronted" },
  { file: "email-examples-v3.json", key: "thank_you_interview#2",
    find: "If so, please do not hesitate to reach out.",
    replace: "If so, I will send it the same day.",
    fixes: ["canned-hesitate"], shape: "offer-with-a-commitment" },
  { file: "email-examples-v3.json", key: "thank_you_interview#4",
    find: "If you need any additional information from me, please do not hesitate to ask.",
    replace: "If you need anything further from me, just ask.",
    fixes: ["canned-hesitate"], shape: "offer-shortened" },
  { file: "email-examples-v3.json", key: "thank_you_superday#1",
    find: "If there is any additional information you need from me, please do not hesitate to reach out, and I look forward to hearing about the next steps!",
    replace: "If anything further is needed from me, I can send it along. I would be glad to hear what the next step is.",
    fixes: ["canned-hesitate", "canned-lfth"], shape: "offer-split-from-the-ask" },

  // =====================================================================
  // TIER 3d - the last 2 "I look forward to hearing from you".
  // =====================================================================
  { file: "email-examples-v3.json", key: "follow_up_1#4",
    find: "Thank you so much for your time, and I look forward to hearing from you!",
    replace: "Thank you so much, and I will leave it here either way!",
    fixes: ["canned-lfth", "closing"], shape: "C3-close-on-the-ask" },
  { file: "email-examples-v3.json", key: "follow_up_2#1",
    find: "Thank you, and I look forward to hearing from you!",
    replace: "Thank you either way!",
    fixes: ["canned-lfth", "closing"], shape: "C2-short-thanks" },
];
