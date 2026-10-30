import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/current-user";
import { CATEGORY_LABELS, type FirmProgramCategory } from "@/lib/firm-metadata";
import { NICHE_SECTOR_GROUPS } from "@/lib/niche-sectors";
import OnboardingWizard from "./OnboardingWizard";

const SECTOR_OPTIONS = Object.entries(CATEGORY_LABELS) as [FirmProgramCategory, string][];

export default async function OnboardingPage() {
  const user = await getCurrentUser();
  if (user.onboardingCompletedAt) redirect("/dashboard");
  if (!user.profileLinksPromptedAt) redirect("/onboarding/links");

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <OnboardingWizard sectorOptions={SECTOR_OPTIONS} nicheGroups={NICHE_SECTOR_GROUPS} />
    </div>
  );
}
