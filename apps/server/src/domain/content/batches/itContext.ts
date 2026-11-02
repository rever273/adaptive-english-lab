/**
 * IT/AI work context for generated sentences (user decision 2026-11-02: 20% of new generated sentences, was 15%).
 * Source: the learner's brief for a junior developer role (P1 phrases only). The topic is context for the grammar or word target,
 * never a test of IT knowledge; a hint to the generator, not a stored field of the exercise.
 */
export const IT_SHARE_PERCENT = 20;

const IT_PHRASES = [
  "clarify the requirements", "acceptance criteria", "break down a task", "estimate the effort", "raise a concern", "flag an issue",
  "run into a problem", "be blocked by something", "follow up on something", "give an update", "be on track", "be out of scope",
  "meet a deadline", "a workaround", "a trade-off", "reproduce a bug", "track down the cause", "narrow down the issue", "debug an issue",
  "refactor the code", "review a pull request", "address review comments", "resolve a merge conflict", "push a commit", "merge a branch",
  "run the test suite", "deploy to staging", "roll back a deployment", "check the logs", "query the database", "filter the results",
  "update a record", "apply a migration", "validate user input", "handle an exception", "return a response", "call an API endpoint",
  "render a component", "pass a prop", "a database schema", "a foreign key", "provide context", "write a clear prompt", "generate a patch",
  "review AI-generated code", "verify the output", "delegate a task to an agent", "work on tasks in parallel", "compare the results",
  "token usage", "the context window", "an inaccurate response", "a tool call", "access permissions", "a user role", "an audit trail",
  "a business rule", "an approval workflow", "an invoice", "an integration",
] as const;

const IT_SETTING =
  "a small software consultancy: a junior developer and teammates working on B2B web systems (C#/.NET, PHP/Laravel, SQL, Vue), pull requests, tests, deployments, client requirements, and AI coding assistants/agents. Natural Australian English; use neutral roles (a teammate, the client, the reviewer, we); do not claim real events; at most two technical terms and keep the grammar target the point of the item";

/** Extra instruction for one item whose topic is "technology" (deterministic per ordinal so a retry sees the same hint). */
export function itContext(ordinal: number): { setting: string; suggested_phrases: string[] } {
  const n = IT_PHRASES.length;
  return { setting: IT_SETTING, suggested_phrases: [IT_PHRASES[(ordinal * 7) % n]!, IT_PHRASES[(ordinal * 7 + 23) % n]!] };
}

/** True for `IT_SHARE_PERCENT` of 20 consecutive ordinals, spread evenly. */
export const isItOrdinal = (ordinal: number): boolean => (ordinal * 7) % 20 < IT_SHARE_PERCENT / 5;
