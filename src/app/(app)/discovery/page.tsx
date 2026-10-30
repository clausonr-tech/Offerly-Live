import { redirect } from "next/navigation";
import MatchedSection from "./MatchedSection";

export default async function DiscoveryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  // Firms, Contacts and Internships used to be tabs on this page. Old links
  // and bookmarks still carry ?tab=, so send them to where each one lives now
  // rather than silently landing on matches.
  const tab = params.tab;
  if (tab === "firms" || tab === "sectors") {
    const rest = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (k !== "tab" && typeof v === "string") rest.set(k, v);
    }
    const qs = rest.toString();
    redirect(`/discovery/firms${qs ? `?${qs}` : ""}`);
  }
  if (tab === "contacts") redirect("/contacts");
  if (tab === "internships") redirect("/discovery/internships");

  return (
    <div>
      {/* Same navy card as Opportunities' header. Colours are literal hex, not
          tokens: this card is always dark navy in both themes, and
          text-white/text-brand-900 resolve wrong on it under the dark theme. */}
      <div className="mb-8 rounded-2xl bg-gradient-to-br from-[#0b1526] via-[#1b2f4d] to-[#33517a] px-6 py-5 shadow-[0_10px_30px_-12px_rgba(11,21,38,0.55)]">
        <div className="min-w-0">
          <h1 className="app-hero-title text-2xl font-normal text-[#ffffff]">Discovery</h1>
          <p className="mt-1 max-w-2xl text-sm text-[#c3cfe2]">
            Start with your matches - the firms picked for you, and who to reach out to at each.
            Open internships for your cycle and the full firm directory are a tab away.
          </p>
        </div>
      </div>

      {/* Full width, so the board runs three firms across. It shared the row
          with the internships at half width, which held it to two. */}
      <h2 className="mb-3 text-base font-semibold text-brand-900">Your matches</h2>
      <MatchedSection />
    </div>
  );
}
