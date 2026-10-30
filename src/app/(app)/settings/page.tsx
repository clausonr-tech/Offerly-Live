import { redirect } from "next/navigation";

// Settings is the Connections tab of the profile now, and its recruiting
// answers editor moved to the Interests tab. Kept as a redirect: bookmarks and
// older links point here. Query parameters are carried over so a
// ?google_error=... still reaches the page that shows it.
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (typeof value === "string") params.set(key, value);
  }
  const query = params.toString();
  redirect(`/profile/connections${query ? `?${query}` : ""}`);
}
