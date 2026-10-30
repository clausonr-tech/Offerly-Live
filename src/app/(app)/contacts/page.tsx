import { getCurrentUser } from "@/lib/current-user";

import { ContactGrid } from "./ContactGrid";
import { loadScoredContacts } from "./contacts-data";

export const metadata = { title: "Industry Contacts" };

/**
 * Every contact this student has, as the full sheet. Part of External
 * Network (lib/nav-sections): these are people at firms, not Offerly users.
 *
 * The hub can expand to show the same table inline, so this page is for the
 * times the table IS the task - working down a firm, or a link someone wants
 * to bookmark. It shares `loadScoredContacts` with the hub so a person cannot
 * show one match score here and a different one there.
 */
export default async function ContactsSheetPage({
  searchParams,
}: {
  /** `?q=<firm>` opens the table filtered to one firm - see ContactGrid. */
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const query = typeof sp.q === "string" ? sp.q : "";
  const user = await getCurrentUser();
  const rows = await loadScoredContacts(user);

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-brand-900">Industry Contacts</h1>
        <p className="mt-1 text-sm text-warmgray-500">
          Everyone you have sourced or added, in one table. Rows you have written to are shaded.
        </p>
      </header>

      <ContactGrid rows={rows} initialQuery={query} />
    </div>
  );
}
