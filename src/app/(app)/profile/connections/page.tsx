import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { getCurrentUser } from "@/lib/current-user";
import { getEmailConnections } from "@/lib/google-connection";
import { isGoogleOAuthConfigured } from "@/lib/google-oauth";
import { isTwilioConfigured } from "@/lib/twilio";
import PhoneForm from "../../settings/PhoneForm";
import { disconnectEmailConnection } from "../../settings/actions";
import { firmPostEmailsOn } from "@/lib/firm-post-emails";
import { setFirmPostEmailsAction } from "./email-actions";
import { hasOptedInToFirmSharing } from "@/lib/firm-sharing";
import FirmSharingToggle from "./FirmSharingToggle";
import TrainingChoiceToggle from "./TrainingChoiceToggle";
import { allowsTraining } from "@/lib/training-rule";
import VideoTrainingToggle from "./VideoTrainingToggle";
import { getConsentState } from "@/lib/video-interview/consent";
import { isObjectStorageConfigured } from "@/lib/video-interview/object-storage";

/** The Connections tab - what was the Settings page, minus the answers editor now on Interests. */
export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ google_connected?: string; google_error?: string }>;
}) {
  const { google_connected, google_error } = await searchParams;
  const user = await getCurrentUser();
  const connections = await getEmailConnections(user.id);
  const firmEmails = await firmPostEmailsOn(user.id);

  const googleConfigured = isGoogleOAuthConfigured();
  const twilioConfigured = isTwilioConfigured();
  const sharing = hasOptedInToFirmSharing(user);
  // The video coach's standing training answer. A database without the video
  // coach's tables (a fresh dev database) has no answer to show, and the rest
  // of this page must still load, so the section is simply left out.
  const videoTraining = await getConsentState(user.id).then(
    (c) => ({ choice: c.training?.choice ?? null }),
    () => null,
  );

  return (
    <div className="space-y-6">
      <p className="text-sm text-warmgray-500">
        Connect Google Calendar and your phone to automate scheduling and reminders, and choose which emails you get.
      </p>

      {google_connected && (
        <div className="rounded-md border border-success-200 bg-success-50 px-4 py-2 text-sm text-success-700">
          Google Calendar connected.
        </div>
      )}
      {google_error && (
        <div className="rounded-md border border-error-200 bg-error-50 px-4 py-2 text-sm text-error-600">
          Couldn&apos;t connect: {google_error}
        </div>
      )}

      <section className="rounded-lg border border-brand-100 bg-white p-5">
        <h2 className="mb-2 text-sm font-semibold text-brand-900">Google Calendar</h2>
        <p className="mb-3 text-sm text-warmgray-500">
          Connect the Google accounts whose calendars you use (personal, school, club). Offerly only
          touches your calendar, never your email.
        </p>
        <ul className="mb-3 space-y-1.5 text-sm text-warmgray-500">
          <li className="flex gap-2">
            <span className="text-accent-500">•</span>
            <span>
              Everything on your Google Calendar shows up on{" "}
              <Link href="/schedule" className="text-brand-900 hover:underline">
                Schedule
              </Link>
              , next to the interviews, coffee chats and deadlines you track in Offerly.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="text-accent-500">•</span>
            <span>
              What you add on Schedule is written back to a separate <strong>Offerly</strong> calendar
              in your Google account - hide or delete it any time without touching your own
              calendars. Meetings and coffee chats get a Google Meet link automatically.
            </span>
          </li>
        </ul>

        {!googleConfigured ? (
          <p className="text-xs text-warmgray-500">
            This integration hasn&apos;t been set up on this deployment yet - it needs a Google
            OAuth client, and{" "}
            <code className="rounded-sm bg-brand-50 px-1 py-0.5 font-mono text-[11px]">
              GOOGLE_CLIENT_ID
            </code>{" "}
            /{" "}
            <code className="rounded-sm bg-brand-50 px-1 py-0.5 font-mono text-[11px]">
              GOOGLE_CLIENT_SECRET
            </code>{" "}
            set in the environment. Steps are in{" "}
            <code className="rounded-sm bg-brand-50 px-1 py-0.5 font-mono text-[11px]">
              .env.example
            </code>
            .
          </p>
        ) : (
          <div>
            {connections.length > 0 && (
              <ul className="mb-3 divide-y divide-brand-100 border border-brand-100">
                {connections.map((c, i) => (
                  <li key={c.id} className="flex items-center justify-between gap-4 px-3 py-2">
                    <span className="flex items-center gap-1.5 text-sm text-success-700">
                      <CheckCircle2 size={14} />
                      {c.email ?? "Connected account"}
                      {i === 0 && (
                        <span className="ml-1 text-[11px] font-semibold uppercase tracking-wide text-warmgray-500">
                          Primary
                        </span>
                      )}
                    </span>
                    <form action={disconnectEmailConnection.bind(null, c.id)}>
                      <button
                        type="submit"
                        className="text-xs font-medium text-error-600 hover:underline"
                      >
                        Disconnect
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
            <a
              href="/api/auth/google/start"
              className="mt-3 inline-block bg-accent-500 px-4 py-2 text-sm font-semibold text-white hover:bg-accent-400 shadow-card"
            >
              {connections.length > 0 ? "Connect another Google account" : "Connect Google Calendar"}
            </a>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-brand-100 bg-white p-5">
        <h2 className="mb-2 text-sm font-semibold text-brand-900">Email</h2>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-warmgray-500">
            {firmEmails ? "On: " : "Off: "}
            an email when a firm you&apos;re matched with posts an internship, or an event at your school.
          </p>
          <form action={setFirmPostEmailsAction}>
            <input type="hidden" name="on" value={firmEmails ? "false" : "true"} />
            <button
              type="submit"
              className="rounded-full border border-brand-200 px-3.5 py-1.5 text-xs font-medium text-brand-900 hover:bg-brand-50"
            >
              {firmEmails ? "Turn off" : "Turn on"}
            </button>
          </form>
        </div>
      </section>

      {/* Where a student changes the answer they gave at the end of onboarding
          or on the consent screen. Same fields and fine print as both; saved
          as soon as the box changes. */}
      <section className="rounded-lg border border-brand-100 bg-white p-5">
        <FirmSharingToggle initial={sharing} />
      </section>

      <section className="rounded-lg border border-brand-100 bg-white p-5">
        <TrainingChoiceToggle initial={allowsTraining(user)} />
      </section>

      {videoTraining && (
        <section id="video-training" className="scroll-mt-6 rounded-lg border border-brand-100 bg-white p-5">
          <VideoTrainingToggle initial={videoTraining.choice} storageAvailable={isObjectStorageConfigured()} />
        </section>
      )}

      <section className="rounded-lg border border-brand-100 bg-white p-5">
        <h2 className="mb-2 text-sm font-semibold text-brand-900">SMS</h2>
        <p className="mb-3 text-sm text-warmgray-500">
          Send a test text to the phone number on your profile to confirm the connection.
        </p>
        <PhoneForm defaultPhone={user.phone} twilioConfigured={twilioConfigured} />
      </section>
    </div>
  );
}
