// Scratch (OUTPUT-1 audit): print every email in full, with pre/post diff markers.
import { readFileSync } from "node:fs";
const files = process.argv.slice(2);
for (const f of files) {
  const j = JSON.parse(readFileSync(f, "utf8"));
  const recs = j.records ?? j.scenarios ?? j;
  for (const r of Array.isArray(recs) ? recs : []) {
    console.log(`\n######## ${r.id} [${r.profile}] ${(r.boxes||[]).join("+")} · lead=${r.leadType} ceiling=${r.ceiling}`);
    console.log(`SITUATION: ${r.summary}`);
    if (!r.ok) { console.log(`ERROR: ${r.error}`); continue; }
    const rv = r.review || {};
    console.log(`REVIEW: applied=${rv.applied} rejected=${rv.rejected ?? "-"} retried=${rv.retried} problems=${rv.problems} needsStudent=${rv.needsStudent} kinds=${JSON.stringify(rv.kinds)}`);
    console.log(`WORDS pre=${r.pre?.voice?.words} post=${r.post?.voice?.words}/${r.ceiling} · contractions ${r.pre?.voice?.contractions}→${r.post?.voice?.contractions} · canned ${r.pre?.voice?.cannedCount}→${r.post?.voice?.cannedCount} · I-run ${r.pre?.voice?.longestIRun}→${r.post?.voice?.longestIRun}`);
    if (r.post?.issues?.length) console.log(`ISSUES(post): ${r.post.issues.join(" | ")}`);
    if (r.pre?.issues?.length) console.log(`ISSUES(pre): ${r.pre.issues.join(" | ")}`);
    if (r.post?.lintForReview?.length) console.log(`LINT(post): ${r.post.lintForReview.join(" | ")}`);
    if (r.post?.lintForStudent?.length) console.log(`LINT(student): ${r.post.lintForStudent.join(" | ")}`);
    console.log(`NOTES: ${JSON.stringify(r.notesForStudent)}`);
    const changed = (r.preReviewBody ?? "") !== (r.body ?? "") || r.preReviewSubject !== r.subject;
    console.log(`--- PRE  Subject: ${r.preReviewSubject}`);
    console.log((r.preReviewBody ?? "").split("\n").map(l=>`P| ${l}`).join("\n"));
    if (changed) {
      console.log(`--- POST Subject: ${r.subject}`);
      console.log((r.body ?? "").split("\n").map(l=>`F| ${l}`).join("\n"));
    } else console.log("--- POST identical to PRE");
  }
}
