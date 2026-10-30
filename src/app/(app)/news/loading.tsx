// News assembles the briefing, wraps and boards from several queries; hold
// the column with a headline row and two board-sized panels until they land.
export default function NewsLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading news">
      <div className="h-8 w-40 animate-pulse rounded-md bg-brand-50/60" />
      <div className="list-panel h-64 animate-pulse border border-brand-100 bg-brand-50/60" />
      <div className="list-panel h-96 animate-pulse border border-brand-100 bg-brand-50/60" />
    </div>
  );
}
