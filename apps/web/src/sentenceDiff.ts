import { typoMarks } from './typoMarks';

export type DiffMark = 'same' | 'wrong' | 'typo';
export interface DiffWord {
    text: string;
    /** whitespace that follows the word (never highlighted) */
    gap: string;
    mark: DiffMark;
}

const split = (s: string): DiffWord[] => Array.from(s.matchAll(/(\S+)(\s*)/g), (m) => ({ text: m[1]!, gap: m[2]!, mark: 'same' as DiffMark }));
/** words are compared without case and without punctuation around them */
const key = (w: string): string => w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

/** a one-word slip (a wrong, missing or extra letter) rather than a different word */
export function isTypo(typed: string, expected: string): boolean {
    const a = key(typed);
    const b = key(expected);
    return a !== b && a.length > 0 && b.length > 0 && typoMarks(a, b) !== null;
}

/**
 * Word-level comparison of what the learner wrote with the corrected sentence. In both lists a word that matches is 'same' (shown green),
 * a different word is 'wrong' (red) and a one-word slip such as "ir" for "it" is 'typo' (orange).
 */
export function diffSentences(answer: string, corrected: string): { answer: DiffWord[]; corrected: DiffWord[] } {
    const a = split(answer);
    const c = split(corrected);
    const n = a.length;
    const m = c.length;
    const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i]![j] = key(a[i]!.text) === key(c[j]!.text) ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
    let i = 0;
    let j = 0;
    let da: DiffWord[] = [];
    let dc: DiffWord[] = [];
    const flush = () => {
        const paired = da.length === dc.length;
        da.forEach((w, k) => {
            const mark: DiffMark = paired && isTypo(w.text, dc[k]!.text) ? 'typo' : 'wrong';
            w.mark = mark;
            if (paired) dc[k]!.mark = mark;
        });
        for (const w of dc) if (w.mark === 'same') w.mark = 'wrong';
        da = [];
        dc = [];
    };
    while (i < n || j < m) {
        if (i < n && j < m && key(a[i]!.text) === key(c[j]!.text)) {
            flush();
            i++;
            j++;
        } else if (j >= m || (i < n && L[i + 1]![j]! >= L[i]![j + 1]!)) da.push(a[i++]!);
        else dc.push(c[j++]!);
    }
    flush();
    return { answer: a, corrected: c };
}
