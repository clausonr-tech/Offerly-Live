import { getCurrentUserId } from "@/lib/current-user";
import PracticeSession from "./PracticeSession";
import SchoolLeaderboard from "./SchoolLeaderboard";
import { getPracticeStats } from "@/lib/practice-session";

/** Practice rounds: the setup (and the round itself), then the school board. */
export default async function LearnPage() {
  const userId = await getCurrentUserId();
  const practiceStats = await getPracticeStats(userId);

  return (
    <div className="space-y-6">
      <PracticeSession initialStats={practiceStats} />
      <SchoolLeaderboard userId={userId} />
    </div>
  );
}
