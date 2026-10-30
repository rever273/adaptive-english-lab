import { FIRST10_AUTHOR, FIRST10_REVIEWER, LESSONS, LESSON_QUOTAS, READING_LESSONS, buildBlock } from "./lib.mjs";
import { DIAGNOSTIC, HELDOUT } from "./diagnostic.mjs";
import { L01 } from "./L01.mjs";
import { L02 } from "./L02.mjs";
import { L03 } from "./L03.mjs";
import { L04 } from "./L04.mjs";
import { L05 } from "./L05.mjs";
import { L06 } from "./L06.mjs";
import { L07 } from "./L07.mjs";
import { L08 } from "./L08.mjs";
import { L09 } from "./L09.mjs";
import { L10 } from "./L10.mjs";

export { FIRST10_AUTHOR, FIRST10_REVIEWER, LESSONS, LESSON_QUOTAS, READING_LESSONS };
const DEFS = { L01, L02, L03, L04, L05, L06, L07, L08, L09, L10 };

/** 10 lessons of 24-32 practice exercises, two reading passages each in L03/L06/L10 (D62), 24 diagnostic, 24 held-out. */
export function buildFirst10() {
  const practice = LESSONS.flatMap(([code]) => buildBlock(code, DEFS[code], "practice"));
  const diagnostic = buildBlock("DIAG", DIAGNOSTIC, "diagnostic");
  const heldout = buildBlock("HELD", HELDOUT, "heldout");
  return { practice, diagnostic, heldout };
}

/** blueprint policies (blueprint-policy-v1): default first-run quotas, one reading block in L03/L06/L10, the lesson's skill pool */
export function firstTenBlueprints() {
  return LESSONS.map(([code, title, pool]) => ({
    key: `first10-${code.toLowerCase()}`,
    policy: { schema_version: "blueprint-policy-v1", title: `${code} ${title}`, quotas: LESSON_QUOTAS, readingBlocks: READING_LESSONS.has(code) ? 1 : 0, skillPool: pool },
  }));
}
