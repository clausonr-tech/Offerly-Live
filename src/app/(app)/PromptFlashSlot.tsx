import { getCurrentUser } from "@/lib/current-user";
import { toneForNotification } from "@/lib/label-colors";
import { getPendingFlash } from "@/lib/prompt-flash";

import PromptFlash from "./PromptFlash";

/**
 * The next prompt bubble, fetched off the critical path.
 *
 * Streamed like the message bubble, so the page paints without waiting on it.
 * One bubble at a time whichever prompt it is - see getPendingFlash, which
 * picks the most urgent across all of them.
 */
export default async function PromptFlashSlot() {
  const user = await getCurrentUser();
  const flash = await getPendingFlash(user);
  if (!flash) return null;

  return (
    <PromptFlash
      // Keyed by the firing, so the next one in the queue is a NEW component.
      // Without it React reuses this instance when the page refreshes after a
      // bubble leaves, and the incoming row inherits the outgoing one's
      // "already gone" state: it never animates, never files its notification,
      // and the bell sits one job short.
      key={flash.flashKey}
      row={{
        flashKey: flash.flashKey,
        chip: flash.chip,
        subject: flash.subject,
        detail: flash.detail,
        href: flash.href,
        cta: flash.cta,
        doneKey: flash.doneKey,
        doneLabel: flash.doneLabel,
        doneAction: flash.doneAction,
        tone: flash.tone ?? toneForNotification(flash.notifications[0]?.kind),
      }}
    />
  );
}
