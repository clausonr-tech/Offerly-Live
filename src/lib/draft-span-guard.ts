// The per-span guard: keep the fixes in a reviewer's edit that one flaw
// currently throws away.
//
// WHY THIS EXISTS, AND WHAT IT IS WORTH. The review pass is what makes these
// emails sound like a person wrote them: MEASURED, 12 of 12 unreviewed drafts
// had zero contractions and every reviewed one had three or more.
// `guardRevision` accepts or rejects that edit AS A WHOLE, so one slip - a
// proper noun read off a resume the guard was never shown, a reworded
// shared-school clause - discards every other fix in it and the student is sent
// the raw draft. That is the user's "sometimes good, sometimes not", and it is
// structural, not luck.
//
// The evidence bar was pre-committed before the measurement, not after: PLAN-B
// v2 §2 said ">=2 rejections in 30 drafts", and `guard-full` returned 3 in 30,
// with 12 of 30 hitting a FIRST-TURN rejection that costs a third model call
// (D23). So this is built.
//
// THE GOVERNING INSTRUCTION. "I do not want disjointed sentences. I would
// rather it take longer to load than it be less well written." Prose coherence
// is therefore a hard gate here and latency is the cheaper currency. Every
// judgment call in this file is resolved toward applying FEWER spans: three
// fixes rescued and perfect beats seven with one awkward seam. Where a
// mechanism cannot be sure the seam reads well, it hands the whole edit back
// and the draft ships as written, exactly as today.
//
// THE SAFETY PROPERTY, in one line: the assembled body must itself pass the
// unchanged whole-edit `guardRevision`. Everything today's guard blocks is
// still blocked, by construction - the per-span checks only decide WHICH spans
// are in the body that gets handed to it.
//
// Pure: no API calls, no clock, no I/O. Default OFF; see SPAN_GUARD_DEFAULT.

import { alignBodies, type Alignment, type Op } from "./draft-align";
import { DIAGNOSTIC_CATEGORIES, draftChecks, findingCategory, signOffLine } from "./draft-lint";
import { guardRevision, type ReviewProblem } from "./draft-review";
import type { DraftPromptInput } from "./draft-prompt";

/**
 * Whether the span path runs at all. OFF by default: the whole-edit path is
 * unchanged and this is an A/B arm, not a replacement. `OFFERLY_SPAN_GUARD=1`
 * turns it on for one process without a code change.
 */
export const SPAN_GUARD_DEFAULT = false;
export function spanGuardEnabled(): boolean {
  const env = typeof process !== "undefined" ? process.env?.OFFERLY_SPAN_GUARD : undefined;
  if (env === "1" || env === "true") return true;
  if (env === "0" || env === "false") return false;
  return SPAN_GUARD_DEFAULT;
}

export type SpanVerdict = {
  kind: Op["kind"];
  /** The original sentence this span replaced, clipped - for the log, never for the student. */
  at: string;
  verdict: "accept" | "reject";
  reason?: string;
};

export type SpanReport = { accepted: number; total: number; verdicts: SpanVerdict[] };

export type ReviewEdit =
  | {
      ok: true;
      subject: string;
      body: string;
      /** "all" - the whole edit passed, as it does today. "partial" - some spans were kept. */
      applied: "all" | "partial";
      note?: string;
      spans?: SpanReport;
    }
  | { ok: false; reason: string; spans?: SpanReport };

const PLACEHOLDER = /\[[^\]\n]{2,}\]/g;
const placeholders = (s: string) => (s.match(PLACEHOLDER) ?? []).sort().join("|");

/** The body above the sign-off, and the sign-off block to put back afterwards. */
function splitSignOff(body: string): { above: string; below: string } {
  const lines = body.split("\n");
  const at = signOffLine(lines);
  if (at < 0) return { above: body.trimEnd(), below: "" };
  return { above: lines.slice(0, at).join("\n").trimEnd(), below: lines.slice(at).join("\n") };
}

/**
 * The lint findings computable from one span, by CATEGORY.
 *
 * The span is linted as a one-paragraph body under the real greeting, so the
 * sentence-scoped checks see the shape they expect. Document-scoped findings
 * (congratulations after the ask, a run of "Thank you" openers) are not a
 * span's business and are caught on the assembly by `guardRevision`.
 */
