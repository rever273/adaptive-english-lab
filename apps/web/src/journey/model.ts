import type * as api from '../api';

export const MODE_INFO: Record<api.JourneyMode, { label: string; icon: string; description: string }> = {
    grammar: { label: 'Grammar', icon: 'pi-pencil', description: 'Build confident sentences' },
    vocabulary: { label: 'Vocabulary', icon: 'pi-bookmark', description: 'Practise words in context' },
    words: { label: 'Typing - Words', icon: 'pi-bolt', description: 'Type and discover words' },
    books: { label: 'Typing - Books', icon: 'pi-book', description: 'Continue your book' },
    dictation: { label: 'Audio Dictation', icon: 'pi-volume-up', description: 'Listen and type' },
    conversation: { label: 'Conversation', icon: 'pi-comments', description: 'Have a short conversation' },
    wordLesson: { label: 'Vocabulary - One Word', icon: 'pi-star', description: 'One word in five steps' },
    grammarCloze: { label: 'Grammar - Cloze', icon: 'pi-th-large', description: 'Fill one gap at a time' },
};
export const MODES: api.JourneyMode[] = ['grammar', 'grammarCloze', 'vocabulary', 'wordLesson', 'words', 'books', 'dictation', 'conversation'];
export const formatTime = (ms: number) => {
    const m = Math.floor(ms / 60000);
    return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m} min`;
};
export function journeyProgress(d: api.JourneyData) {
    const ms = Object.values(d.totals).reduce((a, b) => a + b, 0),
        hours = ms / 3600000;
    const targets: [number, number, number] = [d.journeyHours.b2, d.journeyHours.c1, d.journeyHours.c2];
    const cuts: [number, number, number, number] = [0, targets[0], targets[0] + targets[1], targets[0] + targets[1] + targets[2]];
    const stage = hours < cuts[1]! ? 0 : hours < cuts[2]! ? 1 : 2;
    const stageProgress = Math.max(0, Math.min(1, (hours - cuts[stage]!) / targets[stage]!));
    return { ms, hours, targets, cuts, stage, stageProgress, whole: Math.min(1, hours / cuts[3]!) };
}
/** Milestones are measured from the start of the current stage, including its exact target. */
export function stageMilestones(targetHours: number, completedHours: number) {
    const marks = Array.from({ length: Math.floor(targetHours / 5) }, (_, i) => (i + 1) * 5);
    if (marks.at(-1) !== targetHours) marks.push(targetHours);
    const next = marks.findIndex((hours) => hours > completedHours);
    return marks.map((hours, i) => ({ hours, complete: hours <= completedHours, next: i === next }));
}

/** whole percentages of the parts that always add up to exactly 100 (largest remainder); null when there is nothing yet */
export function percentShares(values: readonly number[]): number[] | null {
    const sum = values.reduce((a, b) => a + b, 0);
    if (sum <= 0) return null;
    const raw = values.map((v) => (v / sum) * 100),
        out = raw.map(Math.floor);
    let left = 100 - out.reduce((a, b) => a + b, 0);
    raw.map((r, i) => ({ i, f: r - Math.floor(r) }))
        .sort((a, b) => b.f - a.f || a.i - b.i)
        .forEach(({ i }) => {
            if (left > 0) {
                out[i]!++;
                left--;
            }
        });
    return out;
}

