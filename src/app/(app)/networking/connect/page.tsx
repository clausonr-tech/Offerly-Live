import { getCurrentUser } from "@/lib/current-user";
import PeopleSection from "../PeopleSection";

export const metadata = { title: "Connect" };

type Search = {
  schools?: string;
  gradYears?: string;
  firms?: string;
  topFirms?: string;
  q?: string;
};

/** Connect: the people directory, its filters, and who to reach next. */
export default async function ConnectPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const user = await getCurrentUser();
  return (
    <PeopleSection
      viewerId={user.id}
      rawFilters={{
        schools: sp.schools,
        gradYears: sp.gradYears,
        firms: sp.firms,
        topFirms: sp.topFirms,
      }}
      query={typeof sp.q === "string" ? sp.q : ""}
    />
  );
}
