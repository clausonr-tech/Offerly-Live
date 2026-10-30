import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// The news job's only way to reach a model: the Claude Code CLI in headless
// mode, signed in to the owner's Claude subscription. Not the API - that was
// the decision for a job that runs on one laptop (29 September 2026), so this
// file is where "never bill the API" is enforced:
//
//   - ANTHROPIC_API_KEY is removed from the child's environment. The CLI
//     prefers an API key over the subscription login when it sees one, and
//     scripts load .env.local, which has one. Leaving it in would silently
//     move every call onto the API bill.
//   - Only the subscription login (keychain, from `claude` /login) or a
//     CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token` can authenticate.
//
// The CLI is also a full coding agent, which this job must not get. Each call
// runs with the system prompt replaced, no tools, no settings files (so no
// CLAUDE.md, hooks or memory from this machine leak into a classifier), no MCP
// servers, no slash commands and no saved session, from an empty directory.

export type CliUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** What the call would cost on the API. Notional on a subscription, still the number to watch. */
  costUsd: number;
};

type CliFailure = "not_installed" | "not_logged_in" | "timeout" | "failed" | "invalid_output";

export type CliResult<T> =
  | { ok: true; data: T; usage: CliUsage; model: string; durationMs: number }
  | { ok: false; failure: CliFailure; error: string; usage: CliUsage; model: string; durationMs: number };

const EMPTY_USAGE: CliUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };

/**
 * Where the CLI lives. NEWS_CLAUDE_BIN wins; otherwise the standard install
 * locations. The Claude desktop app's bundled copy is deliberately not used:
 * it sits under a versioned path that changes with every app update, and it
 * signs in through the app rather than on its own.
 */
function findClaudeBinary(): string | null {
  const candidates = [
    process.env.NEWS_CLAUDE_BIN,
    join(homedir(), ".local/bin/claude"),
    join(homedir(), ".claude/local/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ].filter((p): p is string => Boolean(p));
  for (const p of candidates) if (existsSync(p)) return p;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir && existsSync(join(dir, "claude"))) return join(dir, "claude");
  }
  return null;
}

// What the CLI process inherits: only what it needs to find its own sign-in
// and run - not the app's environment. The job loads .env.local, so passing
// everything would hand the model's process the database URL and service keys
// (security review, 30 September 2026). Never the API key: this runs on the
// subscription. And none of the variables a parent Claude Code session sets,
// or a job started from inside one would talk to that session's host.
const CHILD_ENV_KEYS = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TERM", "LANG", "CLAUDE_CODE_OAUTH_TOKEN", "NEWS_CLAUDE_BIN"];

function childEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (CHILD_ENV_KEYS.includes(key) || key.startsWith("LC_")) env[key] = value;
  }
  return env as NodeJS.ProcessEnv;
}

function workDir(): string {
  const dir = join(tmpdir(), "offerly-news-cli");
  mkdirSync(dir, { recursive: true });
  return dir;
}

type CliJson = {
  result?: string;
  is_error?: boolean;
  structured_output?: unknown;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};

function usageOf(json: CliJson): CliUsage {
  return {
    inputTokens: json.usage?.input_tokens ?? 0,
    outputTokens: json.usage?.output_tokens ?? 0,
    cacheReadTokens: json.usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: json.usage?.cache_creation_input_tokens ?? 0,
    costUsd: json.total_cost_usd ?? 0,
  };
}

/** The structured answer, whichever way this CLI version returns it. */
function structuredOf(json: CliJson): unknown {
  if (json.structured_output !== undefined && json.structured_output !== null) return json.structured_output;
  if (typeof json.result !== "string") return undefined;
  const text = json.result.trim().replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function runClaude<T>(opts: {
  model: string;
  system: string;
  prompt: string;
  schema: object;
  timeoutMs?: number;
  /**
   * A folder of images the model may open with the Read tool - the photo
   * check's only way to see a picture. The CLI runs FROM this folder with Read
   * as its only tool and no blanket permission, so a read outside it would need
   * approval, which -p refuses. (A bare --allowedTools Read, the first version,
   * let the model read any file on the laptop: a headline or image telling it to
   * open .env.local would have worked. Tested 30 September 2026.)
   */
  imageDir?: string;
}): Promise<CliResult<T>> {
  const started = Date.now();
  const fail = (failure: CliFailure, error: string, usage = EMPTY_USAGE): CliResult<T> => ({
    ok: false,
    failure,
    error,
    usage,
    model: opts.model,
    durationMs: Date.now() - started,
  });

  const bin = findClaudeBinary();
  if (!bin) return fail("not_installed", "The claude CLI is not installed (or set NEWS_CLAUDE_BIN).");

  const args = [
    "-p",
    "--model", opts.model,
    "--output-format", "json",
    "--json-schema", JSON.stringify(opts.schema),
    "--system-prompt", opts.system,
    "--tools", opts.imageDir ? "Read" : "",
    "--setting-sources", "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
  ];

  const { code, stdout, stderr, timedOut } = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>(
    (resolve) => {
      const child = spawn(bin, args, { cwd: opts.imageDir ?? workDir(), env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, opts.timeoutMs ?? 240_000);
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: stderr + String(err), timedOut });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut });
      });
      child.stdin.end(opts.prompt);
    },
  );

  if (timedOut) {
    const said = (stderr || stdout).trim().slice(-200);
    return fail("timeout", `no answer within ${(opts.timeoutMs ?? 240_000) / 1000}s${said ? ` (last output: ${said})` : ""}`);
  }

  let json: CliJson;
  try {
    json = JSON.parse(stdout);
  } catch {
    return fail("failed", `exit ${code}: ${(stderr || stdout).trim().slice(0, 300)}`);
  }
  const usage = usageOf(json);
  if (json.is_error) {
    const message = String(json.result ?? "unknown error");
    return /not logged in|\/login|authenticat|oauth/i.test(message)
      ? fail("not_logged_in", "The claude CLI is not signed in. Run `claude` once and /login (or `claude setup-token`).", usage)
      : fail("failed", message.slice(0, 300), usage);
  }
  const data = structuredOf(json);
  if (data === undefined) return fail("invalid_output", `no structured output: ${String(json.result).slice(0, 200)}`, usage);
  return { ok: true, data: data as T, usage, model: opts.model, durationMs: Date.now() - started };
}
