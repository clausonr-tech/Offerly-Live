import { getCurrentUserId } from "@/lib/current-user";
import { getConsentState } from "@/lib/video-interview/consent";
import { processObjectDeletionQueue } from "@/lib/video-interview/deletion-queue";
import { isObjectStorageConfigured } from "@/lib/video-interview/object-storage";
import { checkVideoCoachReadiness, logReadiness, unavailableView } from "@/lib/video-interview/readiness";
import { getActiveSession, listRecentSessions } from "@/lib/video-interview/sessions";
import { sweepTrainingUploads } from "@/lib/video-interview/training-video";
import { isTranscriptionConfigured } from "@/lib/video-interview/transcription";
import CoachUnavailable from "./CoachUnavailable";
import VideoInterview from "./VideoInterview";

export const metadata = { title: "Video interview" };

/**
 * The video interview coach. Checks the database can run it first
 * (lib/video-interview/readiness) and says precisely what is wrong when it
 * can't - a missing migration, an empty question bank and a database outage
 * are three different messages in development, and one calm generic one in
 * production.
 *
 * The browser learns THAT speech-to-text and recording storage are set up -
 * two booleans - never with what, or which key.
 */
export default async function VideoInterviewPage() {
  const userId = await getCurrentUserId();
  const production = process.env.NODE_ENV === "production";

  const readiness = await checkVideoCoachReadiness();
  if (readiness.state !== "ready") {
    logReadiness(readiness);
    return <CoachUnavailable view={unavailableView(readiness.state, production)} />;
  }

  let data: Awaited<ReturnType<typeof load>> | null = null;
  try {
    data = await load(userId);
  } catch (err) {
    console.error("video interview page failed to load:", err);
  }
  if (!data) return <CoachUnavailable view={unavailableView("load_failed", production)} />;

  return (
    <VideoInterview
      initialConsent={data.consent}
      initialActive={data.active}
      initialRecent={data.recent}
      capabilities={{ transcription: isTranscriptionConfigured(), trainingStorage: isObjectStorageConfigured() }}
    />
  );
}

async function load(userId: string) {
  // Finish anything a closed tab left behind: expired uploads, interrupted
  // deletions. Best-effort - it must never stop the page loading.
  await sweepTrainingUploads(userId).catch((err) => console.error("training upload sweep failed:", err));
  // And a few queued deletions left by deleted accounts - only when there is a
  // store to delete from, so an unconfigured server does not churn the queue.
  if (isObjectStorageConfigured()) await processObjectDeletionQueue(10).catch((err) => console.error("object deletion queue failed:", err));
  const [consent, active, recent] = await Promise.all([getConsentState(userId), getActiveSession(userId), listRecentSessions(userId)]);
  return { consent, active, recent };
}
