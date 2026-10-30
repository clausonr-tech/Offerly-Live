import "server-only";

// Transactional email lives behind a small driver interface so that changing
// provider is an env change rather than a code change. Every provider worth
// using (Resend, Brevo, SES, Postmark…) is a single authenticated POST, so the
// abstraction stays deliberately thin - no SDK dependency, no template engine.
//
// The practical constraint isn't price - verification codes at student-club
// volume sit inside every provider's free tier - it's that all of them require
// DNS domain verification before they'll deliver to addresses other than your
// own. The `console` driver exists so local development isn't blocked on that.

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
};

type Driver = (message: EmailMessage) => Promise<void>;

const DRIVERS = ["console", "resend"] as const;
export type DriverName = (typeof DRIVERS)[number];

function isProduction() {
  return process.env.NODE_ENV === "production";
}

// Picks the driver from EMAIL_TRANSPORT, falling back to whatever is actually
// configured. The fallback never silently downgrades in production: shipping
// with no mail provider is a bug we want surfaced loudly at send time, not an
// app that quietly stops verifying anyone.
export function resolveDriverName(): DriverName {
  const explicit = process.env.EMAIL_TRANSPORT?.trim().toLowerCase();

  if (explicit) {
    if (!DRIVERS.includes(explicit as DriverName)) {
      throw new Error(
        `Unknown EMAIL_TRANSPORT "${explicit}". Expected one of: ${DRIVERS.join(", ")}.`,
      );
    }
    return explicit as DriverName;
  }

  if (process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL) return "resend";

  if (isProduction()) {
    throw new Error(
      "No email transport configured. Set RESEND_API_KEY and RESEND_FROM_EMAIL " +
        "(or EMAIL_TRANSPORT) before deploying.",
    );
  }

  return "console";
}

// Prints the message instead of sending it. This is the whole local-dev story:
// no account, no API key, no DNS records, no spend.
//
// Hard-refuses to run in production because a verification code in a log file
// is a verification code anyone with log access can use - that would turn the
// entire school-verification feature into theatre.
const consoleDriver: Driver = async (message) => {
  if (isProduction()) {
    throw new Error(
      "The console email driver cannot be used in production - verification " +
        "codes would be written to logs instead of delivered. Configure a real provider.",
    );
  }

  const rule = "─".repeat(64);
  console.log(
    [
      "",
      rule,
      "  DEV EMAIL — not actually sent (EMAIL_TRANSPORT=console)",
      rule,
      `  To:      ${message.to}`,
      `  Subject: ${message.subject}`,
      "",
      ...message.text.split("\n").map((line) => `  ${line}`),
      rule,
      "",
    ].join("\n"),
  );
};

const resendDriver: Driver = async (message) => {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) {
    throw new Error(
      "EMAIL_TRANSPORT=resend requires RESEND_API_KEY and RESEND_FROM_EMAIL in .env.local.",
    );
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    }),
  });

  if (!res.ok) {
    // Logged rather than returned: the caller surfaces thrown messages straight
    // to the student, and a provider error body can carry internal detail.
    const detail = await res.text();
    console.error(`Resend send failed: ${res.status} ${detail}`);
    throw new Error("Couldn't send the verification email. Try again in a moment.");
  }
};

const drivers: Record<DriverName, Driver> = {
  console: consoleDriver,
  resend: resendDriver,
};

// Adding a provider means adding one function above and its name to DRIVERS.
// Brevo, SES and Postmark are all the same shape as `resendDriver` - a POST
// with an API key header and a JSON body.
export async function sendEmail(message: EmailMessage): Promise<void> {
  await drivers[resolveDriverName()](message);
}
