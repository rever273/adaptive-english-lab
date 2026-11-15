/**
 * Pseudo-word generator of Key Builder, taken from keybr.com (https://github.com/aradzie/keybr.com, AGPL-3.0, see
 * content/typing/keybr/LICENSE): packages/keybr-phonetic-model/lib/{transitiontable,phoneticmodel,filter,censor}.ts and
 * keybr-rand/lib/sample.ts, reduced to what English needs. The data file content/typing/keybr/model-en.data is keybr's own
 * English letter-transition table (a Markov chain over letters and space); the blacklist drops offensive pseudo-words.
 */

const SPACE = 0x20;
const MIN_LENGTH = 3;
const MAX_LENGTH = 10;
const SIGNATURE = [0x6b, 0x65, 0x79, 0x62, 0x72, 0x2e, 0x63, 0x6f, 0x6d]; // "keybr.com"

export type Rng = () => number;

interface Entry {
  readonly codePoint: number;
  readonly frequency: number;
}

class Chain {
  readonly size: number;
  readonly segments: number;
  readonly offsets: readonly number[];
  constructor(
    readonly order: number,
    readonly alphabet: readonly number[],
  ) {
    this.size = alphabet.length;
    this.segments = this.size ** (order - 1);
    this.offsets = Array.from({ length: order }, (_, i) => this.size ** (order - i - 1));
  }
  segmentIndex(chain: readonly number[]): number {
    let index = 0;
    for (let i = 0; i < this.order - 1; i++) {
      const codePoint = chain[chain.length - this.order + i + 1] || SPACE;
      index += this.alphabet.indexOf(codePoint) * this.offsets[i + 1]!;
    }
    return index;
  }
}

/** keybr's binary transition table: signature, order, alphabet (uint16 BE), then per segment a list of (letter index, frequency). */
export class TransitionTable {
  static load(buffer: Uint8Array): TransitionTable {
    let at = 0;
    const u8 = (): number => {
      if (at >= buffer.length) throw new Error("model data truncated");
      return buffer[at++]!;
    };
    for (const c of SIGNATURE) if (u8() !== c) throw new Error("not a keybr model file");
    const order = u8();
    const size = u8();
    const alphabet: number[] = [];
    for (let i = 0; i < size; i++) alphabet.push((u8() << 8) | u8());
    const chain = new Chain(order, alphabet);
    const segments: Entry[][] = [];
    for (let s = 0; s < chain.segments; s++) {
      const length = u8();
      if (length > size) throw new Error("bad model data");
      const segment: Entry[] = [];
      for (let e = 0; e < length; e++) {
        const index = u8();
        const frequency = u8();
        if (index >= size || frequency === 0) throw new Error("bad model data");
        segment.push({ codePoint: alphabet[index]!, frequency });
      }
      segments.push(segment);
    }
    if (at !== buffer.length) throw new Error("bad model data");
    return new TransitionTable(chain, segments);
  }

  private constructor(
    readonly chain: Chain,
    readonly segments: readonly (readonly Entry[])[],
  ) {}

  segment(word: readonly number[]): readonly Entry[] {
    return this.segments[this.chain.segmentIndex(word)]!;
  }

  /** letters a–z with their relative frequency in the language (sums to 1), most frequent first */
  letterFrequencies(): Array<{ letter: string; f: number }> {
    const sum = new Map<number, number>();
    for (const segment of this.segments) for (const { codePoint, frequency } of segment) if (codePoint !== SPACE) sum.set(codePoint, (sum.get(codePoint) ?? 0) + frequency);
    const total = [...sum.values()].reduce((a, b) => a + b, 0);
    return [...sum.entries()]
      .map(([cp, n]) => ({ letter: String.fromCodePoint(cp), f: n / total }))
      .sort((a, b) => b.f - a.f || a.letter.localeCompare(b.letter));
  }
}

