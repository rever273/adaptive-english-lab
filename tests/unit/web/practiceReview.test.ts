import type { FeedbackResponse, SessionSnapshot } from '@english-lab/contracts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../../apps/web/src/api', () => ({ fetchSession: vi.fn(), fetchFeedback: vi.fn() }));
import { fetchFeedback, fetchSession } from '../../../apps/web/src/api';
import { loadReviewRows, watchBlockReview } from '../../../apps/web/src/practiceReview';

const session = (count: number) => ({ slots: Array.from({ length: count }, (_, i) => ({ slotId: String(i), latest: { verdict: 'pending' } })) }) as SessionSnapshot;
const feedback = (slotId: string, state = 'pending') => ({ slotId, state, verdict: state === 'pending' ? 'pending' : null, confirmation: null, correct: null }) as FeedbackResponse;
const cleanup: Array<() => void> = [];
beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
    vi.mocked(fetchSession).mockReset();
    vi.mocked(fetchFeedback).mockReset();
});
afterEach(() => {
    cleanup.splice(0).forEach(stop => stop());
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

it('limits reads to four, keeps snapshot order despite completion order, and omits unavailable feedback', async () => {
    vi.mocked(fetchSession).mockResolvedValue(session(10));
    let active = 0, peak = 0;
    vi.mocked(fetchFeedback).mockImplementation(async (_sid, slotId) => {
        peak = Math.max(peak, ++active);
        await new Promise(resolve => setTimeout(resolve, slotId === '0' ? 100 : 10));
        --active;
        if (slotId === '2') throw new Error('unavailable');
        return feedback(slotId);
    });
    const result = loadReviewRows('s', () => true);
    await vi.advanceTimersByTimeAsync(100);
    expect((await result).map(row => row.f.slotId)).toEqual(['0', '1', '3', '4', '5', '6', '7', '8', '9']);
    expect(peak).toBe(4);
    expect(fetchFeedback).toHaveBeenCalledTimes(10);
    expect(vi.mocked(fetchFeedback).mock.calls.every(([sid]) => sid === 's')).toBe(true);
});

it('retains server-closed diagnostic/heldout feedback without inventing answers', async () => {
    vi.mocked(fetchSession).mockResolvedValue(session(1));
    const closed = feedback('0', 'closed');
    vi.mocked(fetchFeedback).mockResolvedValue(closed);
    expect(await loadReviewRows('diagnostic', () => true)).toEqual([{ f: closed, verdict: 'pending' }]);
    expect(closed.correct).toBeNull();
});

it('does not start feedback reads if disposed while the snapshot was loading', async () => {
    let resolve!: (snapshot: SessionSnapshot) => void;
    vi.mocked(fetchSession).mockReturnValue(new Promise(r => { resolve = r; }));
    const publish = vi.fn();
    const stop = watchBlockReview('s', publish);
    stop(); resolve(session(10));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFeedback).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
});

it('avoids overlapping refreshes and stops scheduling queued slots after disposal', async () => {
    vi.mocked(fetchSession).mockResolvedValue(session(10));
    const pending: Array<() => void> = [];
    vi.mocked(fetchFeedback).mockImplementation((_sid, slotId) => new Promise(resolve => pending.push(() => resolve(feedback(slotId)))));
    const publish = vi.fn(), stop = watchBlockReview('s', publish);
    cleanup.push(stop);
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetchSession).toHaveBeenCalledTimes(1);
    expect(fetchFeedback).toHaveBeenCalledTimes(4);
    stop(); pending.forEach(resolve => resolve());
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFeedback).toHaveBeenCalledTimes(4);
    expect(publish).not.toHaveBeenCalled();
});

it('retries snapshot failures and publishes pending-to-resolved changes at the original 5s interval', async () => {
    vi.mocked(fetchSession).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(session(1));
    vi.mocked(fetchFeedback).mockResolvedValueOnce(feedback('0')).mockResolvedValueOnce(feedback('0', 'confirmed'));
    const publish = vi.fn();
    cleanup.push(watchBlockReview('s', publish));
    await vi.advanceTimersByTimeAsync(4999);
    expect(publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]![0][0].f.state).toBe('pending');
    await vi.advanceTimersByTimeAsync(5000);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1]![0][0].f.state).toBe('confirmed');
});

it('cannot publish an old session result into a newly opened review', async () => {
    vi.mocked(fetchSession).mockResolvedValue(session(1));
    let old!: (f: FeedbackResponse) => void;
    vi.mocked(fetchFeedback).mockImplementation(sid => sid === 'old' ? new Promise(resolve => { old = resolve; }) : Promise.resolve(feedback('new')));
    const oldPublish = vi.fn(), currentPublish = vi.fn();
    const stop = watchBlockReview('old', oldPublish);
    await vi.advanceTimersByTimeAsync(0);
    stop(); cleanup.push(watchBlockReview('new', currentPublish));
    await vi.advanceTimersByTimeAsync(0);
    old(feedback('old'));
    await vi.advanceTimersByTimeAsync(0);
    expect(oldPublish).not.toHaveBeenCalled();
    expect(currentPublish).toHaveBeenCalledExactlyOnceWith([{ f: feedback('new'), verdict: 'pending' }]);
});
