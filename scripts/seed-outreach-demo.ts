// Demo data for looking at the outreach prompts locally.
//
//   npx tsx --conditions=react-server scripts/seed-outreach-demo.ts
//
// The prompts only speak when four things line up: a firm on the student's own
// list, a posting at that firm with a PUBLISHED opening date inside the next
// month, contacts at that firm, and none of those contacts written to yet.
// Getting all four by hand takes a while, so this writes them:
//
//   - Goldman Sachs, opening in 27 days  -> the flash (a month out, once)
//   - Evercore, opening in 13 days       -> the Opportunities to-do row
//
// It also writes one calendar entry - "Evercore | Superday", three days out -
// so the interview-prep prompt has something to detect. Nothing tags it as an
// interview: that is the detector's job, and seeding it already tagged would
// test nothing.
//
// Everything is upserted against the demo account (scripts/seed-demo-user.ts),
// so it is safe to run repeatedly. It touches nothing else.
import { openScriptDb } from "./_db";
import { and, eq } from "drizzle-orm";
// Every write below is limited to origin = "crawler": a posting a firm wrote
// itself on the firm portal is the firm's, and no script may change it.
import * as schema from "../src/db/schema";
import { POLICY_VERSION } from "../src/lib/policy";

const EMAIL = "demo@offerly.test";
const DAY = 86_400_000;

/** The two firms, and how far out each one opens. */
const FIRMS = [
  {
    slug: "goldman-sachs-demo",
    name: "Goldman Sachs",
    website: "goldmansachs.com",
    opensInDays: 27,
    people: [
      { name: "Alex Rivera", role: "Analyst", email: "kai.clauson@example.com" },
      { name: "Maxine Smith", role: "Associate", email: null },
      { name: "Mya Rajski", role: "Summer Analyst", email: null },
      { name: "Remi Rieger", role: "Vice President", email: null },
      { name: "Tena Broyles", role: "Managing Director", email: null },
    ],
  },
  {
    slug: "evercore-demo",
    name: "Evercore",
    website: "evercore.com",
    opensInDays: 13,
    people: [
      { name: "Ada Vance", role: "Analyst", email: "ada.vance@example.com" },
      { name: "Sam Ito", role: "Associate", email: null },
    ],
  },
];

