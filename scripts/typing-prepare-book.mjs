// npm run typing:prepare-book -- --source <file-or-url> [--accept]
// Downloads/reads the book, cleans it, writes the cleaned text to <dataRoot>/typing-books/1984.txt (git-ignored) and stores metadata in
// `typing_books`. Only this script touches the network. The cleaned text is local and is never published.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadServerModule, requireBuild } from "./_common.mjs";

requireBuild({ web: false });
const args = process.argv.slice(2);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);

const { loadConfig } = await loadServerModule("config.js");
const { openDatabase } = await loadServerModule("db/open.js");
const { prepareBookText } = await loadServerModule("domain/typing/bookPrep.js");

const source = opt("--source");
if (!source) {
  console.error("Pass --source <file-or-url>");
  process.exit(2);
}
const accept = args.includes("--accept");
const config = loadConfig();

async function readSource() {
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
    let body = await res.text();
    // archive.org /stream/...djvu.txt returns an HTML wrapper around the OCR text
    const m = body.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
    if (m) {
      body = m[1]
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
    }
    return body;
  }
  return readFileSync(source, "utf8");
}

const raw = await readSource();
const prepared = prepareBookText(raw);
const sha = createHash("sha256").update(prepared.text).digest("hex");
const report = {
  source,
  textLength: prepared.text.length,
  chapters: prepared.chapters.length,
  chaptersFound: prepared.chapters.map((c) => c.title),
  issues: prepared.issues,
  contentSha256: sha,
};
console.log(JSON.stringify(report, null, 2));

if (prepared.issues.length > 0 && !accept) {
  console.error("Quality issues were found. Review the report and re-run with --accept to write the file anyway.");
  process.exit(1);
}

const booksDir = path.join(config.dataRoot, "typing-books");
mkdirSync(booksDir, { recursive: true });
const bookId = "1984";
const file = path.join(booksDir, `${bookId}.txt`);
writeFileSync(file, prepared.text, "utf8");

const dbFile = path.resolve(config.dbPath);
if (!existsSync(dbFile)) {
  console.error(`database not found: ${dbFile} (start the app once to apply migrations)`);
  process.exit(2);
}
const db = openDatabase(dbFile);
try {
  const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'typing_books'").get();
  if (!hasTable) {
    console.error("typing_books table is missing: start the app once to apply migrations");
    process.exit(2);
  }
  const existing = db.prepare("SELECT content_sha256 AS sha FROM typing_books WHERE id = ?").get(bookId);
  if (existing && existing.sha === sha) {
    console.log(`Book already prepared with the same content (${bookId}). Nothing to do.`);
  } else if (existing) {
    console.error(`A different book is already prepared for id ${bookId}; offsets depend on the file, so replace it with a new id.`);
    process.exit(2);
  } else {
    db.prepare(
      "INSERT INTO typing_books(id, title, author, source, content_sha256, text_length, chapters_json, created_at) VALUES (?,?,?,?,?,?,?,?)",
    ).run(bookId, "Nineteen Eighty-Four", "George Orwell", source, sha, prepared.text.length, JSON.stringify(prepared.chapters), new Date().toISOString());
    console.log(`Book ${bookId} prepared and registered.`);
  }
} finally {
  db.close();
}
