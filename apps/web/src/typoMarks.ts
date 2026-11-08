/** how many wrong letters still count as a slip worth pointing at, by the length of the right answer */
export function slipLimit(length: number): number {
    return length <= 4 ? 1 : length <= 7 ? 2 : 3;
}

/**
 * Which letters of the typed answer to mark red, when it is a near miss of the right one (1-3 letters, by length; case is ignored).
 * Wrong or extra letters are marked; for a missing letter the letter at the gap is marked (the last one when the gap is at the end).
 * Returns null when the answer is right or too far from it (nothing is marked then).
 */
export function typoMarks(typed: string, expected: string): boolean[] | null {
    const a = Array.from(typed);
    const b = Array.from(expected);
    const x = a.map((c) => c.toLowerCase());
    const y = b.map((c) => c.toLowerCase());
    const n = x.length;
    const m = y.length;
    if (n === 0 || m === 0) return null;
    const d: number[][] = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
    for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    const distance = d[n]![m]!;
    if (distance === 0 || distance > slipLimit(m)) return null;
    const marks = a.map(() => false);
    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && d[i]![j] === d[i - 1]![j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1)) {
            if (x[i - 1] !== y[j - 1]) marks[i - 1] = true;
            i--;
            j--;
        } else if (i > 0 && d[i]![j] === d[i - 1]![j]! + 1) {
            marks[i - 1] = true; // an extra letter
            i--;
        } else {
            marks[Math.min(i, n - 1)] = true; // a missing letter: the letter at the gap
            j--;
        }
    }
    return marks;
}
