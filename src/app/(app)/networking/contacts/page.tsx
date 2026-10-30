import { redirect } from "next/navigation";

// Industry Contacts moved to /contacts when Networking became Internal Network
// (lib/nav-sections). Kept so old links, bookmarks and reminders still land on
// the sheet - with the ?q= firm filter carried over.
export default async function OldContactsSheetRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : "";
  redirect(q ? `/contacts?q=${encodeURIComponent(q)}` : "/contacts");
}
