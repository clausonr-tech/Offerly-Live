import { BAND_LABELS, type ResponseLikelihood } from "@/lib/response-likelihood";

/**
 * A person's match score out of 100, with a bar beneath it.
 *
 * Shared between the Networking table and the firm cards on Opportunities so
 * the same person cannot show two different numbers depending on which page
 * you are looking at.
 *
 * Signal weights sum to 172 at their theoretical maximum, but several are
 * mutually exclusive - "Same school" (50) and "School connection" (30) can
 * never both fire - so nothing reaches it. Clamping rather than dividing by
 * that maximum keeps the number meaningful against the bands the scorer
 * already defines: 60+ is a strong match, so a full bar means genuinely
 * exceptional rather than merely good.
 */
export function scorePercent(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Red through yellow to green. Hue 0 is red and 120 is green, so the score
 * maps straight onto it - one expression rather than three stops, which keeps
 * 40 and 45 visibly different where banded colours would flatten them.
 */
export function scoreColor(pct: number): string {
  return `hsl(${pct * 1.2} 68% 45%)`;
}

export default function MatchScore({
  match,
  width = 56,
}: {
  match: ResponseLikelihood;
  width?: number;
}) {
  const pct = scorePercent(match.score);
  return (
    <div
      style={{ width }}
      title={
        `${BAND_LABELS[match.band]} — ` +
        (match.signals.map((s) => s.detail).join(" · ") || "no shared background on file")
      }
    >
      {/* Tabular figures so the numbers line up down a column instead of
          jittering by digit width. */}
      <span className="text-xs font-medium tabular-nums text-brand-900">{pct}</span>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-brand-100">
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, backgroundColor: scoreColor(pct) }}
        />
      </div>
    </div>
  );
}