function spanCategories(facts: DraftPromptInput, greeting: string, text: string): Set<string> {
  if (!text.trim()) return new Set();
  return new Set(
    draftChecks(facts, `${greeting}\n\n${text.trim()}\n\nBest,`)
      .forReview.map(findingCategory)
      // DIAGNOSTIC_CATEGORIES is the comma-splice check, measurably wrong four
      // times in five (LOGIC-2 F2). Vetoing a span over it would be worse here
      // than in the whole-edit guard, not better.
      .filter((category) => !DIAGNOSTIC_CATEGORIES.has(category)),
  );
}

/** One emitted sentence of the assembly, and which op put it there. */
type Unit = { text: string; op: number; para: number };

/**
 * Original sentences in order, with the accepted revised text swapped in and
 * the ORIGINAL's paragraph breaks kept. Keeping the original's breaks is what
 * stops a partial application from producing a visibly broken email: a
 * paragraph split the reviewer made is only honoured when every span in it is
 * accepted, which the structure here cannot express, so it is never honoured.
 */
function assemble(alignment: Alignment, accepted: Set<number>): { body: string; units: Unit[]; droppedOrig: Set<number> } {
  const paragraphs: Unit[][] = Array.from({ length: alignment.paragraphs }, () => []);
  const droppedOrig = new Set<number>();
  alignment.ops.forEach((op, index) => {
    // An insert is new content with no original behind it. Never emitted:
    // nothing here can tell a sentence the reviewer was told to work back in
    // from one it made up, and a body that passes whole never reaches this code.
    if (op.kind === "insert") return;
    if (!accepted.has(index)) {
      for (const seg of op.orig) paragraphs[seg.para].push({ text: seg.text, op: index, para: seg.para });
      return;
    }
    if (op.kind === "delete") {
      for (const seg of op.orig) droppedOrig.add(seg.i);
      return;
    }
    const para = op.orig[0].para;
    for (const text of op.rev.map((s) => s.trim()).filter(Boolean)) paragraphs[para].push({ text, op: index, para });
  });
  const kept = paragraphs.filter((p) => p.length > 0);
  const body = [alignment.greeting.original, ...kept.map((p) => p.map((u) => u.text).join(" "))].join("\n\n");
  return { body, units: paragraphs.flat(), droppedOrig };
}

/**
 * Cues that make a sentence depend on the one before it. A sentence opening
 * with one of these whose antecedent has just been dropped, or which has been
 * lifted to the front of a paragraph, is the disjointed prose the governing
 * instruction rules out.
 */
const REFERENTIAL_OPENER =
  /^(?:It|This|That|They|Those|These|He|She|His|Her|Their|Them|Such|Both|Either|Also|However|But|And|So|Then|Second|Secondly|Third|Finally|Which)\b/;
