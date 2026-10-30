import { redirect } from "next/navigation";
import { asc } from "drizzle-orm";
import { getDb } from "@/db/client";
import { schools } from "@/db/schema";
import { getCurrentUser } from "@/lib/current-user";
import LinksForm from "./LinksForm";

export default async function ProfileLinksPage() {
  const user = await getCurrentUser();
  if (user.onboardingCompletedAt) redirect("/dashboard");
  if (user.profileLinksPromptedAt) redirect("/onboarding");

  // The same allowlist that backs school-email verification. Offering a free
  // text box instead would mean no crest and no matching signal - "USC",
  // "usc", and "Southern Cal" are three schools to a database and one to a
  // student - so the picker is the only way in.
  const db = await getDb();
  const options = await db
    .select({ id: schools.id, name: schools.name })
    .from(schools)
    .orderBy(asc(schools.name));

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <LinksForm schools={options} />
    </div>
  );
}
