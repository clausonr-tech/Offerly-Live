/**
 * A titled block on the profile pages. The title carries it - there is
 * deliberately no room for a paragraph explaining what "About you" means,
 * because a sentence under every heading is what turns a settings page into a
 * wall of text.
 */
export default function ProfileSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-brand-100 bg-white p-5">
      <h2 className="text-base font-semibold text-brand-900">{title}</h2>
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}
