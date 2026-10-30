// New York market hours, for the Markets view's "open / closed" line and for
// when the "How markets moved" wrap is due.

/** The weekday, minutes past midnight and date in New York. */
export function newYorkClock(now: Date): { weekday: string; minutes: number; date: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return { weekday: parts.weekday, minutes: Number(parts.hour) * 60 + Number(parts.minute), date: now.toLocaleDateString("en-CA", { timeZone: "America/New_York" }) };
}

/** Whether US stocks are trading: 9:30 to 16:00 New York time on a weekday. Holidays count as open. */
export function marketOpen(now: Date): boolean {
  const { weekday, minutes } = newYorkClock(now);
  if (weekday === "Sat" || weekday === "Sun") return false;
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}
