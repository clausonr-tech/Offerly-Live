import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink, Mail } from "lucide-react";
import { getCurrentUser } from "@/lib/current-user";
import { getContactDirectory } from "@/lib/contact-directory";
import { CATEGORY_LABELS, type FirmProgramCategory } from "@/lib/firm-metadata";
import { RELATIONSHIP_COLORS, RELATIONSHIP_LABELS } from "@/lib/badges";
import { externalHref } from "@/lib/safe-url";
import FirmLogo from "../../../discovery/FirmLogo";

/**
 * One company's people, grouped by the division they sit in.
 *
 * The grouping key is the firm's sector rather than anything typed on the
 * contact: a student writing "VP, Leveraged Finance" should land under
 * Investment Banking without having to categorise anyone by hand. Firms the
 * directory doesn't know fall into a single group rather than disappearing.
 */
export default async function CompanyContactsPage({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  const { key } = await params;
  const user = await getCurrentUser();

  const companies = await getContactDirectory(user.id);
  const company = companies.find((c) => c.key === decodeURIComponent(key));
  if (!company) notFound();

  // A contact inherits every sector its firm recruits for, so someone at a bank
  // that does both IB and S&T appears under both. That is the honest reading -
  // the student knows a person at the bank, and which desk is on the row itself.
  const groups = new Map<string, typeof company.contacts>();
  for (const person of company.contacts) {
    const keys = person.industries.length > 0 ? person.industries : ["__other"];
    for (const k of keys) {
      const list = groups.get(k) ?? [];
      list.push(person);
      groups.set(k, list);
    }
  }

  const ordered = [...groups.entries()].sort((a, b) => {
    if (a[0] === "__other") return 1;
    if (b[0] === "__other") return -1;
    return (CATEGORY_LABELS[a[0] as FirmProgramCategory] ?? a[0]).localeCompare(
      CATEGORY_LABELS[b[0] as FirmProgramCategory] ?? b[0],
    );
  });

  return (
    <div>
      <Link
        href="/contacts"
        className="text-sm text-warmgray-500 hover:underline"
      >
        ← Industry Contacts
      </Link>

      <div className="mb-6 mt-2 flex items-center gap-3">
        <FirmLogo domain={company.website ?? ""} name={company.name} size={36} />
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold text-brand-900">{company.name}</h1>
          <p className="text-sm text-warmgray-500">
            {company.contacts.length} contact{company.contacts.length === 1 ? "" : "s"}
            {company.slug && (
              <>
                {" · "}
                <Link href={`/discovery/firm/${company.slug}`} className="text-brand-900 hover:underline">
                  Firm profile
                </Link>
              </>
            )}
          </p>
        </div>
      </div>

      <div className="space-y-6">
        {ordered.map(([groupKey, people]) => (
          <section key={groupKey}>
            <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-warmgray-500">
              {groupKey === "__other"
                ? "Division not known"
                : (CATEGORY_LABELS[groupKey as FirmProgramCategory] ?? groupKey)}
            </h2>
            <div className="divide-y divide-brand-100 overflow-hidden rounded-lg border border-brand-100 bg-white">
              {people.map((p) => (
                <div key={`${groupKey}-${p.id}`} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-48 flex-1">
                    <Link
                      href={`/contacts/${p.id}`}
                      className="text-sm font-medium text-brand-900 hover:underline"
                    >
                      {p.name}
                    </Link>
                    <p className="truncate text-[11px] text-warmgray-500">
                      {[p.role, p.seniority !== "Other" ? p.seniority : null]
                        .filter(Boolean)
                        .join(" · ") || "Role not recorded"}
                    </p>
                  </div>

                  <a
                    href={`mailto:${p.email}`}
                    className="inline-flex min-w-0 items-center gap-1.5 text-xs text-brand-900 hover:underline"
                  >
                    <Mail size={12} className="shrink-0" />
                    <span className="truncate">{p.email}</span>
                  </a>

                  {/* Read-boundary guard - the same stored, provider-supplied
                      column ContactGrid renders. See lib/safe-url. */}
                  {externalHref(p.linkedinUrl) && (
                    <a
                      href={externalHref(p.linkedinUrl)!}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-brand-900 hover:underline"
                    >
                      LinkedIn <ExternalLink size={11} />
                    </a>
                  )}

                  {p.school && <span className="text-[11px] text-warmgray-500">{p.school}</span>}

                  <span
                    className={`shrink-0 rounded-sm px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${
                      RELATIONSHIP_COLORS[p.relationshipStatus]
                    }`}
                  >
                    {RELATIONSHIP_LABELS[p.relationshipStatus]}
                  </span>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
