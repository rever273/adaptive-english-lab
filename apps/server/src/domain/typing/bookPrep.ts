/**
 * Preparation of a public-domain book for the Books typing mode. The cleaned text is written to a local file (git-ignored);
 * only metadata and the content hash live in the database. The script is the only code that touches the network.
 */

export interface PreparedChapter {
  title: string;
  startOffset: number;
  endOffset: number;
}

export interface PreparedBook {
  text: string;
  chapters: PreparedChapter[];
  issues: string[];
}

// A heading is an exact standalone line: part titles, "Chapter N" (Arabic only, so the Roman-numeral chapter
// headings quoted inside Goldstein's book stay body text) and the appendix. `trim()` already ran, so `$` anchors the line.
const HEADING_RE = /^(PART\s+(?:ONE|TWO|THREE)|Chapter\s+\d+|APPENDIX\.?)$/i;
const PAGE_NUMBER_RE = /^\d{1,4}$/;
/** scene breaks like "*****" or "-----": decorative separators, dropped (they end the current paragraph). */
const SEPARATOR_RE = /^[*_\-=]{3,}$/;
/** Gutenberg service header/footer lines (title/author/licence/transcriber boilerplate), never part of the text. */
const SERVICE_RE = /gutenberg|ebook no\.|^title\s*:|^author\s*:|^language\s*:|^date first posted|^date most recently updated|licence\.html|^character set|^produced by|^transcriber|^proofread/i;
/** the explicit end-of-book marker (may appear once after the novel and again after an appendix): skip, never stop. */
const THE_END_RE = /^THE END$|^END OF (THE )?PROJECT GUTENBERG/i;
const BLOCKLIST = new Set([
  "1984",
  "nineteen eighty-four",
  "george orwell",
  "free ebooks at planet ebook.com",
  "the project gutenberg ebook",
  "end of the project gutenberg ebook",
  "www.gutenberg",
  "www.planetebook",
]);

/** join the lines of one paragraph, de-hyphenating a line that ends `word-` followed by a lowercase continuation. */
function joinParagraph(lines: string[]): string {
  let out = "";
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!.trim();
    if (line === "") continue;
    const next = i + 1 < lines.length ? lines[i + 1]!.trim() : "";
    const hyphenated = line.endsWith("-") && /^[a-z]/.test(next);
    if (hyphenated) line = line.slice(0, -1);
    out += (out === "" || hyphenated ? "" : " ") + line;
  }
  return out.replace(/\s{2,}/g, " ").replace(/--+/g, "—").trim();
}

function reportIssues(text: string): string[] {
  const issues: string[] = [];
  const unexpected = new Map<string, number>();
  for (const ch of text) {
    if (/[A-Za-z0-9\s.,;:!?\-—’‘'"“”"()\[\]]/.test(ch)) continue;
    if (ch === "\n") continue;
    unexpected.set(ch, (unexpected.get(ch) ?? 0) + 1);
  }
  const sample = [...unexpected.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (sample.length) {
    issues.push(`unexpected characters (count): ${sample.map(([c, n]) => `${JSON.stringify(c)}=${n}`).join(", ")}`);
  }
  return issues;
}

/** Chapter/part headings are kept in `chapters`, not in the text itself. */
export function prepareBookText(raw: string): PreparedBook {
  const issues: string[] = [];
  const lines = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");

  let currentLines: string[] = [];
  let currentTitle: string | null = null;
  let currentStart = -1;
  const chapters: PreparedChapter[] = [];
  let out = "";

  const flush = () => {
    if (currentLines.length === 0) return;
    const para = joinParagraph(currentLines);
    currentLines = [];
    if (para === "") return;
    // text before the first heading is the service header (title/author/licence): drop it
    if (currentTitle === null) return;
    if (currentStart === -1) currentStart = out.length;
    out += (out === "" ? "" : "\n\n") + para;
  };

  const closeChapter = (endOffset: number) => {
    if (currentTitle !== null) {
      chapters.push({ title: currentTitle, startOffset: currentStart === -1 ? endOffset : currentStart, endOffset });
    }
    currentTitle = null;
    currentStart = -1;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "") {
      flush();
      continue;
    }
    if (PAGE_NUMBER_RE.test(line)) continue;
    if (SEPARATOR_RE.test(line)) {
      flush();
      continue;
    }
    if (THE_END_RE.test(line)) continue;
    if (SERVICE_RE.test(line)) continue;
    if (BLOCKLIST.has(line.toLowerCase())) continue;
    if (HEADING_RE.test(line)) {
      flush();
      closeChapter(out.length);
      currentTitle = line;
      continue;
    }
    currentLines.push(line);
  }
  flush();
  closeChapter(out.length);

  if (chapters.length === 0) issues.push("no chapter or part headings were detected; chapters_json is empty");
  issues.push(...reportIssues(out));

  return { text: out, chapters, issues };
}
