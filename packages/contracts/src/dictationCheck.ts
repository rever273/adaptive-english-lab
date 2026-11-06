// dictation-check-v1: shared by the server (the verdict) and the page (marking wrong words while typing). Pure functions, no I/O.
/**
 * Australian/British and American spellings sound the same, so the dictation check treats these explicit pairs as equal. Only pairs
 * that are listed (with their s / ed / ing forms where they exist) count: there are no general suffix rules. Versioned with
 * DICTATION_CHECK_VERSION.
 */
const PAIRS: ReadonlyArray<readonly [uk: string, us: string]> = [
  ["colour", "color"], ["colours", "colors"], ["coloured", "colored"], ["colouring", "coloring"],
  ["favourite", "favorite"], ["favourites", "favorites"],
  ["centre", "center"], ["centres", "centers"], ["centred", "centered"], ["centring", "centering"],
  ["theatre", "theater"], ["theatres", "theaters"],
  ["grey", "gray"], ["greys", "grays"], ["greyer", "grayer"], ["greying", "graying"],
  ["neighbour", "neighbor"], ["neighbours", "neighbors"], ["neighbourhood", "neighborhood"], ["neighbourhoods", "neighborhoods"],
  ["behaviour", "behavior"], ["behaviours", "behaviors"],
  ["flavour", "flavor"], ["flavours", "flavors"], ["flavoured", "flavored"],
  ["honour", "honor"], ["honours", "honors"], ["honoured", "honored"], ["honouring", "honoring"],
  ["labour", "labor"], ["labours", "labors"], ["laboured", "labored"], ["labouring", "laboring"],
  ["humour", "humor"], ["humours", "humors"],
  ["organise", "organize"], ["organises", "organizes"], ["organised", "organized"], ["organising", "organizing"], ["organisation", "organization"], ["organisations", "organizations"],
  ["realise", "realize"], ["realises", "realizes"], ["realised", "realized"], ["realising", "realizing"],
  ["recognise", "recognize"], ["recognises", "recognizes"], ["recognised", "recognized"], ["recognising", "recognizing"],
  ["apologise", "apologize"], ["apologises", "apologizes"], ["apologised", "apologized"], ["apologising", "apologizing"],
  ["analyse", "analyze"], ["analyses", "analyzes"], ["analysed", "analyzed"], ["analysing", "analyzing"],
  ["travelling", "traveling"], ["travelled", "traveled"], ["traveller", "traveler"], ["travellers", "travelers"],
  ["cancelled", "canceled"], ["cancelling", "canceling"],
  ["defence", "defense"], ["defences", "defenses"],
  ["licence", "license"], ["licences", "licenses"],
  ["programme", "program"], ["programmes", "programs"],
  ["catalogue", "catalog"], ["catalogues", "catalogs"],
  ["tyre", "tire"], ["tyres", "tires"],
  ["mum", "mom"], ["mums", "moms"],
];

const TO_US = new Map<string, string>(PAIRS.map(([uk, us]) => [uk, us]));

/** the American form of a word when it is a listed regional variant, otherwise the word itself */
export const regionalCanonical = (word: string): string => TO_US.get(word) ?? word;

/**
 * dictation-check-v1: one normalisation for the expected text and the typed one. NFKC, lower case, no diacritics; apostrophes are
 * deleted ("it's" -> "its"); hyphens and every dash become spaces ("well-known" = "well known"); other punctuation becomes a space.
 */
