// The one rule every AI-written line on /news shares: a number it states must be
// a number its sources state. Its own module so the writers can all use it
// without importing each other.

/** Numbers in a bullet must be numbers its stories state. */
export function bulletIsGrounded(text: string, stories: { title: string; summary: string | null }[]): boolean {
  const source = stories.map((s) => `${s.title} ${s.summary ?? ""}`).join(" ").toLowerCase().replace(/,/g, "");
  const numbers = text.match(/\d[\d.,]*/g) ?? [];
  return numbers.every((n) => source.includes(n.replace(/[.,]+$/, "").replace(/,/g, "").toLowerCase()));
}
