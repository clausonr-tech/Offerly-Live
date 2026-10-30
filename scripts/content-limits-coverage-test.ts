// Every server action a student can type words into checks them for slurs,
// hateful language and profanity (lib/content-limits). This test is how that
// rule holds for actions added later, not just the ones that exist today.
//
//   npx tsx scripts/content-limits-coverage-test.ts
//
// It reads every "use server" file and every API route under src/, and finds
// each exported function that takes input beyond ids (a FormData, text, an
// object). Each must call blockedLanguageError, blockedInForm or
// findBlockedLanguage, or be listed in EXEMPT with the reason it takes no words.
// A new action that does neither fails here: add the check, or add an exemption
// that says why.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const CHECKS = /\b(blockedLanguageError|blockedInForm|findBlockedLanguage)\(/;

// "file#function" -> why it takes no words a person could type.
//
// A reason here is a claim about the code, and this test can only check that
// the action exists - not that its reason is true. Whoever adds one owes the
// next reader a reason that names every input the action takes, including the
// ones that are words and are exempt for some other stated cause (a search
// term nothing stores, a password, a file). The one that was wrong when this
// note was added said "A LinkedIn URL" of a field that stored the raw input,
// newlines and all, and both the test and the reason read as true for as long
// as nobody looked (docs/concepts/audit/FIX-SAFETY.md).
export const EXEMPT: Record<string, string> = {
  "app/(app)/profile/billing/actions.ts#startCheckout":
    "Two fixed choices - a plan id and monthly/yearly - refused unless they parse; nothing typed.",
  "app/api/stripe/webhook/route.ts#POST":
    "Stripe's signed machine payload, rejected unless the signature verifies. No student ever types into it.",
  "app/(app)/discovery/firm/[slug]/generateContactsAction.ts#generateContactsAction":
    "A firm id. The student types nothing - the query is built server-side from their stored profile.",
  "app/(app)/profile/actions.ts#updateLinkedin":
    "A linkedin.com URL - refused if it carries whitespace and stored as url.href, never as typed (lib/validation linkedinLink), so what reaches the database and the email signature really is only a URL.",
  "app/(app)/news/actions.ts#reportNewsStory": "A story id and one of four fixed report reasons; nothing typed.",
  "app/(app)/news/actions.ts#saveNewsAccess": "Checkboxes: paid publisher ids from a fixed list; anything else is ignored.",
  "app/(app)/profile/actions.ts#uploadResume": "An uploaded file, not typed text.",
  "app/(app)/profile/actions.ts#uploadAvatar": "An uploaded JPEG, checked by magic bytes; the filename is discarded for a random key.",
  "app/(app)/profile/actions.ts#updatePhone": "A phone number.",
  "app/(app)/profile/actions.ts#updateTimeZone": "A fixed choice: a time zone name the runtime recognises, or \"auto\".",
  "app/(app)/profile/actions.ts#changePassword": "Passwords, which are hashed and never shown.",
  "app/(app)/profile/actions.ts#deleteAccount": "A password and the word DELETE.",
  "app/(app)/profile/school-verification-actions.ts#requestSchoolVerification": "A school email address.",
  "app/(app)/profile/school-verification-actions.ts#confirmSchoolVerification": "A numeric verification code.",
  "app/login/actions.ts#logIn": "An email address and a password.",
  "app/onboarding/links/actions.ts#saveProfileLinks":
    "A linkedin.com URL stored as url.href (lib/validation linkedinLink refuses one carrying whitespace), a phone number matched against phone characters only, a school id checked against the schools table, and a resume file.",
  "app/(app)/dashboard/actions.ts#addTopFirm": "A firm id.",
  "app/(app)/dashboard/actions.ts#searchFirmsForPicker": "A search term typed into the firm picker. Trimmed and capped, used only to filter public firm names for the person typing - never stored, never shown to anyone else.",
  "app/(app)/networking/clubs/actions.ts#leaveClubAction": "A club id, checked as a UUID, and the club's slug, used only to refresh its page.",
  "app/(app)/networking/clubs/actions.ts#searchStudentsAction": "A club id and a name search typed by the club president, matched against student names for the person typing - never stored, never shown to anyone else.",
  "app/(app)/networking/clubs/actions.ts#addMemberAction": "A club id and a student id, both checked as UUIDs, and the club's slug, used only to refresh its page.",
  "app/(app)/networking/clubs/actions.ts#removeMemberAction": "A club id and a member id, both checked as UUIDs, and the club's slug, used only to refresh its page.",
  "app/(app)/networking/actions.ts#toggleFollow": "An id and a follow flag.",
  "app/(app)/networking/feed-actions.ts#loadFeedPage": "A paging cursor and the timestamp the feed was opened at.",
  "app/(app)/networking/feed-actions.ts#listComments":
    "A row id, a paging cursor (a timestamp and a uuid, both pattern-checked) and a page size. It reads comments; it writes nothing and takes no words.",
  "app/api/feed/seen/route.ts#POST": "Feed row ids that have been on screen.",
  "app/(app)/learn/video/actions.ts#startVideoInterview":
    "Fixed choices only - mode, think and answer times, difficulty, yes/no training - plus a random start token; parseStartInput rejects anything else.",
  "app/(app)/learn/video/actions.ts#submitVideoAnswer":
    "A question id, a duration and an audio file. The only words are the speech-to-text transcript of the student's own answer, shown back only to that student and graded; nothing is published.",
  "app/(app)/learn/video/actions.ts#setVideoTrainingChoice": "A fixed choice, \"yes\" or \"no\", refused if it is anything else.",
  "app/(app)/learn/video/actions.ts#requestTrainingUpload": "A question id, a video MIME type, a byte size and a duration - all validated server-side.",
  "app/(app)/networking/feed-actions.ts#toggleReaction": "A row id and an emoji from the fixed REACTION_EMOJIS set; anything else is rejected.",
  "app/(app)/nudge-actions.ts#markPromptFlashSeen":
    "The key of a prompt bubble, and only the one the server is already showing this student - everything filed is re-derived from their own prompts, and anything else is ignored. Nothing typed reaches the database.",
  "app/(app)/drafts/quick-draft-actions.ts#draftEmailForContact":
    "A recipient key and a yes/no. The student types nothing; the email is written through generateDraft, which checks every field before the model and the model's output after.",
  "app/(app)/drafts/suggestion-actions.ts#suggestDraftFields":
    "Takes a recipient key (contact-<id> / directory-<id>) and a flag; nothing typed. The model's suggestions it returns go through findBlockedLanguage in parseSuggestions before anyone sees them.",
  "app/(app)/nudge-actions.ts#markAppliedFromReminder":
    "The key of a deadline reminder, acted on only if it is one this student has right now; what it writes (the tracker entry) is copied from the posting, not typed.",
  "app/(app)/nudge-actions.ts#completeThankYouPrompt":
    "The key of a thank-you prompt, acted on only if it is one this student owes right now. Nothing typed reaches the database.",
  "app/(app)/contacts/contact-actions.ts#setContactRepliedAction": "A contact id and a replied/not-replied flag; nothing typed.",
  "app/(app)/networking/peer-actions.ts#togglePeer": "A user id and an add/remove flag. No words - the relationship carries no message.",
  "app/(app)/learn/practice-actions.ts#getPracticeQuestion":
    "Round settings picked from fixed options, plus the prompts already served this round - compared as a Set against the question bank's own prompts so a round does not repeat itself (lib/practice-session), never stored, never shown to anyone and never sent to a model.",
  "app/(app)/learn/practice-actions.ts#completePracticeRound": "Round settings and scores, with no typed words.",
  "app/(app)/applications/actions.ts#untrackApplication": "Matches an existing application to remove it; nothing typed is stored.",
  "app/(app)/applications/untrack-actions.ts#untrackFirm": "Matches an existing firm to remove it; nothing typed is stored.",
  "app/api/reminders/send/route.ts#POST": "A scheduled job authenticated by a secret; no one types into it.",
  "app/firms/auth-actions.ts#firmLogin": "A work email address and a password.",
  "app/firms/auth-actions.ts#firmDemoLogin": "The demo account's email address and password.",
  "app/firms/auth-actions.ts#firmResetStep": "A work email address, a numeric reset code and a new password.",
  "app/firms/(portal)/internships/actions.ts#setPostingOpenAction": "A posting id and an open/closed flag.",
  "app/firms/(portal)/events/actions.ts#setEventOpenAction": "An event id and an open/closed flag.",
  "app/firms/(portal)/team/actions.ts#approveTeammateAction": "A teammate's user id.",
  "app/firms/(portal)/team/actions.ts#removeTeammateAction": "A teammate's user id.",
  "app/(app)/admin/firms/actions.ts#approveFirmAccountAction": "A user id and a firm slug from the directory; admin-only.",
  "app/(app)/admin/firms/actions.ts#setFirmOwnerAction": "A firm id and a user id; admin-only.",
  "app/(app)/admin/firms/actions.ts#restorePostAction": "A post kind from a fixed choice and a post id; admin-only.",
  "app/firms/(portal)/team/actions.ts#transferOwnershipAction": "A teammate's user id.",
  "app/(app)/profile/connections/email-actions.ts#setFirmPostEmailsAction": "An on/off flag.",
  "app/(app)/profile/connections/sharing-actions.ts#setFirmSharingAction": "An on/off flag: share my profile with firms.",
  "app/(app)/profile/connections/sharing-actions.ts#setTrainingChoiceAction": "An on/off flag: let Offerly train its writing tools on my writing.",
  "app/consent/actions.ts#acceptCurrentPolicy": "Three checkboxes: the terms (required), sharing with firms and Training Use (both optional).",
  "app/firms/(portal)/settings/actions.ts#changePasswordAction": "Passwords, which are hashed and never shown.",
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "node_modules" ? [] : files(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

type Found = { key: string; params: string; checked: boolean };

/** Exported functions with their parameter lists and bodies, split at each top-level export. */
function exportedFunctions(source: string): { name: string; params: string; body: string }[] {
  const starts = [...source.matchAll(/^export (?:async )?function (\w+)\s*\(/gm)];
  return starts.map((m, i) => {
    const from = m.index! + m[0].length;
    let depth = 1;
    let j = from;
    for (; j < source.length && depth > 0; j++) {
      if (source[j] === "(") depth++;
      else if (source[j] === ")") depth--;
    }
    const end = i + 1 < starts.length ? starts[i + 1].index! : source.length;
    return { name: m[1], params: source.slice(from, j - 1), body: source.slice(j, end) };
  });
}

/** Whether a parameter list takes anything besides ids and the useActionState previous-state slot. */
function takesInput(params: string): boolean {
  const names = params
    .split(/,(?![^{}<>]*[}>])/)
    .map((p) => p.trim().replace(/^(\w+)\??\s*:[\s\S]*$/, "$1"))
    .filter(Boolean);
  return names.some((n) => !/^_/.test(n) && !/(Id|ID|Ids|id)$/.test(n) && n !== "completed");
}

const found: Found[] = [];
for (const file of files("src")) {
  const source = readFileSync(file, "utf8");
  const isAction = /^\s*["']use server["']/.test(source);
  const isRoute = /\/api\/.*\/route\.ts$/.test(file);
  if (!isAction && !isRoute) continue;
  for (const fn of exportedFunctions(source)) {
    if (isRoute && !/^(POST|PUT|PATCH)$/.test(fn.name)) continue;
    if (!isRoute && !takesInput(fn.params)) continue;
    found.push({ key: `${path.relative("src", file)}#${fn.name}`, params: fn.params.replace(/\s+/g, " ").trim(), checked: CHECKS.test(fn.body) });
  }
}

const missing = found.filter((f) => !f.checked && !EXEMPT[f.key]);
const staleExemptions = Object.keys(EXEMPT).filter((k) => !found.some((f) => f.key === k));
const dry = process.argv.includes("--list");
if (dry) for (const f of found) console.log(`${f.checked ? "checked " : EXEMPT[f.key] ? "exempt  " : "MISSING "} ${f.key}  (${f.params.slice(0, 70)})`);
console.log(`${found.length} actions take input: ${found.filter((f) => f.checked).length} checked, ${found.filter((f) => !f.checked && EXEMPT[f.key]).length} exempt, ${missing.length} missing`);
for (const f of missing) console.log(`  MISSING ${f.key}: call blockedLanguageError/blockedInForm on the words it takes, or add it to EXEMPT with a reason`);
for (const k of staleExemptions) console.log(`  STALE exemption ${k}: that action no longer exists`);
if (missing.length || staleExemptions.length) process.exitCode = 1;