export function rawTokens(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/['’‘]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 0);
}

/**
 * A spoken contraction and its long form are the same thing: "I'm" = "I am", "don't" = "do not", "we're" = "we are", "it's" = "it is" / "it has".
 * Apostrophes are deleted first ("im"), so two adjacent words that form such a pair are merged into the contraction without its apostrophe.
 * (Like before, "its" = "it's" and "were" = "we're" stay equal.)
 */
const CONTRACTED: ReadonlyMap<string, string> = new Map(
  [
    ["i am", "im"], ["you are", "youre"], ["we are", "were"], ["they are", "theyre"],
    ["he is", "hes"], ["she is", "shes"], ["it is", "its"], ["he has", "hes"], ["she has", "shes"], ["it has", "its"],
    ["that is", "thats"], ["there is", "theres"], ["here is", "heres"], ["what is", "whats"], ["who is", "whos"], ["where is", "wheres"], ["how is", "hows"], ["that has", "thats"],
    ["let us", "lets"],
    ["i have", "ive"], ["you have", "youve"], ["we have", "weve"], ["they have", "theyve"],
    ["i will", "ill"], ["you will", "youll"], ["he will", "hell"], ["she will", "shell"], ["it will", "itll"], ["we will", "well"], ["they will", "theyll"],
    ["i would", "id"], ["you would", "youd"], ["he would", "hed"], ["she would", "shed"], ["we would", "wed"], ["they would", "theyd"],
    ["i had", "id"], ["you had", "youd"], ["he had", "hed"], ["she had", "shed"], ["we had", "wed"], ["they had", "theyd"],
    ["do not", "dont"], ["does not", "doesnt"], ["did not", "didnt"], ["is not", "isnt"], ["are not", "arent"], ["was not", "wasnt"], ["were not", "werent"],
    ["have not", "havent"], ["has not", "hasnt"], ["had not", "hadnt"], ["will not", "wont"], ["would not", "wouldnt"], ["could not", "couldnt"], ["should not", "shouldnt"],
    ["must not", "mustnt"], ["can not", "cant"], ["cannot", "cant"],
    ["could have", "couldve"], ["would have", "wouldve"], ["should have", "shouldve"], ["might have", "mightve"], ["must have", "mustve"],
  ].map(([long, short]) => [long!, short!] as [string, string]),
);

const CONTRACTION_TOKENS: ReadonlySet<string> = new Set(CONTRACTED.values());
/** a contraction without its apostrophe ("im", "dont", "its"); some are also ordinary words, so this is a hint, not proof */
export const isContractionToken = (t: string): boolean => CONTRACTION_TOKENS.has(t);

/** merges adjacent tokens that form a contraction pair (the merged token keeps the properties of the second one) */
export function mergeContractions<T extends { tok: string }>(items: readonly T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < items.length; i++) {
    const a = items[i]!;
    const b = items[i + 1];
    const pair = b ? CONTRACTED.get(`${a.tok} ${b.tok}`) : undefined;
    if (b && pair) {
      out.push({ ...b, tok: pair });
      i++;
    } else {
      const single = CONTRACTED.get(a.tok); // "cannot"
      out.push(single ? { ...a, tok: single } : a);
    }
  }
  return out;
}

export function tokenize(text: string): string[] {
  return mergeContractions(rawTokens(text).map((tok) => ({ tok }))).map((x) => x.tok);
}

/** equal, or the same pair in the regional table */
export function sameWord(a: string, b: string): boolean {
  return a === b || regionalCanonical(a) === regionalCanonical(b);
}

export type DiffOp = { op: "same" | "missing" | "extra" | "wrong"; expected: string | null; typed: string | null };

/** Levenshtein alignment over words; `distance` is the number of missing, extra and wrong words. Ties prefer matching, then substitution. */
export function alignWords(expected: readonly string[], typed: readonly string[]): { distance: number; ops: DiffOp[] } {
  const n = expected.length;
  const m = typed.length;
  const d: number[][] = Array.from({ length: n + 1 }, (_, i) => [i, ...Array<number>(m).fill(0)]);
  for (let j = 1; j <= m; j++) d[0]![j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (sameWord(expected[i - 1]!, typed[j - 1]!) ? 0 : 1));
    }
  }
  const ops: DiffOp[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const same = sameWord(expected[i - 1]!, typed[j - 1]!);
      if (d[i]![j] === d[i - 1]![j - 1]! + (same ? 0 : 1)) {
        ops.push({ op: same ? "same" : "wrong", expected: expected[i - 1]!, typed: typed[j - 1]! });
        i--;
        j--;
        continue;
      }
    }
    if (i > 0 && d[i]![j] === d[i - 1]![j]! + 1) {
      ops.push({ op: "missing", expected: expected[i - 1]!, typed: null });
      i--;
    } else {
      ops.push({ op: "extra", expected: null, typed: typed[j - 1]! });
      j--;
    }
  }
  return { distance: d[n]![m]!, ops: ops.reverse() };
}


const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** 0-999 in words, the Australian way ("one hundred and five", "twenty five") */
function numberWords(n: number): string {
  if (n < 20) return ONES[n]!;
  if (n < 100) return `${TENS[Math.floor(n / 10)]!}${n % 10 ? ` ${ONES[n % 10]!}` : ""}`;
  const rest = n % 100;
  return `${ONES[Math.floor(n / 100)]!} hundred${rest ? ` and ${numberWords(rest)}` : ""}`;
}

/**
 * The speech check hears "ten" and may write "10": digits (0-999) become words and "%" becomes "percent" before the words are compared. Applied to
 * the recognised text of synthesised sentences only; what the learner types is never changed (a digit typed in an answer stays a wrong word).
 */
export function spellNumbers(text: string): string {
  return text.replace(/%/g, " percent ").replace(/(?<![\d.,])\d{1,3}(?![\d.,]*\d)/g, (m) => numberWords(Number(m)));
}
