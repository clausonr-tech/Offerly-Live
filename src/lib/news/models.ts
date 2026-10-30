// Every model the news job runs on, in one place.
//
// NOT in lib/model-registry, and the reason is the transport rather than tidiness.
// That file resolves a `ModelConfig` - model, effort, thinking, maxTokens, speed -
// for a METERED API feature on a student's plan: it writes a usage row, spends a
// quota unit, and strips parameters the resolved model would reject. The news job
// has none of that. It reaches a model through `runClaude` (./claude-cli), the
// Claude Code CLI in headless mode on the owner's subscription, which takes a
// model string and nothing else: no effort, no thinking, no plan tiers, no quota,
// no metering, and no bill. Forcing these into a Record<AiFeature, ...> would
// invent two plan columns and three parameters that cannot be sent.
//
// So: one place per transport. lib/model-registry owns the API path, this file
// owns the CLI path, and neither pretends to own the other.
//
// These were seven string literals across six files until 13 October 2026, six of
// them identical. The generation moves as one; finding all seven should not be
// part of moving it.

/**
 * The news job's workhorse. Classifying stories, writing summaries, the desk
 * pass, the market wrap, the briefing and the photo check are all the same kind
 * of work: read what was fetched and report it without embellishment.
 *
 * Changing this value changes CLASSIFIER_VERSION, which is a hash over the
 * classifier's system prompt, schema and model - so a model move invalidates
 * every cached classification, deliberately. That is the right behaviour and
 * worth knowing before you move it.
 */
export const NEWS_MODEL = "claude-sonnet-5-5";

/**
 * The verification pass in ./summary, and the only place the news job pays for
 * a more capable model.
 *
 * It is not writing anything: it is checking a summary's claims against the
 * story they came from and refusing the ones that do not hold up. Catching a
 * claim the workhorse just made is exactly the job where the two models should
 * not be the same one.
 */
export const NEWS_VERIFY_MODEL = "claude-opus-5-5";
