import { ApiRequestError, type ItemStatus } from '../../api';

export const STATUS_LABEL: Record<ItemStatus, string> = {
    queued: 'Generating',
    invalid: 'Needs agent repair',
    generated: 'Draft',
    ready_for_review: 'Awaiting agent',
    approved: 'Approved',
    released: 'Accepted',
    flagged: 'Flagged',
    rejected: 'Rejected',
};
export const errorText = (e: unknown) => (e instanceof ApiRequestError ? e.message : 'Something went wrong.');

export const batchAgentTask = (id: string, category: 'grammar' | 'vocabulary') =>
    `Complete and publish ${category} replenishment batch ${id}. Read content/agent-workflows/${category}.md and common.md in that directory. Run npm run content:agent -- prepare ${id}, review every item, repair suitable drafts as new revisions and reject unsuitable ones. Use the check and finalize commands in the instructions. Independent review by a separate agent is explicitly requested for every final candidate, especially corrections; do not self-approve. Do the review through the content-reviewer agent and the tools in .claude/tools (see your project memory for the workflow), after you have rejected duplicates and fixed the known defects yourself. Apply the reviewed results to the local app yourself. Do not ask me to copy JSON or run commands. Preserve lesson selection, dictionary edits and raw attempt history. Reply briefly with accepted, corrected and rejected counts, and end with one short line: how many tokens the review subagent(s) used in total.`;
