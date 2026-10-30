import "server-only";

/**
 * Where a careers page is, in the order worth trying.
 *
 * Deliberately short. Each entry is a request against a firm that has never
 * asked us to visit, so the list is the handful of conventions that actually
 * recur, not every path a site could use. The root is NOT here: a homepage is
 * not a board, and enrolling against one is the failure this script's header
 * describes.
 */
const CAREERS_PATHS = [
  "/careers",
  "/careers/students",
  "/about/careers",
  "/join-us",
  "/company/careers",
] as const;

/**
 * Every address worth trying for one firm, cheapest and likeliest first.
 *
 * WHY SUBDOMAINS. Coverage is the crawler's largest gap - 22,554 firms in the
 * directory, 4,995 watched, and 85 with a live posting - and 319 of the 351
 * sources that have never answered are bare apex URLs, which is what enrolment
 * produces when it cannot find a board. A great many real boards are not on a
 * path at all: Kroll's is `careers.kroll.com`. Probing only the firm's own
 * paths cannot see any of them.
 *
 * THE ROOT IS A BOARD ON A SUBDOMAIN, AND NOT ON THE APEX. `https://firm.com/`
 * is a homepage and enrolling it is this script's named failure;
 * `https://careers.firm.com/` is the board itself, so the root is exactly the
 * right path there. That asymmetry is why the apex paths and the subdomain
 * roots are built separately rather than crossed.
 *
 * WHAT IS DELIBERATELY NOT HERE: an ATS host with a guessed slug -
 * `boards.greenhouse.io/<name>`, `jobs.lever.co/<name>`. Those are not the
 * firm's domain, so a wrong guess enrols SOMEBODY ELSE'S board under this
 * firm's name - which is precisely the failure retracted on 12 October 2026,
 * when 64 postings were published under four venture firms' names because a
 * Getro portfolio board was read as the firm's own, 55 of them Munich Re's.
 * Everything in this list is a host the firm demonstrably controls, so
 * attribution is correct by construction rather than by luck. A slug-based
 * candidate needs evidence tying the slug to the firm, which is its own piece
 * of work.
 *
 * Getro is excluded for the same reason, and `isPortfolioBoard` now refuses to
 * publish from one anyway.
 */
export function careersCandidates(website: string): string[] {
  let url: URL;
  try {
    url = new URL(website.startsWith("http") ? website : `https://${website}`);
  } catch {
    return [];
  }

  const host = url.hostname.replace(/^www\./i, "");
  const out = CAREERS_PATHS.map((p) => `${url.origin}${p}`);

  // The firm's own subdomains, where a board sits at the root.
  for (const sub of ["careers", "jobs"]) {
    if (host.startsWith(`${sub}.`)) continue;
    out.push(`https://${sub}.${host}/`);
  }
  return out;
}
