import type { FeedbackResponse } from '@english-lab/contracts';
import { fetchFeedback, fetchSession } from './api';

export type ReviewRow = { f: FeedbackResponse; verdict: string };

export async function loadReviewRows(sessionId: string, active: () => boolean): Promise<ReviewRow[]> {
    const snapshot = await fetchSession(sessionId);
    const rows: Array<ReviewRow | undefined> = new Array(snapshot.slots.length);
    let next = 0;
    const worker = async () => {
        while (active() && next < snapshot.slots.length) {
            const index = next++;
            const slot = snapshot.slots[index]!;
            try {
                rows[index] = { f: await fetchFeedback(sessionId, slot.slotId), verdict: slot.latest?.verdict ?? '' };
            } catch {
                // Preserve the existing handling: unanswered/unskipped tasks have no feedback.
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(4, snapshot.slots.length) }, worker));
    return rows.filter((row): row is ReviewRow => row !== undefined);
}

export function watchBlockReview(sessionId: string, onRows: (rows: ReviewRow[]) => void): () => void {
    let active = true;
    let running = false;
    const load = async () => {
        if (!active || running) return;
        running = true;
        try {
            const rows = await loadReviewRows(sessionId, () => active);
            if (active) onRows(rows);
        } catch {
            // A failed snapshot refresh keeps the last successful review visible.
        } finally {
            running = false;
        }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => {
        active = false;
        window.clearInterval(timer);
    };
}