/** Markers that lean on the sentence before them, wherever they sit. */
const LEANS_BACK = /^(?:That said|Which is why|Even so|All the same|In either case|On top of that)\b/i;
/** Discourse markers that promise a counterpart elsewhere in the prose. */
const DISCOURSE_PAIRS: [string, RegExp, RegExp][] = [
  ["First", /\bFirst(?:ly)?\b/, /\bSecond(?:ly)?\b|\bAlso\b|\bThen\b|\bFinally\b|\bNext\b/],
  ["Second", /\bSecond(?:ly)?\b/, /\bFirst(?:ly)?\b/],
  ["Finally", /\bFinally\b/, /\bFirst(?:ly)?\b|\bSecond(?:ly)?\b|\bAlso\b/],
];
const FINITE_VERB =
  /\b(?:am|is|are|was|were|be|been|being|have|has|had|do|does|did|would|will|can|could|should|may|might|must)\b|['’](?:m|s|re|ve|d|ll)\b|\b\w+(?:ed|es|s)\b/i;

/**
 * Would the assembled body read as one piece of prose?
 *
 * A GATE, not a heuristic, and deliberately blunt. It judges the whole partial
 * application rather than one span, because a seam is a property of the join,
 * not of either side - and when it fires the answer is the whole edit, never a
 * cleverer partial. Each arm is one of the four failures the brief named.
 */
function cohesionBreak(alignment: Alignment, accepted: Set<number>, built: { units: Unit[]; droppedOrig: Set<number> }): string | null {
  const origSegs = alignment.ops.flatMap((op) => op.orig);
  const byParagraph = new Map<number, Unit[]>();
  for (const u of built.units) byParagraph.set(u.para, [...(byParagraph.get(u.para) ?? []), u]);

  // (a) A paragraph reduced to a fragment. Only a paragraph THIS edit changed
  // can be judged: the draft's own "Thank you!" paragraph is three words with
  // no finite verb, and reading that as a seam the edit made would block every
  // partial application on every ordinary email. An emptied paragraph is not a
  // break on its own either - a whole paragraph being the private detail the
  // reviewer was told to remove is a legitimate edit - but a paragraph the edit
  // left as a few words with no finite verb is a seam a reader sees.
  const touched = new Set<number>();
  alignment.ops.forEach((op, index) => {
    if (op.kind === "keep" || op.kind === "insert") return;
    if (!accepted.has(index)) return;
    for (const seg of op.orig) touched.add(seg.para);
  });
  for (const [para, units] of byParagraph) {
    if (!touched.has(para)) continue;
    const text = units.map((u) => u.text).join(" ").trim();
    if (!text) continue;
    // Two conditions only, both of which a well-formed sentence cannot meet.
    // An earlier version also asked for a finite verb in anything under nine
    // words, and that was wrong in the costly direction: "I hope to hear from
    // you." has no auxiliary and no inflected verb, so a legitimate rescue of
    // three voice fixes was blocked by a regex's grammar. Ending mid-clause is
    // the sound test for a fragment; the rest of the work is done by arm (b),
    // by the lint's own lowercase-sentence-start finding on the assembly, and
    // by the paragraph breaks coming from the original.
    const words = text.split(/\s+/).filter(Boolean).length;
    if (words < 4) return `a paragraph was reduced to a fragment ("${text}")`;
    if (!/[.!?\]"\u201d]$/.test(text)) return `a paragraph was left ending mid-clause ("${text.slice(-48)}")`;
  }

  // (b) and (c) A kept or rewritten sentence that leans on one that is gone -
  // a pronoun or demonstrative whose antecedent left, or a marker like "Also"
  // or "That said" now opening a paragraph it did not open before.
  for (const units of byParagraph.values()) {
    for (let k = 0; k < units.length; k++) {
      const u = units[k];
      if (!REFERENTIAL_OPENER.test(u.text) && !LEANS_BACK.test(u.text)) continue;
      const op = alignment.ops[u.op];
      const firstOrig = op.orig[0];
      if (!firstOrig) continue;
      // It now opens its paragraph but did not before: whatever it referred to
      // is no longer in front of it.
      if (k === 0 && firstOrig.sent > 0) {
        return `"${u.text.slice(0, 48)}" was left opening a paragraph, with what it refers to gone`;
      }
      // Its antecedent - the original sentence immediately before it - was dropped.
      const previous = origSegs.find((s) => s.i === firstOrig.i - 1);
      if (previous && previous.para === firstOrig.para && built.droppedOrig.has(previous.i)) {
        return `"${u.text.slice(0, 48)}" refers back to a sentence the edit dropped`;
      }
    }
  }

  // (d) A discourse marker whose counterpart left with a dropped sentence.
  const assembled = built.units.map((u) => u.text).join(" ");
  const before = origSegs.map((s) => s.text).join(" ");
  for (const [name, marker, counterpart] of DISCOURSE_PAIRS) {
    if (!marker.test(assembled) || counterpart.test(assembled)) continue;
    if (counterpart.test(before)) return `"${name}" is left without the counterpart it promises`;
  }
  return null;
}

/**
 * Judge a reviewer's edit, keeping what can be kept.
 *
 * FAST PATH FIRST, and it is the point of the design: `guardRevision` runs
 * unchanged on the whole edit, and when it passes, nothing else here runs. So
 * every edit that works today works identically, with no new failure mode, and
 * the span machinery only ever touches edits that today are discarded whole.
 */
export function applyReviewEdit(
  original: { subject: string; body: string },
  revised: { subject: string; body: string },
  facts: DraftPromptInput,
  problems: ReviewProblem[] = [],
  finish: (body: string) => string = (body) => body,
  options: { spans?: boolean } = {},
): ReviewEdit {
  const whole = guardRevision(original, revised, facts, problems, finish);
  if (whole.ok) {
    return { ok: true, subject: whole.subject, body: revised.body, applied: "all", ...(whole.note ? { note: whole.note } : {}) };
  }
  if (!(options.spans ?? spanGuardEnabled())) return { ok: false, reason: whole.reason };

  const before = splitSignOff(finish(original.body));
  const after = splitSignOff(finish(revised.body));
  const alignment = alignBodies(before.above, after.above);
  // A reorder, which a monotone alignment cannot represent: `REVIEW_SYSTEM`
  // explicitly permits reordering, the aligner reads it as a delete plus an
  // insert, and applying half of that duplicates or loses a sentence. Handed
  // back whole rather than guessed at.
  if (alignment.bail) return { ok: false, reason: `${whole.reason}; ${alignment.bail}` };

  // AN EDIT, NOT A REPLACEMENT. When most of the draft is simply gone, what
  // came back is not an edit of it and there is no "fix" in it to rescue.
  // MEASURED while building this: given a reviewer that replaced a five-
  // sentence body with "Thanks.", the span path decomposed the gutting into
  // five deletes, gave back the three the whole-body guard objected to, and
  // returned an email missing only "My resume is attached." and "Thank you!" -
  // a third email neither the drafter nor the reviewer wrote, assembled by a
  // back-off search. It passed `guardRevision`, which is exactly why the
  // whole-body check cannot be the only limit. A body that keeps fewer than
  // half its sentences goes back whole.
  const origSentences = alignment.ops.reduce((n, op) => n + op.orig.length, 0);
  const deletedSentences = alignment.ops.filter((op) => op.kind === "delete").reduce((n, op) => n + op.orig.length, 0);
  if (origSentences > 0 && deletedSentences * 2 > origSentences) {
    return { ok: false, reason: `${whole.reason}; the edit drops ${deletedSentences} of ${origSentences} sentences, which is a replacement and not an edit` };
  }

  const greeting = alignment.greeting.original;
  const verdicts: SpanVerdict[] = [];
  const accepted = new Set<number>();
  const bodyOf = (set: Set<number>) => {
    const built = assemble(alignment, set);
    return { built, body: `${built.body}${before.below ? `\n\n${before.below}` : ""}`.trimEnd() };
  };

  /**
   * The new names and numbers THIS span brings, asked of the whole-edit guard
   * itself by applying this span alone.
   *
   * Deliberately not a second copy of the rule. "Known" involves the school
   * nickname table, the whole-word tokeniser, the long-word substring fallback
   * and the resume-PDF allowance; a reimplementation here would drift out of
   * step with the one the whole-edit path enforces, and the two disagreeing is
   * exactly the silent correctness hazard this guard exists to prevent.
   */
  const fabrications = (index: number): string[] => {
    const { body } = bodyOf(new Set([index]));
    const r = guardRevision(original, { subject: original.subject, body }, facts, problems, finish);
    if (r.ok || !r.reason.startsWith("added ")) return [];
    return (r.reason.match(/"([^"]+)"/g) ?? []).map((q) => q.slice(1, -1));
  };

  alignment.ops.forEach((op, index) => {
    const at = (op.orig[0]?.text ?? op.rev[0] ?? "").slice(0, 48);
    const revText = op.rev.join(" ");
    if (op.kind === "keep") {
      accepted.add(index);
      return;
    }
    if (op.kind === "insert") {
      verdicts.push({ kind: op.kind, at, verdict: "reject", reason: "a pure insertion is new content, not an edit" });
      return;
    }
    // L1 placeholders, per span: a delete that takes a [placeholder] with it
    // fails here rather than on the assembly, so the rest of the edit survives.
    if (placeholders(revText) !== placeholders(op.orig.map((s) => s.text).join(" "))) {
      verdicts.push({ kind: op.kind, at, verdict: "reject", reason: "changed a [placeholder]" });
      return;
    }
    if (op.kind === "delete") {
      // A delete adds nothing, so there is no new name, number or finding to
      // judge. Whether the deletion was ALLOWED - a typed detail, the ask, the
      // shared school, the shrink floor - is a whole-body question, and it is
      // asked on the assembly below.
      accepted.add(index);
      verdicts.push({ kind: op.kind, at, verdict: "accept" });
      return;
    }
    // L2/L3 numbers and proper nouns, via the whole-edit guard's own definition.
    const added = fabrications(index);
    if (added.length > 0) {
      verdicts.push({ kind: op.kind, at, verdict: "reject", reason: `added ${added.map((a) => `"${a}"`).join(", ")}` });
      return;
    }
    // L4 the lint veto: a CATEGORY in the revised span that the original span
    // did not have. Never a count, never a reward for fewer findings, and an
    // empty lint on both sides - the normal case, about 87% of drafts - is
    // never a reason to reject. Voice diagnostics are out of the veto set
    // entirely: a contraction change is the edit the review makes on 12 of 12
    // drafts, and a guard that could veto it would destroy the review's
    // largest measured contribution.
    const had = spanCategories(facts, greeting, op.orig.map((s) => s.text).join(" "));
    const introduced = [...spanCategories(facts, greeting, revText)].filter((c) => !had.has(c));
    if (introduced.length > 0) {
      verdicts.push({ kind: op.kind, at, verdict: "reject", reason: `introduced ${introduced.join("; ")}` });
      return;
    }
    accepted.add(index);
    verdicts.push({ kind: op.kind, at, verdict: "accept" });
  });

  const reject = (index: number, reason: string) => {
    accepted.delete(index);
    const v = verdicts.find((x) => x.kind === alignment.ops[index].kind && x.at === (alignment.ops[index].orig[0]?.text ?? "").slice(0, 48));
    if (v) {
      v.verdict = "reject";
      v.reason = reason;
    }
  };

  // Cohesion propagation, run to a fixpoint. A span whose revised text opens on
  // a referential cue was written to follow the REVISED sentence before it; if
  // that one was reverted, the cue now points at the original wording and the
  // join is a guess. Drop it. This spends good spans to buy coherence, which is
  // the trade the governing instruction asks for.
  for (let pass = 0; pass <= alignment.ops.length; pass++) {
    let changed = false;
    alignment.ops.forEach((op, index) => {
      if (!accepted.has(index) || op.kind === "keep" || op.kind === "delete") return;
      const first = op.rev[0] ?? "";
      if (!REFERENTIAL_OPENER.test(first) && !LEANS_BACK.test(first)) return;
      const prior = alignment.ops[index - 1];
      if (!prior || prior.kind === "keep" || accepted.has(index - 1)) return;
      reject(index, "follows a span that was reverted, and opens on a reference to it");
      changed = true;
    });
    if (!changed) break;
  }

  const total = alignment.ops.filter((op) => op.kind !== "keep").length;
  const changedCount = () => [...accepted].filter((i) => alignment.ops[i].kind !== "keep").length;
  const report = (): SpanReport => ({ accepted: changedCount(), total, verdicts });
  // Largest change first: the biggest rewrite is the likeliest culprit, and the
  // timid answer to an assembly that will not pass is to keep less of it.
  const giveBackOrder = [...accepted]
    .filter((i) => alignment.ops[i].kind !== "keep")
    .sort((a, b) => {
      const size = (i: number) => Math.abs(alignment.ops[i].rev.join(" ").length - alignment.ops[i].orig.map((s) => s.text).join(" ").length);
      return size(b) - size(a);
    });

  // THE SAFETY NET, and the reason every hard constraint still holds: the
  // assembled body has to pass the UNCHANGED whole-edit guard. When it does
  // not, spans are given back until it passes or nothing is left.
  for (let step = 0; step <= giveBackOrder.length; step++) {
    if (changedCount() === 0) break;
    const { built, body } = bodyOf(accepted);
    const seam = cohesionBreak(alignment, accepted, built);
    if (seam) {
      // Not something to back off around: a seam means THIS partial application
      // does not read as prose, and a smaller one is a different guess, not a
      // safer one. The whole edit goes back.
      return { ok: false, reason: `${whole.reason}; a partial application would read as disjointed prose - ${seam}`, spans: { ...report(), accepted: 0 } };
    }
    const check = guardRevision(original, { subject: original.subject, body }, facts, problems, finish);
    if (check.ok) {
      return {
        ok: true,
        subject: check.subject,
        body,
        applied: "partial",
        ...(check.note ? { note: check.note } : {}),
        spans: report(),
      };
    }
    const give = giveBackOrder.find((i) => accepted.has(i));
    if (give === undefined) break;
    reject(give, `given back so the whole body could pass: ${check.reason}`);
  }
  return { ok: false, reason: `${whole.reason}; no span could be kept`, spans: { ...report(), accepted: 0 } };
}
