// Artifact 7b: holes in the date flagging + the //n rewrite inside a URL.
import { finishDraft } from "../../../src/lib/draft-prompt";
import { base } from "./base";

const run = (label: string, body: string) => {
  const out = finishDraft(base, { subject: "Quick question", body, connectionUsed: null, gaps: [] });
  console.log(`CASE: ${label}`);
  console.log(`  IN : ${JSON.stringify(body)}`);
  console.log(`  OUT body: ${JSON.stringify(out.body.split("\n\nBest,")[0])}`);
  console.log(`  NOTES: ${JSON.stringify(out.notesForStudent)}`);
  console.log("");
};

run("draft invents a NUMERIC date (nothing typed)", "Hi Rachel,\n\nCould we speak 11/20?\n\nBest,\nMaya");
run("draft invents an ISO date", "Hi Rachel,\n\nCould we speak 2026-11-20?\n\nBest,\nMaya");
run("draft invents a weekday", "Hi Rachel,\n\nCould we speak next Tuesday?\n\nBest,\nMaya");
run("invented date AFTER the single sign-off (dropped, so not flagged)", "Hi Rachel,\n\nThanks.\n\nBest,\nMaya\nSee you October 5");
run("invented date in the model's own signature lines", "Hi Rachel,\n\nThanks.\n\nBest,\nMaya Patel\nPenn, October 5 cohort");
run("URL with an uppercase letter after //", "Hi Rachel,\n\nSee https://cal.com//Newslots for times.\n\nBest,\nMaya");
run("protocol-relative URL", "Hi Rachel,\n\nSee //Newslots.cal.com for times.\n\nBest,\nMaya");
