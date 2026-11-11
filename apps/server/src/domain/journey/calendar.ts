// Daily Practice follows Brisbane even if the browser or computer changes timezone.
export const DAILY_TIMEZONE = "Australia/Brisbane";
const DAILY_START_OFFSET_MS = 60 * 60 * 1000;
const formatters = new Map<string, Intl.DateTimeFormat>();
function dateIn(tz: string, at: number): string {
  let f = formatters.get(tz); if (!f) { f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }); if (formatters.size > 16) formatters.clear(); formatters.set(tz, f); }
  return f.format(at);
}
/** The learning day changes at 01:00 Brisbane time. The raw timestamps are never changed. */
export function learningDate(at: number, timezone = DAILY_TIMEZONE): string {
  return dateIn(timezone, at - DAILY_START_OFFSET_MS);
}
/** Split an interval exactly at the learning-day boundary. */
export function allocateDays(start: number, end: number, timezone: string): Array<{ date: string; ms: number }> {
  const result: Array<{ date: string; ms: number }> = [];
  while (start < end) {
    const date = learningDate(start, timezone);
    if (learningDate(end - 1, timezone) === date) { result.push({ date, ms: end - start }); break; }
    let lo = start + 1, hi = end;
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (learningDate(mid, timezone) === date) lo = mid + 1; else hi = mid; }
    result.push({ date, ms: lo - start }); start = lo;
  }
  return result;
}
