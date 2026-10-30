// Holds the dashboard's shape while its queries run: the navy header card is
// painted for real (it is always that gradient, so showing it at once reads
// as the page arriving), and the firms column and Today list pulse in place.
// Mirrors the page's xl grid so nothing lurches when the data lands.
export default function DashboardLoading() {
  return (
    <div aria-busy="true" aria-label="Loading dashboard">
      <div className="grid items-start gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] xl:grid-rows-[auto_1fr]">
        <div className="min-w-0 rounded-2xl bg-gradient-to-br from-[#0b1526] via-[#1b2f4d] to-[#33517a] px-6 py-5 shadow-[0_10px_30px_-12px_rgba(11,21,38,0.55)] xl:col-start-1 xl:row-start-1">
          <div className="h-7 w-64 animate-pulse rounded bg-white/15" />
          <div className="mt-3 h-36 w-full max-w-[18rem] animate-pulse rounded-lg bg-white/10" />
          <div className="mt-3 h-4 w-48 animate-pulse rounded bg-white/10" />
        </div>
        <div className="min-w-0 xl:col-start-2 xl:row-span-2 xl:row-start-1">
          <div className="list-panel h-96 animate-pulse border border-brand-100 bg-brand-50/60" />
          <div className="list-panel mt-8 h-32 animate-pulse border border-brand-100 bg-brand-50/60" />
        </div>
        <div className="min-w-0 space-y-8 xl:col-start-1 xl:row-start-2">
          <div className="list-panel h-56 animate-pulse border border-brand-100 bg-brand-50/60" />
          <div className="list-panel h-40 animate-pulse border border-brand-100 bg-brand-50/60" />
        </div>
      </div>
    </div>
  );
}
