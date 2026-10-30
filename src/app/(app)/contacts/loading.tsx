// Inside the External Network shell (top bar already painted); holds the
// contacts table's place while the rows are queried.
export default function ContactsLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading contacts">
      <div className="h-8 w-64 animate-pulse rounded-md bg-brand-50/60" />
      <div className="list-panel h-[28rem] animate-pulse border border-brand-100 bg-brand-50/60" />
    </div>
  );
}
