/**
 * Marks seeded example content - sample discussions and sample students - so
 * it is never mistaken for a real post or a real person. Every place that
 * shows one shows this.
 */
export default function SampleTag({ title = "An example, not a real student" }: { title?: string }) {
  return (
    <span
      title={title}
      className="shrink-0 rounded-sm border border-brand-200 px-1 py-px font-mono text-[10px] uppercase tracking-[0.12em] text-warmgray-500"
    >
      Sample
    </span>
  );
}
