// Linking a name in a headline to a firm in the directory.
//
// A wrong link is worse than none: it puts a story about Apollo Health
// Ventures on Apollo Global Management's page. So the rule is exact matching
// on normalised names, and a name that could mean two firms links to neither.
//
// Two kinds of key:
//   exact   - every firm's own name, legal suffixes removed ("Blackstone Inc." -> "blackstone").
//   short   - for the ~300 firms with a verified student program (the names a
//             headline actually uses), the name without its generic tail
//             ("Apollo Global Management" -> "apollo"). Only added when no
//             firm's exact name already claims that key, so "Citadel" stays
//             Citadel and never becomes Citadel Securities.

const LEGAL_SUFFIX_RE = /\b(inc|incorporated|llc|l l c|lp|l p|llp|ltd|limited|plc|corp|corporation|co|company|sa|ag|nv|se|gmbh|the)\b/g;
const GENERIC_TAIL_RE =
  /\b(global management|capital management|asset management|investment management|management|capital partners|capital|partners|group|holdings|investments|advisors|advisers|financial|and co)$/;

export function normaliseFirmName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’.]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(LEGAL_SUFFIX_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type FirmRow = { id: string; name: string; hasVerifiedProgram: boolean };

export class FirmIndex {
  private exact = new Map<string, Set<string>>();
  private short = new Map<string, Set<string>>();

  constructor(firms: FirmRow[]) {
    const add = (map: Map<string, Set<string>>, key: string, id: string) => {
      if (key.length < 3) return;
      map.set(key, (map.get(key) ?? new Set()).add(id));
    };
    for (const f of firms) add(this.exact, normaliseFirmName(f.name), f.id);
    for (const f of firms) {
      if (!f.hasVerifiedProgram) continue;
      const full = normaliseFirmName(f.name);
      let key = full;
      // Peel generic words one at a time: "kkr capital partners" -> "kkr".
      for (let i = 0; i < 3; i++) {
        const next = key.replace(GENERIC_TAIL_RE, "").trim();
        if (next === key || next.length < 3) break;
        key = next;
      }
      if (key !== full && !this.exact.has(key)) add(this.short, key, f.id);
    }
  }

  /** The firm this name unambiguously means, or null. */
  lookup(name: string): string | null {
    const key = normaliseFirmName(name);
    const exact = this.exact.get(key);
    if (exact) return exact.size === 1 ? [...exact][0] : null;
    const short = this.short.get(key);
    return short && short.size === 1 ? [...short][0] : null;
  }
}
