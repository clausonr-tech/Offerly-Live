import { getCurrentUser } from "@/lib/current-user";
import { CATEGORY_LABELS, IB_TIER_LABELS, PE_TIER_LABELS } from "@/lib/firm-metadata";
import { NICHE_SECTOR_GROUPS } from "@/lib/niche-sectors";
import { currentSpecialties } from "@/lib/question-bank/specialties";
import { TARGET_LOCATIONS } from "@/lib/locations";
import RecruitingAnswers, { type AnswerValues } from "../../settings/RecruitingAnswers";
import MoreAnswersForm from "../MoreAnswersForm";

/**
 * The Interests tab: everything that decides your matches, edited in one place.
 *
 * The recruiting-answers editor used to live on Settings while the profile form
 * edited the same sectors, tiers and locations - two editors for one set of
 * answers. It is the only editor now, driven by the onboarding question bank.
 */
export default async function InterestsPage() {
  const user = await getCurrentUser();

  const answers: AnswerValues = {
    // Every question the form renders needs its saved answer here. One left out
    // shows as unanswered, and saving the form writes that blank back over it.
    degreeLevel: user.degreeLevel,
    major: user.major,
    targetInternshipYear: user.targetInternshipYear ? `Summer ${user.targetInternshipYear}` : null,
    recruitingStage: user.recruitingStage,
    gradYear: user.gradYear ? String(user.gradYear) : null,
    preferredCategories: user.preferredCategories,
    // A retired label shows as its replacement, so re-saving writes the new one.
    nicheInterests: user.nicheInterests ? currentSpecialties(user.nicheInterests) : null,
    ibTierPreferences: user.ibTierPreferences,
    peTierPreferences: user.peTierPreferences,
    targetLocations: user.targetLocations,
    priorExperience: user.priorExperience,
    clubsAndActivities: user.clubsAndActivities,
    technicalReadiness: user.technicalReadiness,
    motivations: user.motivations,
    workStyle: user.workStyle,
    proudExperience: user.proudExperience,
    interests: user.interests,
    hometown: user.hometown,
    homeCountry: user.homeCountry,
    sponsorshipNeeded: user.sponsorshipNeeded,
    gpaBand: user.gpaBand,
  };


  return (
    <div className="space-y-6">
      <RecruitingAnswers
        defaultOpen
        values={answers}
        options={{
          sectors: Object.entries(CATEGORY_LABELS) as [string, string][],
          ibTiers: Object.values(IB_TIER_LABELS),
          peTiers: Object.values(PE_TIER_LABELS),
          nicheGroups: NICHE_SECTOR_GROUPS,
          locations: [...TARGET_LOCATIONS],
        }}
      />
      <MoreAnswersForm
        defaultValues={{ targetGroup: user.targetGroup, challengeLearned: user.challengeLearned }}
      />
    </div>
  );
}
