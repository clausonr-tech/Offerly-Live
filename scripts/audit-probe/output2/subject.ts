// Artifact 2: the subject line, via finishDraft.
import { finishDraft, type DraftPromptInput, type DraftBrief } from "../../../src/lib/draft-prompt";
import { base, row } from "./base";

const subj = (p: Partial<DraftPromptInput>, modelSubject: string) =>
  finishDraft({ ...base, ...p }, { subject: modelSubject, body: "Hi Rachel,\n\nHello.\n\nBest,\nMaya", connectionUsed: null, gaps: [] }).subject;

const reply = (brief: DraftBrief, modelSubject = "Following up") =>
  subj({ type: "follow_up_1", brief }, modelSubject);     // repliesInThread: true -> originalSubject
const nonReply = (brief: DraftBrief, modelSubject = "Following up") =>
  subj({ type: "cold_email", brief }, modelSubject);       // not a thread reply -> threadSubject

row("reply, thread subject plain", 'follow_up_1 originalSubject "Coffee chat"', reply({ originalSubject: "Coffee chat" }));
row("reply, thread subject 'Re: Coffee chat'", "originalSubject: 'Re: Coffee chat'", reply({ originalSubject: "Re: Coffee chat" }));
row("reply, thread subject 'RE: Coffee chat'", "originalSubject: 'RE: Coffee chat'", reply({ originalSubject: "RE: Coffee chat" }));
row("reply, thread subject 'Fwd: Re: Coffee chat'", "originalSubject: 'Fwd: Re: Coffee chat'", reply({ originalSubject: "Fwd: Re: Coffee chat" }));
row("reply, thread subject 'RE:RE: Coffee'", "originalSubject: 'RE:RE: Coffee'", reply({ originalSubject: "RE:RE: Coffee" }));
row("reply, thread subject 'Re - Coffee'", "originalSubject: 'Re - Coffee'", reply({ originalSubject: "Re - Coffee" }));
row("reply, thread subject empty string", 'originalSubject: ""', reply({ originalSubject: "" }));
row("reply, thread subject whitespace", 'originalSubject: "   "', reply({ originalSubject: "   " }));
row("reply, thread subject is only 'Re:'", 'originalSubject: "Re:"', reply({ originalSubject: "Re:" }));
row("reply type, but brief has threadSubject not originalSubject", 'follow_up_1, threadSubject: "Coffee chat"', reply({ threadSubject: "Coffee chat" }));
row("non-reply type with a threadSubject typed", 'cold_email, threadSubject: "Coffee chat"', nonReply({ threadSubject: "Coffee chat" }));
row("non-reply, model returns a 'Re:' subject", "cold_email, model: 'Re: Quick question'", nonReply({}, "Re: Quick question"));
row("non-reply, model returns 'Fwd: Re: x'", "model: 'Fwd: Re: Quick question'", nonReply({}, "Fwd: Re: Quick question"));
row("model subject with an em dash", "model: 'Penn student — quick question'", nonReply({}, "Penn student — quick question"));
row("model subject with en dash", "model: 'Penn student – quick question'", nonReply({}, "Penn student – quick question"));
row("model subject with double em dash", "model: 'Penn—–student'", nonReply({}, "Penn—–student"));
row("model subject with digit range em dash", "model: 'Summer 2023—2025 recruiting'", nonReply({}, "Summer 2023—2025 recruiting"));
row("empty model subject (fallback)", 'model: ""', nonReply({}, ""));
row("empty model subject + no school", 'model: "", studentSchool null', subj({ type: "cold_email", studentSchool: null }, ""));
row("whitespace-only model subject", 'model: "   "', nonReply({}, "   "));
row("model subject that is only 'Re:'", 'model: "Re:"', nonReply({}, "Re:"));
row("model subject that is only an em dash", 'model: "—"', nonReply({}, "—"));
row("very long model subject", "model: 240-char subject", nonReply({}, "A quick note from a Penn sophomore interested in your investment banking coverage group and hoping to learn about your path from the analyst programme through to the vice president seat you now hold at the firm, with thanks"));
row("very long thread subject", "originalSubject: 240 chars", reply({ originalSubject: "A quick note from a Penn sophomore interested in your investment banking coverage group and hoping to learn about your path from the analyst programme through to the vice president seat you now hold at the firm, with thanks" }));
row("thread subject with an em dash", "originalSubject: 'Coffee — Thursday'", reply({ originalSubject: "Coffee — Thursday" }));
row("thread subject with trailing/leading space", "originalSubject: '  Coffee chat  '", reply({ originalSubject: "  Coffee chat  " }));
row("thread subject containing newline", "originalSubject: 'Coffee\\nchat'", reply({ originalSubject: "Coffee\nchat" }));