async function main() {
  const { db } = await openScriptDb();

  const user = await db.query.users.findFirst({ where: eq(schema.users.email, EMAIL) });
  if (!user) throw new Error(`No ${EMAIL}. Run scripts/seed-demo-user.ts first.`);

  // The profile the prompts read: a cycle to match postings against, a sector
  // so the shortlist admits them, and a completed onboarding so the app's own
  // gates let this account reach a page at all.
  const gradYear = 2028;
  await db
    .update(schema.users)
    .set({
      gradYear,
      targetInternshipYear: gradYear - 1,
      preferredCategories: ["investment_banking"],
      nicheInterests: [],
      degreeLevel: null,
      consentedPolicyVersion: POLICY_VERSION,
      onboardingCompletedAt: new Date(),
      profileLinksPromptedAt: new Date(),
    })
    .where(eq(schema.users.id, user.id));

  for (const firm of FIRMS) {
    const existingFirm = await db.query.firms.findFirst({
      where: eq(schema.firms.slug, firm.slug),
    });
    const firmId =
      existingFirm?.id ??
      (
        await db
          .insert(schema.firms)
          .values({
            slug: firm.slug,
            name: firm.name,
            headquarters: "New York, NY",
            keyOffices: "New York",
            website: firm.website,
            description: "Seeded for the outreach demo.",
            hasVerifiedProgram: true,
          })
          .returning({ id: schema.firms.id })
      )[0].id;

    // On their own list, which is the first gate the shortlist applies.
    const tracked = await db.query.userTopFirms.findFirst({
      where: and(
        eq(schema.userTopFirms.userId, user.id),
        eq(schema.userTopFirms.firmId, firmId),
      ),
    });
    if (!tracked) {
      await db.insert(schema.userTopFirms).values({ userId: user.id, firmId });
    }

    // The posting. `opensAt` in the future with a real applicationUrl is what
    // makes this an "opens"/"posting" row rather than an estimate - the only
    // kind the prompts will count down from.
    const roleTitle = `${gradYear - 1} Investment Banking Summer Analyst`;
    const existingPosting = await db.query.internshipPostings.findFirst({
      where: and(
        eq(schema.internshipPostings.firmId, firmId),
        eq(schema.internshipPostings.roleTitle, roleTitle),
      ),
    });
    const opensAt = new Date(Date.now() + firm.opensInDays * DAY);
    const row = {
      firmId,
      categories: ["investment_banking" as const],
      roleTitle,
      location: "New York, NY",
      programYear: gradYear - 1,
      eligibleGradYears: [gradYear],
      opensText: `Applications open ${opensAt.toDateString()}`,
      opensAt,
      descriptionFull:
        "Seeded posting for the outreach demo. Undergraduate summer analyst programme in investment banking.",
      sourceUrl: `https://${firm.website}/careers`,
      applicationUrl: `https://${firm.website}/careers/apply`,
      isActive: true,
      updatedAt: new Date(),
    };
    if (existingPosting) {
      await db
        .update(schema.internshipPostings)
        .set(row)
        .where(and(eq(schema.internshipPostings.id, existingPosting.id), eq(schema.internshipPostings.origin, "crawler")));
    } else {
      await db.insert(schema.internshipPostings).values(row);
    }

    // The people. Reset to not_contacted, which is what the prompt counts - a
    // re-run is meant to put the demo back to the start, including after
    // someone has ticked the whole firm off to watch the bell close itself.
    for (const person of firm.people) {
      const existing = await db.query.contacts.findFirst({
        where: and(eq(schema.contacts.userId, user.id), eq(schema.contacts.name, person.name)),
      });
      if (existing) {
        await db
          .update(schema.contacts)
          .set({ relationshipStatus: "not_contacted", lastContactDate: null })
          .where(eq(schema.contacts.id, existing.id));
        continue;
      }
      await db.insert(schema.contacts).values({
        userId: user.id,
        name: person.name,
        firm: firm.name,
        role: person.role,
        email: person.email,
        emailConfidence: person.email ? "unverified" : null,
        relationshipStatus: "not_contacted",
      });
    }

    console.log(`${firm.name}: opens in ${firm.opensInDays} days, ${firm.people.length} contacts`);
  }

  // An interview to prepare for. Filed as a plain meeting on purpose - the
  // detector reads the title, and a row seeded as an interview would prove
  // nothing about whether it works.
  const interviewTitle = "Evercore | Superday - Round 2";
  const existingEvent = await db.query.events.findFirst({
    where: and(eq(schema.events.userId, user.id), eq(schema.events.title, interviewTitle)),
  });
  const interviewAt = new Date(Date.now() + 3 * DAY);
  if (existingEvent) {
    await db
      .update(schema.events)
      .set({ eventDate: interviewAt, type: "meeting", completed: false })
      .where(eq(schema.events.id, existingEvent.id));
  } else {
    await db.insert(schema.events).values({
      userId: user.id,
      type: "meeting",
      title: interviewTitle,
      eventDate: interviewAt,
    });
  }
  console.log(`Interview: "${interviewTitle}" in 3 days`);

  // So the flash speaks again on the next run rather than staying silent
  // because a previous run already showed it, and so the bell starts empty
  // rather than holding jobs from the last run.
  await db.delete(schema.flashesShown).where(eq(schema.flashesShown.userId, user.id));
  await db.delete(schema.notifications).where(eq(schema.notifications.userId, user.id));

  console.log(`\nSign in as ${EMAIL} to see the flash, then open Opportunities for the to-do row.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
