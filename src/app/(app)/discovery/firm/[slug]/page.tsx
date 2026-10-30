import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { and, count, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { contacts, studentOpeningReports } from "@/db/schema";
import { getCurrentUser } from "@/lib/current-user";
import { getFirmBySlug } from "@/lib/firms";
import { computeRelevanceScore } from "@/lib/relevance";
import { findPeopleToReachOut } from "@/lib/people-matching";
import { CONTACTS_PER_RUN, getContactCredits } from "@/lib/contact-credits";
import {
  CATEGORY_LABELS,
  type FirmProgramCategory,
} from "@/lib/firm-metadata";
import { FIRM_MERGE_REDIRECTS } from "@/lib/firm-merge-redirects";
import FirmLogo from "../../FirmLogo";
import { listFirmRecruitingEvents } from "@/lib/recruiting-events-feed";
import FirmProgramTabs from "./FirmProgramTabs";
import FirmRecruitingEvents from "./FirmRecruitingEvents";
import GenerateContactsButton from "./GenerateContactsButton";
import ReportOpeningForm from "./ReportOpeningForm";
import { defaultCycleYear, selectableCycleYears } from "./cycles";
import { DraftEmailButton } from "../../../drafts/QuickDraft";
import { contactEmailToShow, emailLabel } from "@/lib/contact-email-render";
import { externalHref } from "@/lib/safe-url";

export default async function FirmDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ category?: string; from?: string }>;
}) {
  const { slug } = await params;
  const { category, from } = await searchParams;
  // Firms that were folded into a parent brand keep working links. Their rows
  // are gone from the seeds, so without this every bookmark, saved-list entry
  // and crawled posting pointing at an absorbed entity would 404. Checked
  // before the lookup, not only when it misses: the absorbed row stays in the
  // table until a pruning sync (`npm run db:sync-firms -- --prune-orphans`),
  // and until then its page would be an empty duplicate of the parent's.
  const canonical = FIRM_MERGE_REDIRECTS.get(slug);
  if (canonical) {
    // Carry the return view across the redirect too, or following an old
    // link to an absorbed entity quietly costs the student their place.
    const carried = new URLSearchParams();
    if (category) carried.set("category", category);
    if (from) carried.set("from", from);
    const qs = carried.toString();
    redirect(`/discovery/firm/${canonical}${qs ? `?${qs}` : ""}`);
  }
  const firm = await getFirmBySlug(slug);
  if (!firm) notFound();

  // `from` carries the exact directory view the student left - tab, filters,
  // how far they had paged. Without it this link went to a bare /discovery,
  // which opens on the Internships tab with no filters, so "back" landed
  // nowhere near the firms they were reading.
  //
  // Validated, not trusted: it arrives in the query string, so anything that is
  // not a relative path into the directory is discarded. The shared policy does
  // the "is this really an in-app path" half - `//` read as protocol-relative,
  // a backslash that the URL parser treats as a slash, a tab it strips before
  // parsing - and the prefix test keeps it inside the directory. The hand-
  // rolled `!startsWith("//")` that used to stand here was correct but was a
  // second copy of a policy that lives in one place now.
  const safeFrom = from?.startsWith("/discovery") ? externalHref(from) ?? null : null;

  const backHref =
    safeFrom ?? (category && category in CATEGORY_LABELS ? `/discovery/${category}` : "/discovery");
  const backLabel =
    category && category in CATEGORY_LABELS
      ? CATEGORY_LABELS[category as FirmProgramCategory]
      : safeFrom?.startsWith("/discovery/firms")
        ? "Firms"
        : "Discovery";

  const user = await getCurrentUser();
  // The demo firm (scripts/seed-firm-demo.ts) exists for demo accounts only.
  if (firm.isDemo && !user.isDemo) notFound();
  const db = await getDb();
  const allContacts = await db.query.contacts.findMany({
    where: eq(contacts.userId, user.id),
  });

  // Top five from the imported people directory, ranked by what the student
  // has in common with them. Read live, so an updated import shows here without
  // anything being re-synced.
  const reachOut = await findPeopleToReachOut(user, [firm.id], 5);

  const credits = await getContactCredits(user.id);

  const firmNameLower = firm.name.toLowerCase();
  const contactsHere = allContacts
    .filter((c) => c.firm && firmNameLower.includes(c.firm.toLowerCase()))
    .map((c) => ({ ...c, relevance: computeRelevanceScore(user, c) }))
    .sort((a, b) => b.relevance.score - a.relevance.score);

  // Only the sectors this firm actually runs a programme in are offered to
  // report against - the full 14-value list would ask a student to pick a desk
  // the firm does not have.
  const reportableCategories = [...new Set(firm.programs.map((p) => p.category))];
  const cycleYears = selectableCycleYears();
  const defaultCycle = defaultCycleYear();

  // Everything upcoming the crawler has filed for this firm. Read live rather
  // than cached: these are dated, and a stale list is worse than no list.
  const recruitingEvents = await listFirmRecruitingEvents(firm.id, new Date(), user);

  // How many students have already said this firm is open for the default
  // cycle. Shown as corroboration, and counted across every programme rather
  // than per desk, since the collapsed prompt has not asked which one yet.
  const [{ existingReportCount }] = await db
    .select({ existingReportCount: count() })
    .from(studentOpeningReports)
    .where(
      and(
        eq(studentOpeningReports.firmId, firm.id),
        eq(studentOpeningReports.cycleYear, defaultCycle),
        isNull(studentOpeningReports.dismissedAt),
      ),
    );

  return (
    <div className="mx-auto max-w-3xl">
      <Link href={backHref} className="text-sm text-warmgray-500 hover:underline">
        ← {backLabel}
      </Link>

      <div className="mt-3 flex items-start gap-4">
        <FirmLogo domain={firm.website} name={firm.name} size={56} />
        <div>
          <h1 className="text-2xl font-semibold text-brand-900">{firm.name}</h1>
          <p className="text-sm text-warmgray-500">{firm.headquarters}</p>
        </div>
      </div>

      <p className="mt-4 text-sm text-warmgray-600">{firm.description}</p>

      {/* The firm's own words, kept visibly separate from the summary above.
          Rendered as a quotation with the page it came from, because it is
          their copy and not ours - and only when both the text and its source
          are present, so nothing is ever shown unattributed. */}
      {firm.selfDescription && externalHref(firm.selfDescriptionSourceUrl) ? (
        <figure className="mt-4 border-l-2 border-brand-100 pl-4">
          <blockquote className="text-sm italic text-warmgray-600">
            &ldquo;{firm.selfDescription}&rdquo;
          </blockquote>
          <figcaption className="mt-1.5 text-xs text-warmgray-500">
            {firm.name}, in its own words &middot;{" "}
            <a
              // Read-boundary guard on a crawled URL - React neutralises only
              // `javascript:`. See lib/safe-url.
              href={externalHref(firm.selfDescriptionSourceUrl)!}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-accent-600"
            >
              source
            </a>
          </figcaption>
        </figure>
      ) : null}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-brand-100 bg-white p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-warmgray-500">
            Key offices
          </p>
          <p className="mt-1 text-sm text-brand-900">{firm.keyOffices}</p>
        </div>
        <div className="rounded-lg border border-brand-100 bg-white p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-warmgray-500">Website</p>
          {/* Directory firms imported from SEC filings do not all publish a
              website on Form ADV. Saying so beats a link to "https://". */}
          {externalHref(`https://${firm.website}`) ? (
            <a
              href={externalHref(`https://${firm.website}`)!}
              target="_blank"
              rel="noreferrer"
              className="mt-1 flex items-center gap-1 text-sm text-brand-900 hover:underline"
            >
              {firm.website}
              <ExternalLink size={12} />
            </a>
          ) : (
            <p className="mt-1 text-sm text-warmgray-500">Not published</p>
          )}
        </div>
      </div>

      {/* People first. A firm is a target because of who you can reach there, so
          the question "who do I write to" is answered before the reference
          material rather than under it. */}
      {reachOut.length > 0 && (
        <div className="mt-6">
          <h2 className="mb-2 text-base font-semibold text-brand-900">
            Top people to reach out to
          </h2>
          <div className="divide-y divide-brand-100 overflow-hidden rounded-lg border border-brand-100 bg-white">
            {reachOut.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <div className="min-w-48 flex-1">
                  <p className="truncate text-sm font-medium text-brand-900">{p.name}</p>
                  <p className="truncate text-[11px] text-warmgray-500">
                    {[p.title, p.school].filter(Boolean).join(" · ") || "Role not recorded"}
                  </p>
                  {p.reasons.length > 0 && (
                    <p className="truncate text-[11px] font-medium text-success-700">
                      {p.reasons.join(" · ")}
                    </p>
                  )}
                </div>
                {externalHref(p.linkedinUrl) && (
                  <a
                    // Provider-supplied, so guarded like the crawled links here.
                    href={externalHref(p.linkedinUrl)!}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-brand-900 hover:underline"
                  >
                    LinkedIn <ExternalLink size={11} />
                  </a>
                )}
                <Link
                  href="/outreach/email"
                  className="shrink-0 rounded-md border border-brand-200 px-2.5 py-1 text-xs font-medium text-brand-900 hover:border-accent-400"
                >
                  Draft
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-6">
        <h2 className="mb-2 text-base font-semibold text-brand-900">Your contacts here</h2>
        <GenerateContactsButton
          firmId={firm.id}
          firmName={firm.name}
          contactsPerRun={CONTACTS_PER_RUN}
          credits={{
            remaining: credits.unlimited ? -1 : credits.remaining,
            limit: credits.limit,
            unlimited: credits.unlimited,
          }}
        />
      </div>

      {contactsHere.length > 0 && (
        <div className="mt-4">
          <div className="stagger-in divide-y divide-brand-100 overflow-hidden rounded-lg border border-brand-100 bg-white">
            {contactsHere.map((c) => {
              const email = contactEmailToShow(c);
              const tag = email && c.emailSource ? emailLabel(c.emailConfidence) : null;
              return (
                // A row, not one link: the email, LinkedIn and Draft email
                // sit beside the link to their page, and none of them can
                // live inside a link.
                <div key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-brand-50">
                  <div className="min-w-0 flex-1">
                    <Link href={`/contacts/${c.id}`} className="text-sm font-medium text-brand-900 hover:underline">
                      {c.name}
                    </Link>
                    <p className="text-xs text-warmgray-500">{c.role ?? "-"}</p>
                    {/* How to reach them, on the row itself - the address and
                        their profile were only a click deeper before. */}
                    {(email || c.linkedinUrl) && (
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs">
                        {email && (
                          <a href={`mailto:${email}`} className="font-mono text-[11px] text-brand-900 hover:underline">
                            {email}
                            {tag && (
                              <span className="ml-1 font-sans text-[10px] uppercase tracking-wide text-warmgray-500">
                                {tag}
                              </span>
                            )}
                          </a>
                        )}
                        {externalHref(c.linkedinUrl) && (
                          <a
                            // Provider-supplied, so guarded like the crawled links here.
                            href={externalHref(c.linkedinUrl)!}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="inline-flex items-center gap-1 font-medium text-brand-900 hover:underline"
                          >
                            LinkedIn <ExternalLink size={11} aria-hidden />
                          </a>
                        )}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {c.relevance.reasons.length > 0 && (
                      <span className="rounded-sm border border-success-200 bg-success-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-success-800">
                        {c.relevance.reasons[0]}
                      </span>
                    )}
                    <DraftEmailButton recipientKey={`contact-${c.id}`} name={c.name} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Above the programme tabs deliberately: an event has a date attached
          and can be missed, whereas the timing reference cannot. */}
      {recruitingEvents.length > 0 && (
        <FirmRecruitingEvents firmName={firm.name} slug={firm.slug} events={recruitingEvents} />
      )}

      <div className="mt-8">
        <h2 className="mb-2 text-base font-semibold text-brand-900">Programs & application timing</h2>
        <FirmProgramTabs firmName={firm.name} programs={firm.programs} />
      </div>

      <ReportOpeningForm
        firmId={firm.id}
        slug={firm.slug}
        firmName={firm.name}
        categories={reportableCategories}
        cycleYears={cycleYears}
        defaultCycle={defaultCycle}
        existingReportCount={existingReportCount}
      />
    </div>
  );
}
