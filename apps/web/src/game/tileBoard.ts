/**
 * Letter-tile board for vocabulary recall. Pure state transitions, so every order of placing, removing and hinting is testable.
 *
 * `placed[slot]` = index of the tile in that slot, or null. `locks[slot]` = the slot was opened by a hint (it holds the correct
 * letter and can no longer be changed). A tile index is never in two slots.
 */
export interface TileBoard {
    placed: Array<number | null>;
    locks: boolean[];
}

export const emptyBoard = (slots: number): TileBoard => ({ placed: Array<number | null>(slots).fill(null), locks: Array<boolean>(slots).fill(false) });

export const filledCount = (b: TileBoard): number => b.placed.filter((x) => x !== null).length;
export const lockedCount = (b: TileBoard): number => b.locks.filter(Boolean).length;

/** a tile goes into the first slot that is empty and not locked; nothing happens if the tile is already placed or no slot is free */
export function placeTile(b: TileBoard, tile: number): TileBoard {
    if (b.placed.includes(tile)) return b;
    const slot = b.placed.findIndex((x, i) => x === null && !b.locks[i]);
    return slot < 0 ? b : { ...b, placed: b.placed.map((x, i) => (i === slot ? tile : x)) };
}

/** takes the letter out of a slot; a hinted slot never opens */
export function removeAt(b: TileBoard, slot: number): TileBoard {
    return b.locks[slot] || b.placed[slot] === null ? b : { ...b, placed: b.placed.map((x, i) => (i === slot ? null : x)) };
}

/** Backspace: the last letter the learner placed (hinted letters stay) */
export function removeLast(b: TileBoard): TileBoard {
    let at = -1;
    b.placed.forEach((x, i) => {
        if (x !== null && !b.locks[i]) at = i;
    });
    return at < 0 ? b : removeAt(b, at);
}

/** Clear: everything the learner placed; hinted letters stay */
export function clearPlaced(b: TileBoard): TileBoard {
    return { ...b, placed: b.placed.map((x, i) => (b.locks[i] ? x : null)) };
}

/** The slot a hint opens: the first one not opened yet, wherever the learner has put letters (an empty or wrong slot is replaced) */
export function hintSlot(b: TileBoard): number {
    return b.locks.findIndex((l) => !l);
}

/**
 * The hint's correct `letter` goes into `slot` and the slot is locked. A letter the learner had there is given back to the pool.
 * The tile used is, in order: the one already in the slot (when it is right), a tile of that letter that is not placed, or one
 * placed in another unlocked slot (it moves here). Hinted slots are never touched.
 */
export function applyHint(b: TileBoard, slot: number, letter: string, tiles: readonly string[]): TileBoard {
    if (slot < 0 || slot >= b.placed.length || b.locks[slot]) return b;
    const want = letter.toLowerCase();
    const isLocked = (tile: number) => b.placed.some((x, s) => x === tile && b.locks[s]);
    const current = b.placed[slot];
    let tile: number | null = null;
    if (current !== null && current !== undefined && tiles[current]?.toLowerCase() === want) tile = current;
    else {
        const candidates = tiles.map((t, i) => i).filter((i) => tiles[i]!.toLowerCase() === want && !isLocked(i));
        tile = candidates.find((i) => !b.placed.includes(i)) ?? candidates[0] ?? null;
    }
    if (tile === null) return b; // the tile set has no such letter: nothing to open
    return {
        placed: b.placed.map((x, s) => (s === slot ? tile : x === tile ? null : x)),
        locks: b.locks.map((l, s) => l || s === slot),
    };
}

/** switching from typing to tiles: every letter already opened is placed in its own slot and locked */
export function boardFromOpened(slots: number, tiles: readonly string[], opened: (slot: number) => string | null | undefined): TileBoard {
    let b = emptyBoard(slots);
    for (let slot = 0; slot < slots; slot++) {
        const shown = opened(slot);
        if (shown) b = applyHint(b, slot, shown, tiles);
    }
    return b;
}

/** the letters of each word, in order; words with no letter placed are left out */
export function builtWords(b: TileBoard, tiles: readonly string[], pattern: readonly number[]): string {
    let at = 0;
    const words = pattern.map((n) => {
        const word = b.placed
            .slice(at, at + n)
            .map((i) => (i === null ? '' : tiles[i]))
            .join('');
        at += n;
        return word;
    });
    return words.filter(Boolean).join(' ');
}
