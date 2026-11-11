import { describe, expect, it } from 'vitest';
import { allocateDays, learningDate } from '../../../apps/server/src/domain/journey/calendar';

// Independent reference: the pre-034.4b implementation formats a Date object.
const formatters = new Map<string, Intl.DateTimeFormat>();
function oldLearningDate(at: number, tz: string): string {
    let formatter = formatters.get(tz);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
        formatters.set(tz, formatter);
    }
    return formatter.format(new Date(at - 60 * 60 * 1000));
}
function oldAllocateDays(start: number, end: number, tz: string): Array<{ date: string; ms: number }> {
    const parts: Array<{ date: string; ms: number }> = [];
    while (start < end) {
        const date = oldLearningDate(start, tz);
        if (oldLearningDate(end - 1, tz) === date) { parts.push({ date, ms: end - start }); break; }
        let lo = start + 1, hi = end;
        while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (oldLearningDate(mid, tz) === date) lo = mid + 1; else hi = mid; }
        parts.push({ date, ms: lo - start }); start = lo;
    }
    return parts;
}

describe('Journey calendar parity with the previous formatter', () => {
    it('preserves dates and interval splits around boundaries, DST, negative and fractional timestamps', () => {
        const zones = ['Australia/Brisbane', 'Australia/Lord_Howe', 'America/New_York', 'Pacific/Apia', 'UTC'];
        const instants = [
            '1969-12-31T23:59:59.999Z', '1992-02-29T15:00:00Z', '2011-12-30T10:00:00Z',
            '2026-03-08T07:00:00Z', '2026-04-04T15:00:00Z', '2026-10-03T15:30:00Z',
            '2026-10-28T15:00:00Z', '2026-11-01T06:00:00Z',
        ].map(value => Date.parse(value));
        for (const zone of zones) for (const at of instants) {
            for (const offset of [-15000, -1, 0, 0.5, 1, 15000]) {
                expect(learningDate(at + offset, zone)).toBe(oldLearningDate(at + offset, zone));
            }
            expect(allocateDays(at - 15000, at + 15000, zone)).toEqual(oldAllocateDays(at - 15000, at + 15000, zone));
        }
    });

    it('matches the old function for a deterministic spread of short intervals', () => {
        const zones = ['Australia/Brisbane', 'Australia/Lord_Howe', 'America/New_York', 'Pacific/Apia', 'UTC'];
        let value = 123456789;
        for (let i = 0; i < 3000; i++) {
            value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
            const start = Date.parse('1970-01-01T00:00:00Z') + value * 500;
            const zone = zones[i % zones.length]!;
            expect(allocateDays(start, start + (value % 15000) + 1, zone)).toEqual(oldAllocateDays(start, start + (value % 15000) + 1, zone));
        }
    });
});