export function randomSample<T>(list: readonly T[], random: Rng): T {
  if (list.length === 0) throw new Error("empty list");
  return list[(random() * list.length) | 0]!;
}

export function weightedRandomSample<T>(list: readonly T[], weight: (v: T) => number, random: Rng): T {
  if (list.length === 0) throw new Error("empty list");
  let sum = 0;
  for (const v of list) sum += weight(v);
  let r = random() * sum;
  for (const v of list) {
    r -= weight(v);
    if (r <= 0) return v;
  }
  return list[list.length - 1]!;
}

/** the letters a text may use, and the one letter every word should contain */
export interface KeyFilter {
  readonly letters: ReadonlySet<string>;
  readonly focused: string | null;
}

export class PhoneticModel {
  /**
   * prefixes of up to MIN_LENGTH letters the model can start a word with, by every letter they contain (keybr files a prefix
   * only under its last letter; here the focused letter may also stand first or second, so words do not all start the same way)
   */
  private readonly prefixes = new Map<number, number[][]>();

  constructor(
    private readonly table: TransitionTable,
    private readonly blacklist: ReadonlySet<string>,
  ) {
    for (const cp of table.chain.alphabet) this.prefixes.set(cp, []);
    const walk = (word: number[]): void => {
      for (const { codePoint } of table.segment(word)) {
        if (codePoint === SPACE) continue;
        word.push(codePoint);
        const prefix = [...word];
        for (const cp of new Set(word)) this.prefixes.get(cp)!.push(prefix);
        if (word.length < MIN_LENGTH) walk(word);
        word.pop();
      }
    };
    walk([]);
  }

  letterFrequencies(): Array<{ letter: string; f: number }> {
    return this.table.letterFrequencies();
  }

  /** one pseudo-word from the allowed letters, started from a prefix with the focused letter when there is one; never a blacklisted word */
  nextWord(filter: KeyFilter, random: Rng): string {
    for (let i = 0; i < 20; i++) {
      const word = this.generate(filter, random);
      if (word.length > 0 && !this.blacklist.has(word)) return word;
    }
    return "";
  }

  private generate(filter: KeyFilter, random: Rng): string {
    const allowed = (cp: number): boolean => filter.letters.has(String.fromCodePoint(cp));
    const focused = filter.focused?.codePointAt(0) ?? null;
    let prefixes: number[][] = [];
    if (focused != null) {
      prefixes = (this.prefixes.get(focused) ?? []).filter((p) => p.every(allowed));
      if (prefixes.length === 0) prefixes = [[focused]];
    }
    const word: number[] = [];
    let attempt = 0;
    const retry = (): boolean => {
      if (attempt >= 5) return false;
      attempt++;
      word.length = 0;
      if (prefixes.length > 0) word.push(...randomSample(prefixes, random));
      return true;
    };
    retry();
    while (true) {
      const entries = this.table
        .segment(word)
        .filter(({ codePoint }) => (codePoint === SPACE ? word.length >= MIN_LENGTH : allowed(codePoint)))
        // the space is boosted as the word grows, so words stay short
        .map(({ codePoint, frequency }) => ({ codePoint, frequency: codePoint === SPACE ? frequency * 1.3 ** word.length : frequency }));
      if (entries.length === 0) {
        if (retry()) continue;
        return String.fromCodePoint(...word);
      }
      const entry = weightedRandomSample(entries, (e) => e.frequency, random);
      if (entry.codePoint === SPACE) return String.fromCodePoint(...word);
      if (word.length > MAX_LENGTH) {
        if (retry()) continue;
        return String.fromCodePoint(...word);
      }
      word.push(entry.codePoint);
    }
  }
}

/** keybr stores its blacklist scrambled (keybr-phonetic-model/lib/blacklist/scramble.ts) */
export function unscrambleWord(word: string): string {
  const a = [...word];
  return a.map((_, i) => a[(23 * i + 13) % a.length]).join("");
}
