import SectionTopBar from "../SectionTopBar";

/** A conversation belongs to Internal Network - its bar stays across the top. */
export default function MessagesLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <SectionTopBar sectionHref="/networking" hubLabel="Feed" />
      {children}
    </div>
  );
}
