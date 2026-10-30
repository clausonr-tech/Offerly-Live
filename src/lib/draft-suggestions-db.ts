import "server-only";
import { and, eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { contacts, directoryPeople, draftSuggestions, users } from "@/db/schema";
import { runAiFeature } from "@/lib/ai-runner";
import {
  findConnections,
  mergeSuggestions,
  ruleSuggestions,
  suggestionInputHash,
  suggestionOutcomes,
  type Connection,
  type SuggestionOutcome,
  type SuggestionRecipient,
  type SuggestionSet,
  type SuggestionStudent,
} from "@/lib/draft-suggestions";
import { SUGGESTION_SYSTEM, parseSuggestions, suggestionPrompt } from "@/lib/draft-suggestions-ai";
import { isUuid } from "@/lib/firm-links";
import { outputConfigFor } from "@/lib/model-registry";

// The queries behind the drafter's suggestions. The rules are in
// draft-suggestions.ts, the prompt in draft-suggestions-ai.ts.

export type DraftSuggestions = {
  fields: SuggestionSet;
  connections: Connection[];
  /** Whether the model's half is in this set (cached or fresh). */
  withAi: boolean;
};

async function loadStudent(userId: string): Promise<SuggestionStudent | null> {
  const db = await getDb();
  const u = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: {
      name: true,
      school: true,
      gradYear: true,
      major: true,
      hometown: true,
      clubsAndActivities: true,
      interests: true,
      priorExperience: true,
      targetLocations: true,
      preferredCategories: true,
      targetGroup: true,
      motivations: true,
      proudExperience: true,
    },
  });
  return u ?? null;
}

/**
 * The person behind a drafter recipient key - one of the student's own
 * contacts ("contact-<id>", only their own) or a directory person
 * ("directory-<id>"). Null for anything else, including "outside".
 */
export async function loadRecipient(userId: string, recipientKey: string): Promise<SuggestionRecipient | null> {
  const db = await getDb();
  const [kind, ...rest] = recipientKey.split("-");
  const id = rest.join("-");
  if (!isUuid(id)) return null;

  if (kind === "contact") {
    const c = await db.query.contacts.findFirst({
      where: and(eq(contacts.id, id), eq(contacts.userId, userId)),
      columns: {
        name: true,
        firm: true,
        role: true,
        school: true,
        gradYear: true,
        currentCity: true,
        background: true,
        notes: true,
        connectionAngle: true,
      },
    });
    if (!c) return null;
    return {
      name: c.name,
      firm: c.firm,
      role: c.role,
      school: c.school,
      gradYear: c.gradYear,
      currentCity: c.currentCity,
      background: c.background,
      notes: c.notes,
    };
  }
  if (kind === "directory") {
    const p = await db.query.directoryPeople.findFirst({
      where: eq(directoryPeople.id, id),
      columns: { name: true, firmName: true, title: true, school: true, gradYear: true, jobHistory: true, delistedAt: true },
    });
    if (!p || p.delistedAt) return null;
    return {
      name: p.name,
      firm: p.firmName,
      role: p.title,
      school: p.school,
      gradYear: p.gradYear,
      background: p.jobHistory,
    };
  }
  return null;
}

/**
 * Suggestions for one student writing to one person.
 *
 * The rules always run - they are free and instant. The model's half comes
 * from the cache while both sides' facts are unchanged; with `withAi` and no
 * fresh cached set, it is written now (one call) and cached. A failed or
 * refused call, or a student over their daily limit, falls back to the rules
 * alone rather than failing the form.
 */
export async function getDraftSuggestions(
  userId: string,
  recipientKey: string,
  opts: { withAi: boolean },
): Promise<DraftSuggestions | null> {
  const [student, recipient] = await Promise.all([loadStudent(userId), loadRecipient(userId, recipientKey)]);
  if (!student || !recipient) return null;

  const connections = findConnections(student, recipient);
  const rules = ruleSuggestions(student, recipient, connections);
  const hash = suggestionInputHash(student, recipient);

  const db = await getDb();
  const cached = await db.query.draftSuggestions.findFirst({
    where: and(eq(draftSuggestions.userId, userId), eq(draftSuggestions.recipientKey, recipientKey)),
  });
  if (cached && cached.inputHash === hash && cached.model) {
    return { fields: mergeSuggestions(rules, cached.fields as SuggestionSet), connections, withAi: true };
  }
  if (!opts.withAi) return { fields: rules, connections, withAi: false };

  let ai: SuggestionSet = {};
  let model: string | null = null;
  try {
    const response = await runAiFeature({ feature: "draftSuggestions", userId }, (client, cfg) => {
      model = cfg.model;
      return client.messages.create({
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        output_config: outputConfigFor(cfg),
        system: SUGGESTION_SYSTEM,
        messages: [{ role: "user", content: suggestionPrompt(student, recipient, connections) }],
      });
    });
    if (response.stop_reason !== "refusal") {
      const text = response.content.find((b) => b.type === "text");
      if (text && text.type === "text") ai = parseSuggestions(text.text, connections);
    }
  } catch (err) {
    console.error("[draft-suggestions] model call failed; showing the rules alone", err);
    return { fields: rules, connections, withAi: false };
  }

  await db
    .insert(draftSuggestions)
    .values({ userId, recipientKey, inputHash: hash, connections, fields: ai, model })
    .onConflictDoUpdate({
      target: [draftSuggestions.userId, draftSuggestions.recipientKey],
      set: { inputHash: hash, connections, fields: ai, model, createdAt: new Date() },
    });

  return { fields: mergeSuggestions(rules, ai), connections, withAi: true };
}

/**
 * What the student did with the suggestions they were shown for this email -
 * the record kept on the draft. Rebuilt from the same rules and cache the form
 * showed, never from anything the browser sends except which ones were taken.
 * No model call: a set the form never received the model's half of is judged
 * on the rules alone.
 */
export async function suggestionRecord(
  userId: string,
  recipientKey: string,
  submitted: Record<string, string>,
  taken: ReadonlySet<string>,
): Promise<SuggestionOutcome[] | null> {
  const shown = await getDraftSuggestions(userId, recipientKey, { withAi: false });
  if (!shown) return null;
  const outcomes = suggestionOutcomes(shown.fields, submitted, taken);
  return outcomes.length ? outcomes : null;
}
