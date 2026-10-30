// Next.js remounts template.tsx (unlike layout.tsx) on every navigation, so
// this is what gives each page its entrance reveal without touching every
// page file individually - the animation itself lives in globals.css scoped
// under [data-app-theme="terminal"].
export default function AppTemplate({ children }: { children: React.ReactNode }) {
  return <div className="app-reveal">{children}</div>;
}
