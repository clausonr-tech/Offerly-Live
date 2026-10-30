/**
 * What the card is allowed to show, as a pure decision.
 *
 * Lifted out of the component so it can be tested directly. The rule it
 * replaces was `contact.email ? show : "No email found"` - a single non-null
 * check, which is exactly how `vikram.jolly@greenhill.com` appeared on an
 * Evercore page: the column was set, so it rendered.
 *
 * FAILS CLOSED. Anything it does not positively recognise - a missing
 * relevance flag, an unknown status string, a backend that forgot a field -
 * renders as "No email found" rather than as an address. The backend gate is
 * authoritative; this is the second lock on the same door, and a second lock
 * that opens when confused is not a lock.
 */

const RENDERABLE_CONFIDENCE = ["verified", "catch_all", "predicted"] as const;

type RenderableConfidence = (typeof RENDERABLE_CONFIDENCE)[number];

/** The shape the card receives. Deliberately loose: the whole point is to
 *  behave correctly when the backend sends something unexpected. */
export type RenderableContactEmail = {
  email?: string | null;
  emailConfidence?: string | null;
  emailDomainRelevant?: boolean | null;
};

export function shouldRenderEmail(contact: RenderableContactEmail): boolean {
  if (!contact) return false;
  if (typeof contact.email !== "string") return false;
  if (!contact.email.trim()) return false;
  // Strictly true. `undefined`, `null` and any truthy non-boolean are refused,
  // so a fixture or a payload that simply omits the flag cannot render.
  if (contact.emailDomainRelevant !== true) return false;
  return RENDERABLE_CONFIDENCE.includes(contact.emailConfidence as RenderableConfidence);
}

/**
 * The badge beside a rendered address, or null when it needs none.
 *
 * `verified` gets no badge - the address is simply shown. Everything else
 * says which of the weaker promises it is. "UNVERIFIED" is gone: it covered a
 * derived address and an unchecked one with the same word, and those are not
 * the same thing to tell someone about to email a person they want to impress.
 */
export function emailLabel(confidence: string | null | undefined): "CATCH-ALL" | "PREDICTED" | null {
  if (confidence === "catch_all") return "CATCH-ALL";
  if (confidence === "predicted") return "PREDICTED";
  return null;
}

/**
 * The address to show for one of the student's own contacts, or null.
 *
 * One found by contact search (an `emailSource`, or an `enrichedAt`) passes the gate above,
 * like every sourced address. One the student typed in themselves is theirs
 * to see as they typed it - the gate's relevance flag is never set on those,
 * so gating them would hide every hand-entered address.
 */
export function contactEmailToShow(
  contact: RenderableContactEmail & { emailSource?: string | null; enrichedAt?: Date | string | null },
): string | null {
  const email = typeof contact.email === "string" ? contact.email.trim() : "";
  if (!email) return null;
  // Found by contact search - by its source, or, for rows from before the
  // source was recorded, by when it was found - so it passes the gate.
  if (contact.emailSource || contact.enrichedAt) return shouldRenderEmail(contact) ? email : null;
  return email;
}
