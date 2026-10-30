import { redirect } from "next/navigation";

// Opportunities and Applications used to be two separate tabs with two
// separate pages; they're now one page at /dashboard (top firms, open roles,
// and the tracked pipeline together). This keeps every old /applications
// link and bookmark - including its filters - working rather than 404ing.
export default async function ApplicationsRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") qs.set(key, value);
  }
  const query = qs.toString();
  redirect(query ? `/dashboard?${query}` : "/dashboard");
}
