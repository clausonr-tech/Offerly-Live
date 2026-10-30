import Link from "next/link";
import { format } from "date-fns";
import { desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { contacts, directoryPeople, emailDrafts } from "@/db/schema";
import { getCurrentUser } from "@/lib/current-user";
import { getThankYouPrompts } from "@/lib/thank-you-db";
import { computeRelevanceScore } from "@/lib/relevance";
import { normalizeFirmName } from "@/lib/network-coverage";
import { getDiscoveryMatchesForCurrentUser } from "@/lib/discovery-matches";
import { CATEGORY_LABELS } from "@/lib/firm-metadata";
import type { RecipientOption } from "../../drafts/RecipientPicker";
import { findStudentResume } from "@/lib/resume-file";
import GenerateForm from "../../drafts/GenerateForm";
import { draftStreamingEnabled } from "../../drafts/draft-request";

// Drafting an email is two model calls in a row (draft, then review), which can
// run past a serverless function's default time limit. Server actions run under
// the limit of the page that calls them. 120 seconds fits Vercel Pro; the draft
// pipeline skips the review once drafting alone passes 80 (lib/generate-draft).
export const maxDuration = 120;

/**
 * Email drafts: the form that writes the next email, under Outreach in the
 * rail. It used to be one of two tabs on /outreach; the hub there now says
 * who to write to, and forwards the old `/outreach?contact=` links here.
 */
export default async function EmailDraftsPage({
  searchParams,
}: {
  /** `?contact=<id>` opens the form already addressed to that person - the
   *  Networking table links here from a contact's email address. */
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const wanted = typeof params.contact === "string" ? params.contact : undefined;
  // `?occasion=follow_up&box=follow.first` - how a follow-up prompt opens the
  // form with "Follow up" chosen and the right rung ticked. Checked against
  // the real list in GenerateForm, so an unknown value just leaves it blank.
  const occasion = typeof params.occasion === "string" ? params.occasion : undefined;
  const box = typeof params.box === "string" ? params.box : undefined;
  // `?thank=<key>` - a thank-you prompt for someone who is not a saved contact.
  // Only the prompt's key travels in the link; who it was is looked up here,
  // from the prompt the student actually owes, so no name or address is ever
  // in a URL and a made-up key fills in nothing.
  const thankKey = typeof params.thank === "string" ? params.thank : undefined;
  const user = await getCurrentUser();
  const userId = user.id;
  const db = await getDb();

  // The resume and the Discovery matches join this batch rather than trailing
  // it. Neither reads anything the other two return, and as separate awaits
  // they were two more sequential network waits on a page that already had one.
  const [drafts, contactRows, resume, matches, thankPrompt] = await Promise.all([
    db.query.emailDrafts.findMany({
      where: eq(emailDrafts.userId, userId),
      orderBy: [desc(emailDrafts.createdAt)],
      with: { contact: { columns: { name: true } } },
    }),
    db.query.contacts.findMany({
      where: eq(contacts.userId, userId),
      columns: {
        id: true,
        name: true,
        email: true,
        firm: true,
        school: true,
        background: true,
        notes: true,
        linkedinUrl: true,
        // Set only on a contact contact sourcing found - "found on Offerly".
        enrichedAt: true,
      },
    }),
    findStudentResume(userId),
    // Only the people the student was matched with, at the firms they were
    // matched with - the same tree Discovery shows, so the two never disagree.
    getDiscoveryMatchesForCurrentUser(),
    thankKey
      ? getThankYouPrompts(userId).then((owed) => owed.find((t) => t.key === thankKey) ?? null)
      : Promise.resolve(null),
  ]);
  // Who that thank-you is to, when they are not a saved contact.
  const thankOutside =
    thankPrompt && !thankPrompt.next.contactId
      ? { name: thankPrompt.next.name, email: thankPrompt.next.email, firm: thankPrompt.next.firm }
      : undefined;

  // The latest cold email and follow-up #1 drafted to each person. Drafts come
  // newest first, so the first one seen per contact is the latest. A follow-up
  // to one of these is built from it rather than asking the student again.
  const priorCold = new Map<string, { subject: string; draftedOn: string }>();
  const priorFollowUp1 = new Map<string, string>();
  for (const d of drafts) {
    if (!d.contactId) continue;
    if (d.kind === "cold_outreach" && !priorCold.has(d.contactId)) {
      priorCold.set(d.contactId, { subject: d.subject, draftedOn: format(d.createdAt, "MMM d") });
    }
    if (d.templateId === "follow_up_1" && !priorFollowUp1.has(d.contactId)) {
      priorFollowUp1.set(d.contactId, format(d.createdAt, "MMM d"));
    }
  }

  // Firms with nobody matched at them are left out: there is no one to write to.
  const matchedPeople = matches.groups.flatMap((g) => g.contacts);

  const ownById = new Map(contactRows.map((c) => [c.id, c]));
  const ownByEmail = new Map(
    contactRows.filter((c) => c.email).map((c) => [c.email!.trim().toLowerCase(), c]),
  );
  const directoryIds = matchedPeople
    .filter((p) => p.key.startsWith("directory-"))
    .map((p) => p.key.slice("directory-".length));
  const directoryById = new Map(
    (directoryIds.length
      ? await db.query.directoryPeople.findMany({
          where: inArray(directoryPeople.id, directoryIds),
          columns: { id: true, school: true, jobHistory: true },
        })
      : []
    ).map((d) => [d.id, d]),
  );

  const recipients: RecipientOption[] = [];
  for (const group of matches.groups) {
    const firmDivisions = group.firm.categories.map((c) => CATEGORY_LABELS[c] ?? c);
    const seen = new Set<string>();
    for (const person of group.contacts) {
      // A directory person the student already saved as a contact is that
      // contact: one entry, and it carries their drafts for follow-ups.
      const own = person.key.startsWith("contact-")
        ? ownById.get(person.key.slice("contact-".length))
        : person.email
          ? ownByEmail.get(person.email.trim().toLowerCase())
          : undefined;
      const key = own ? `contact-${own.id}` : person.key;
      if (seen.has(key)) continue;
      seen.add(key);

      const listed = own ? undefined : directoryById.get(person.key.slice("directory-".length));
      recipients.push({
        key,
        name: person.name,
        title: person.title,
        firmKey: group.firm.id,
        firmName: group.firm.name,
        firmDivisions,
        linkedinUrl: person.linkedinUrl,
        school: own?.school ?? listed?.school ?? null,
        found: own ? (own.enrichedAt ? "offerly" : "saved") : "directory",
        priorCold: own ? (priorCold.get(own.id) ?? null) : null,
        priorFollowUp1On: own ? (priorFollowUp1.get(own.id) ?? null) : null,
        commonGround: computeRelevanceScore(user, {
          school: own?.school ?? listed?.school ?? null,
          background: own?.background ?? listed?.jobHistory ?? null,
          notes: null,
        }).reasons.join("; "),
      });
    }
  }

  // A contact somebody was sent here to write to, who is not in the match tree.
  //
  // The list above is built from Discovery's matches, so a contact the student
  // added themselves - a CSV import, someone they met, anyone at a firm that is
  // not on their matched list - is not in it. The recipient select then quietly
  // ignored ?contact=, and a student who clicked "Draft to Dana Reed" in the
  // outreach banner landed on an empty form with no idea why. Adding the person
  // they asked for is the honest answer to that link: the picker offers exactly
  // who they came here for.
  if (wanted && !recipients.some((r) => r.key === `contact-${wanted}`)) {
    const own = ownById.get(wanted);
    if (own) {
      const firmName = own.firm?.trim() || "Your contacts";
      recipients.push({
        key: `contact-${own.id}`,
        name: own.name,
        title: null,
        // Normalised, so this person joins their firm's existing group in the
        // company select instead of opening a second one spelled differently.
        firmKey: normalizeFirmName(firmName) || "own-contacts",
        firmName,
        firmDivisions: [],
        linkedinUrl: own.linkedinUrl,
        school: own.school,
        found: own.enrichedAt ? "offerly" : "saved",
        priorCold: priorCold.get(own.id) ?? null,
        priorFollowUp1On: priorFollowUp1.get(own.id) ?? null,
        commonGround: computeRelevanceScore(user, {
          school: own.school,
          background: own.background,
          notes: own.notes,
        }).reasons.join("; "),
      });
    }
  }

  const matchNote = matches.needsProfile
    ? "Pick your sectors on your profile to get matched with firms and people"
    : matches.error
      ? "Matching didn't finish - try Discovery again"
      : null;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-brand-900">Email drafts</h1>
        <p className="mt-1 text-sm text-warmgray-500">
          Generate an AI first draft, then edit and send it yourself.
        </p>
      </div>

      <div className="mb-8">
        <GenerateForm
          // A new link is a new form: its starting person and boxes are read
          // once, so arriving from a second prompt must not keep the first's.
          key={[wanted, occasion, box, thankKey].join("|")}
          recipients={recipients}
          // The picker keys own contacts as "contact-<id>".
          initialRecipientKey={wanted ? `contact-${wanted}` : undefined}
          initialOccasionId={occasion}
          initialBoxId={box}
          initialOutside={thankOutside}
          matchNote={matchNote}
          resumeFilename={resume?.filename ?? null}
          signature={{ schoolEmail: user.schoolEmail, phone: user.phone }}
          studentName={user.name ?? ""}
          studentSchool={user.school ?? null}
          // Read here, on the server, on every request: the form cannot read
          // the environment and the flag has to be able to flip without a
          // rebuild (draftStreamingEnabled). Off, or unset, and the form posts
          // to the server action exactly as it always has.
          streaming={draftStreamingEnabled()}
        />
      </div>

      {/* Past emails live on their own page, with what was entered for each,
          so this page stays about writing the next one. */}
      {drafts.length > 0 && (
        <Link
          href="/drafts"
          className="flex items-center justify-between gap-4 rounded-lg border border-brand-100 bg-white px-4 py-3 hover:border-brand-200 hover:bg-brand-50"
        >
          <span>
            <span className="block text-sm font-medium text-brand-900">Your past emails</span>
            <span className="block text-xs text-warmgray-500">
              See what you entered and each draft as you last left it.
            </span>
          </span>
          <span className="shrink-0 text-sm font-medium text-brand-900">View →</span>
        </Link>
      )}
    </div>
  );
}
