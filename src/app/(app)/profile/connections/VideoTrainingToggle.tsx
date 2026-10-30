"use client";

import { useState, useTransition } from "react";
import { deleteAllTrainingVideos, setVideoTrainingChoice } from "../../learn/video/actions";
import type { TrainingChoice } from "@/lib/video-interview/types";

/**
 * The video coach's standing training answer - "contribute my interviews'
 * recordings?" - where a student changes it after giving it once at their
 * first Start. It lived in a box on the interview setup page until
 * 5 October 2026, when the owner asked for that box to go: the question is
 * asked once, and changing the answer is a setting, like the writing one
 * beside it.
 *
 * Saved the moment it changes, the same pattern as the toggles around it. A
 * no also stops an unfinished interview from contributing (consent.ts) but
 * keeps what was already contributed; deleting that is the button below.
 */
export default function VideoTrainingToggle({
  initial,
  storageAvailable,
}: {
  /** The standing answer, or null before the first Start asked. */
  initial: TrainingChoice | null;
  storageAvailable: boolean;
}) {
  const [choice, setChoice] = useState<TrainingChoice | null>(initial);
  const [status, setStatus] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, startTransition] = useTransition();

  const change = (next: TrainingChoice) =>
    startTransition(async () => {
      const before = choice;
      setChoice(next);
      setStatus("Saving...");
      const res = await setVideoTrainingChoice(next);
      if (res.ok) {
        setChoice(res.data.training?.choice ?? next);
        setStatus("Saved");
      } else {
        setChoice(before);
        setStatus(res.error);
      }
    });

  const deleteAll = () =>
    startTransition(async () => {
      setConfirmDelete(false);
      setStatus("Deleting...");
      const res = await deleteAllTrainingVideos();
      if (!res.ok) return setStatus(res.error);
      const { deleted, outstanding } = res.data;
      setStatus(
        outstanding
          ? `${deleted} deleted; ${outstanding} more will be deleted as soon as storage responds.`
          : deleted
            ? `${deleted} training recording${deleted === 1 ? "" : "s"} deleted.`
            : "You have no training recordings.",
      );
    });

  return (
    <>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-brand-900">Improving Offerly&apos;s interview coach</h2>
        <span className={`text-xs font-medium ${choice === "yes" ? "text-success-700" : "text-warmgray-500"}`}>
          {choice === "yes" ? "On" : choice === "no" ? "Off - nothing is kept for training" : "Not asked yet"}
        </span>
      </div>
      <p className="text-sm text-warmgray-600">
        Contribute the video and voice recordings of your video interview answers to help train Offerly&apos;s coaching
        AI. They&apos;re stored privately and never shared with employers or made public. Saying no never affects your
        interviews or feedback.
        {choice === null && " You'll be asked the first time you start a video interview, or you can choose now."}
      </p>
      {!storageAvailable && (
        <p role="note" className="mt-2 rounded-md bg-gold-50 px-2.5 py-1.5 text-xs text-brand-900">
          Recording storage isn&apos;t set up on this server, so no training recording can be kept right now.
        </p>
      )}
      <fieldset className="mt-3 flex flex-wrap gap-2" disabled={pending}>
        <legend className="sr-only">Contribute your video interview recordings</legend>
        {(
          [
            ["yes", "Contribute my interviews"],
            ["no", "Don't share them"],
          ] as const
        ).map(([value, label]) => (
          <label
            key={value}
            className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm ${
              choice === value ? "border-accent-500 bg-accent-50 text-brand-900" : "border-brand-200 text-warmgray-600"
            }`}
          >
            <input
              type="radio"
              name="videoTraining"
              value={value}
              checked={choice === value}
              onChange={() => change(value)}
              className="accent-accent-500"
            />
            {label}
          </label>
        ))}
      </fieldset>
      <div className="mt-3">
        {confirmDelete ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-brand-900">Delete every training recording you&apos;ve contributed? Your interviews and feedback stay.</span>
            <button
              type="button"
              disabled={pending}
              onClick={deleteAll}
              className="rounded-md bg-error-600 px-3 py-1.5 text-sm font-medium text-[#ffffff] hover:opacity-90 disabled:opacity-60"
            >
              Delete training recordings
            </button>
            <button type="button" onClick={() => setConfirmDelete(false)} className="rounded-md px-3 py-1.5 text-sm text-warmgray-600 hover:underline">
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setConfirmDelete(true)} className="text-xs text-warmgray-600 hover:text-error-600 hover:underline">
            Delete all training recordings
          </button>
        )}
      </div>
      <p aria-live="polite" className="mt-2 min-h-4 text-xs text-warmgray-500">
        {status}
      </p>
    </>
  );
}
