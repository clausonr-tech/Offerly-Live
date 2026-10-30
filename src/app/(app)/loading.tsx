// The instant answer to a tab click: the sidebar and top bar are already on
// screen from the shared layout, so this holds the page column's place while
// the server renders the real thing. Any route without its own loading.tsx
// falls back to this one - which is also what lets next/link prefetch give
// dynamic pages an instant transition instead of a frozen click.
export default function AppLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading page">
      <div className="h-8 w-56 animate-pulse rounded-md bg-brand-50/60" />
      <div className="list-panel h-40 animate-pulse border border-brand-100 bg-brand-50/60" />
      <div className="list-panel h-64 animate-pulse border border-brand-100 bg-brand-50/60" />
    </div>
  );
}
