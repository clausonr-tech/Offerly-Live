// Artifact 1: the signature block. signatureLines + finishDraft's rebuild.
import { signatureLines, finishDraft, type DraftPromptInput } from "../../../src/lib/draft-prompt";
import { base, row } from "./base";

const S = (p: Partial<DraftPromptInput>) => signatureLines({ ...base, ...p });

row("baseline", "full profile", S({}));
row("no name on profile", 'studentName: ""', S({ studentName: "" }));
row('name is "the student"', 'studentName: "the student"', S({ studentName: "the student" }));
row('name is "The Student" (caps)', 'studentName: "The Student"', S({ studentName: "The Student" }));
row("no school", "studentSchool: null", S({ studentSchool: null }));
row("no grad year", "studentGradYear: null", S({ studentGradYear: null }));
row("grad year in the past", "studentGradYear: 2021", S({ studentGradYear: 2021 }));
row("MBA", 'studentMajor: "MBA, Finance", gradYear 2027', S({ studentMajor: "MBA, Finance", studentGradYear: 2027 }));
row("MS Finance", 'studentMajor: "MS Finance"', S({ studentMajor: "MS Finance", studentGradYear: 2027 }));
row("JD", 'studentMajor: "JD"', S({ studentMajor: "JD", studentGradYear: 2027 }));
row("grad student, no grad year", 'studentMajor: "MBA", gradYear null', S({ studentMajor: "MBA", studentGradYear: null }));
row("phone +1 555 010 1234", "+1 555 010 1234", S({ studentPhone: "+1 555 010 1234" }));
row("phone 555.010.1234", "555.010.1234", S({ studentPhone: "555.010.1234" }));
row("phone 15550101234", "15550101234", S({ studentPhone: "15550101234" }));
row("phone UK +44 20 7123 4567", "+44 20 7123 4567", S({ studentPhone: "+44 20 7123 4567" }));
row("phone with letters", "(208) CALL-NOW", S({ studentPhone: "(208) CALL-NOW" }));
row("phone whitespace only", '"   "', S({ studentPhone: "   " }));
row("phone 7 digits", "0101234", S({ studentPhone: "0101234" }));
row("LinkedIn with tracking params", "https://www.linkedin.com/in/mayapatel?utm_source=share&trk=public_profile", S({ studentLinkedinUrl: "https://www.linkedin.com/in/mayapatel?utm_source=share&trk=public_profile" }));
row("every field null at once", "all null", S({ studentName: "", studentSchool: null, studentSchoolEmail: null, studentPhone: null, studentLinkedinUrl: null, studentGradYear: null, studentMajor: null }));

// finishDraft's rebuild
const body = "Hi Rachel,\n\nI am a sophomore at Penn.\n\nSincerely,\nMaya Patel\nPenn '28\nmade-up@example.com";
const out = { subject: "Quick question", body, connectionUsed: null, gaps: [] };
row("finishDraft rebuild (default)", body, "\n" + finishDraft(base, { ...out }).body);
row("finishDraft gmailSignature: true", body, "\n" + finishDraft({ ...base, gmailSignature: true }, { ...out }).body);
row("gmailSignature + model wrote nothing after closing", "Hi Rachel,\n\nThanks.\n\nBest,", "\n" + finishDraft({ ...base, gmailSignature: true }, { ...out, body: "Hi Rachel,\n\nThanks.\n\nBest," }).body);
row("gmailSignature + all-null profile", "body above", "\n" + finishDraft({ ...base, gmailSignature: true, studentName: "", studentSchool: null, studentSchoolEmail: null, studentPhone: null, studentLinkedinUrl: null, studentGradYear: null }, { ...out }).body);
row("no closing in the model body at all", "Hi Rachel,\n\nI am a sophomore at Penn.", "\n" + finishDraft(base, { ...out, body: "Hi Rachel,\n\nI am a sophomore at Penn." }).body);
row("closing far above the last 8 lines", "Best, + 10 trailing lines", "\n" + finishDraft(base, { ...out, body: "Hi Rachel,\n\nHello.\n\nBest,\nMaya\nl1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9" }).body);
row("two closings", "Thanks,\\nMaya\\n\\nBest,\\nMaya", "\n" + finishDraft(base, { ...out, body: "Hi Rachel,\n\nHello.\n\nThanks,\nMaya\n\nBest,\nMaya" }).body);
row("empty body", '""', "\n" + finishDraft(base, { ...out, body: "" }).body);
