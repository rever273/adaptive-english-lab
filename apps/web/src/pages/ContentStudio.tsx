import { useCallback, useEffect, useState } from 'react';
import { VocabularyStudio } from './VocabularyStudio';
import { WordLessonStudio } from './WordLessonStudio';
import { STATUS_LABEL, errorText } from './studio/shared';
import { DictationTracks } from './studio/DictationTracks';
import { BatchDetail } from './studio/BatchDetail';
import { batchCache, coverageCache, stockCache } from './studioCache';
import {
    createBatchApi,
    createAgentBatchApi,
    createThoughtBatchApi,
    fetchThoughts,
    fetchAgentTask,
    fetchContentStock,
    type StudioBatchSummary,
    type Coverage,
    type ItemStatus,
} from '../api';

const THOUGHTS_AGENT_TASK = `English Lab: choose the grammar skills for my saved thoughts. Follow any local project instructions. Work on your own and run every command yourself; do not ask me to run anything. Do not commit or push. Never edit the SQLite database directly; use only the commands below. Keep the thoughts private: do not copy them into Git or public files.
1. Run: npm run lab:thoughts -- export (read-only; it prints where thoughts.md and thoughts.json are).
2. For EVERY pattern pick the ONE skill whose rule the pattern genuinely exercises, judging by the rule text, not the skill id; use null when nothing fits or the pattern is wrong for the sentence. Do not take the nearest-sounding skill.
3. Write the manifest (template in thoughts.json) and apply it: npm run lab:thoughts -- apply <manifest.json>.
4. Reply in Russian, briefly: how many thoughts got skills, how many patterns were dropped and why.`;


const VIEWS = [
    ['grammar', 'Grammar exercises'],
    ['vocabulary', 'Vocabulary exercises'],
    ['typing', 'Typing'],
] as const;
/** The agent writes the exercises itself: the batch is stored (no local model runs) and this task tells it exactly what to do. */
export const authoringAgentTask = (id: string, count: number, category: 'grammar' | 'vocabulary' = 'vocabulary') =>
    `Write and publish ${category} batch ${id} (${count} items) yourself; no local model is used. Read content/agent-workflows/${category}.md and common.md in that directory, then run npm run content:agent -- prepare ${id} and read author-packet.json in the reported work directory (${category === 'vocabulary' ? 'the planned words, families, CEFR levels, topic ideas, meanings, synonyms, sentences to avoid and wrong-option candidates' : 'the planned skills with their rule cards, formats, CEFR levels and topics, plus the draft format of every exercise type'} are ready there). Plan the items of one ${category === 'vocabulary' ? 'word' : 'skill'} together so each has its own scene, people and sentence type: the author command rejects repeated frames. Write one draft per item into drafts.json in the format shown in that packet, then run npm run content:agent -- author ${id}; fix every PROBLEM it prints and run it again until none remain. Aim for exercises you would accept yourself: natural Australian English at the item's level, one defensible answer, wrong options that clearly do not fit, accurate Russian. Then set plan.author, run check, have the content-reviewer agent review every final candidate through the tools in .claude/tools (see your project memory), apply its FIX lines as patches and re-review only the changed hashes, then finalize. Do not ask me to copy JSON or run commands. Preserve lesson selection, dictionary edits and raw attempt history. Reply briefly with accepted, corrected and rejected counts, then report tokens separately: the review subagent(s) exactly, and your own work as an estimate (say it is an estimate), so the result can be compared with a locally generated batch.`;

export function ContentStudio({ initialView = 'grammar' }: { initialView?: 'grammar' | 'vocabulary' | 'typing' } = {}) {
    const [category, setCategory] = useState(initialView);
    return (
        <>
            <div className="segmented page-switch" role="radiogroup" aria-label="Which exercises">
                {VIEWS.map(([c, label]) => (
                    <label key={c} className={category === c ? 'on' : ''}>
                        <input type="radio" name="cs-view" checked={category === c} onChange={() => setCategory(c)} data-testid={`studio-${c}`} />
                        {label}
                    </label>
                ))}
            </div>
            {category === 'typing' ? (
                <DictationTracks />
            ) : (
                <>
                    {category === 'vocabulary' && <WordLessonStudio />}
                    {category === 'grammar' && <CreateLessonsTask />}
                    <BatchStudio key={category} category={category} onCategoryChange={setCategory} />
                </>
            )}
        </>
    );
}

function CreateLessonsTask() {
    const [count, setCount] = useState(5);
    const [task, setTask] = useState<{ text: string; copied: boolean } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const copy = async () => {
        setError(null);
        try {
            const result = await fetchAgentTask('lessons');
            if (!/Number of new lessons:\s*\d+\s*$/.test(result.text)) throw new Error('The lesson task has an unexpected format.');
            const text = result.text.replace(/Number of new lessons:\s*\d+\s*$/, `Number of new lessons: ${count}`);
            let copied = true;
            try { await navigator.clipboard.writeText(text); } catch { copied = false; }
            setTask({ text, copied });
        } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    };
    return <section className="card">
        <h2><i className="pi pi-sitemap" aria-hidden="true" /> Plan new lessons</h2>
        <p className="small muted">Create lesson structures from your progress. Exercises are created and reviewed separately.</p>
        <div className="actions"><label className="inline"><span>Number of new lessons</span><input type="number" min={1} max={50} value={count} onChange={(e) => setCount(Number(e.target.value))} /></label>
        <button className="btn" data-testid="copy-lessons" disabled={!Number.isInteger(count) || count < 1 || count > 50} onClick={() => void copy()}><i className="pi pi-plus-circle" aria-hidden="true" /> Copy task: create new lessons</button></div>
        {error && <p className="notice notice-error small" role="alert">{error}</p>}
        {task && <div><p className="small" role="status">{task.copied ? "Copied. Paste it into your agent's chat." : 'Could not use the clipboard. Select and copy the text below.'}</p><textarea readOnly rows={6} value={task.text} aria-label="Agent lesson task" style={{ width: '100%' }} /></div>}
    </section>;
}


function BatchStudio({ category, onCategoryChange }: { category: 'grammar' | 'vocabulary'; onCategoryChange: (category: 'grammar' | 'vocabulary') => void }) {
    const [batches, setBatches] = useState<StudioBatchSummary[]>(() =>
        (batchCache.peek()?.batches ?? []).filter((b) => (b.category ?? 'grammar') === category),
    );
    const [otherCount, setOtherCount] = useState(() => (batchCache.peek()?.batches ?? []).filter((b) => (b.category ?? 'grammar') !== category).length);
    const [coverage, setCoverage] = useState<Coverage | null>(() => coverageCache.peek());
    const [stock, setStock] = useState<Awaited<ReturnType<typeof fetchContentStock>> | null>(() => stockCache.peek());
    const [open, setOpen] = useState<string | null>(null);
    const [count, setCount] = useState(50);
    const [countTouched, setCountTouched] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const loadBatches = useCallback(
        async (force = false) => {
            try {
                const b = await batchCache.get(force);
                setBatches(b.batches.filter((b) => (b.category ?? 'grammar') === category));
                setOtherCount(b.batches.filter((b) => (b.category ?? 'grammar') !== category).length);
            } catch (e) {
                setError(errorText(e));
            }
        },
        [category],
    );
    const loadCoverage = useCallback(
        async (force = false) => {
            try {
                const c = await coverageCache.get(force);
                setCoverage(c);
                const s = await stockCache.get(force);
                setStock(s);
                const rec = s[category].recommended;
                if (!countTouched && rec && rec > 0) setCount(Math.min(500, rec));
            } catch (e) {
                setError(errorText(e));
            }
        },
        [category, countTouched],
    );
    useEffect(() => {
        let active = true;
        void loadBatches().then(() => {
            if (active) void loadCoverage();
        });
        const listTimer = setInterval(() => void loadBatches(true), 5000);
        const coverageTimer = setInterval(() => void loadCoverage(true), 30000);
        return () => {
            active = false;
            clearInterval(listTimer);
            clearInterval(coverageTimer);
        };
    }, [loadBatches, loadCoverage]);
    const start = async () => {
        setBusy(true);
        setError(null);
        setNote(null);
        try {
            const r = await createBatchApi({ count, mode: 'adaptive', category });
            setOpen(r.batchId);
            setNote(`Started ${r.items} drafts. Progress is shown in AI Tasks and the AI activity panel.`);
            await batchCache.get();
            await loadBatches(true);
        } catch (e) {
            setError(errorText(e));
        } finally {
            setBusy(false);
        }
    };
    const [thoughts, setThoughts] = useState({ ready: 0, needSkills: 0 });
    useEffect(() => {
        void fetchThoughts()
            .then((r) => setThoughts({ ready: r.readyForBatch, needSkills: r.needSkills }))
            .catch(() => undefined);
    }, [note]);
    const copyAgentPrompt = async () => {
        setBusy(true);
        setError(null);
        setNote(null);
        try {
            const r = await createAgentBatchApi({ count, mode: 'adaptive', category });
            setOpen(r.batchId);
            await navigator.clipboard?.writeText(authoringAgentTask(r.batchId, r.items, category));
            setNote(`Batch #${r.batchId.slice(0, 8)} of ${r.items} exercises is stored for your agent and the task is copied. Paste it to your coding agent.`);
            await batchCache.get();
            await loadBatches(true);
        } catch (e) {
            setError(errorText(e));
        } finally {
            setBusy(false);
        }
    };
    const startThoughts = async () => {
        setBusy(true);
        setError(null);
        setNote(null);
        try {
            const r = await createThoughtBatchApi();
            setOpen(r.batchId);
            setNote(
                `Started ${r.items} drafts from ${r.thoughts} thought${r.thoughts === 1 ? '' : 's'}. They wait for independent review like any other draft.`,
            );
            await batchCache.get();
            await loadBatches(true);
        } catch (e) {
            setError(errorText(e));
        } finally {
            setBusy(false);
        }
    };
    const low = stock?.[category];
    const course = category === 'grammar' ? stock?.grammar.course : undefined;
    const calculateCourse = async () => {
        setBusy(true);
        setError(null);
        try {
            const fresh = await stockCache.get(true);
            setStock(fresh);
            const estimate = fresh.grammar.course;
            if (!estimate) {
                setNote('No available lessons to plan.');
                return;
            }
            setCountTouched(true);
            if (estimate.recommended > 0) setCount(Math.min(500, estimate.recommended));
            setNote(
                estimate.recommended === 0
                    ? `No missing exercises found for ${estimate.sessions} remaining sessions.`
                    : `Estimated ${estimate.deficit} approved exercises missing for ${estimate.sessions} remaining sessions; ${estimate.recommended} drafts include a 20% review margin.${estimate.recommended > 500 ? ' One batch can contain up to 500; create another after review and recalculate.' : ''}`,
            );
        } catch (e) {
            setError(errorText(e));
        } finally {
            setBusy(false);
        }
    };
    const vocabularyPlan = category === 'vocabulary' ? stock?.vocabulary.plan : undefined;
    const calculateVocabulary = async () => {
        setBusy(true);
        setError(null);
        try {
            const fresh = await stockCache.get(true);
            setStock(fresh);
            const estimate = fresh.vocabulary.plan;
            if (!estimate || estimate.words === 0) {
                setNote('Add words to your dictionary first.');
                return;
            }
            setCountTouched(true);
            if (estimate.recommended > 0) setCount(Math.min(500, estimate.recommended));
            setNote(
                estimate.recommended === 0
                    ? 'All words have the planned stock of contexts.'
                    : `Estimated ${estimate.recommended} drafts for ${estimate.words} words, including 20% margin.${estimate.recommended > 500 ? ' One batch can contain up to 500; review it and recalculate before the next batch.' : ''}`,
            );
        } catch (e) {
            setError(errorText(e));
        } finally {
            setBusy(false);
        }
    };
    const batchRow = (b: StudioBatchSummary) => (
        <li key={b.id}>
            <button
                className={`batch-row${open === b.id ? ' batch-row-on' : ''}`}
                onClick={() => setOpen(open === b.id ? null : b.id)}
                aria-expanded={open === b.id}
            >
                <span>
                    <strong>
                        {category === 'grammar' ? 'Grammar' : 'Vocabulary'} batch | {b.requestedCount} items
                    </strong>{' '}
                    <span className="muted small">
                        #{b.id.slice(0, 8)} | {new Date(b.createdAt).toLocaleDateString()}
                    </span>
                </span>
                <span className="chips">
                    {b.completion ? (
                        <>
                            <span className="chip">Completed</span>
                            <span className="chip chip-released">{b.completion.accepted} accepted</span>
                            <span className="chip chip-rejected">{b.completion.rejected} rejected</span>
                            {b.completion.flagged > 0 && <span className="chip chip-flagged">{b.completion.flagged} flagged</span>}
                        </>
                    ) : (
                        Object.entries(b.counts ?? {})
                            .filter(([, n]) => n > 0)
                            .map(([status, n]) => (
                                <span key={status} className={`chip chip-${status}`}>
                                    {n} {STATUS_LABEL[status as ItemStatus].toLowerCase()}
                                </span>
                            ))
                    )}
                </span>
            </button>
            {open === b.id &&
                (b.completion ? (
                    <div className="batch-detail">
                        <p className="notice notice-info" role="status">
                            Completed: {b.completion.accepted} accepted, {b.completion.corrected} revised, {b.completion.rejected} rejected
                            {b.completion.flagged ? `, ${b.completion.flagged} flagged` : ''}.
                        </p>
                    </div>
                ) : (
                    <BatchDetail id={b.id} category={category} />
                ))}
        </li>
    );
    return (
        <>
            <section className="card">
                <h2>Content Studio</h2>
                <p className="lede">
                    Create new {category === 'grammar' ? 'exercises for your learning skills' : 'exercises using your saved words'}. When generation finishes,
                    copy the task to your agent. It checks, repairs and publishes the results for you.
                </p>
                {error && (
                    <p className="notice notice-error" role="alert">
                        {error}
                    </p>
                )}
                {note && (
                    <p className="notice notice-info" role="status">
                        {note}
                    </p>
                )}
                <div className="actions">
                    <label className="inline">
                        <span>Batch size</span>
                        <input
                            type="number"
                            min={1}
                            max={500}
                            value={count}
                            onChange={(e) => {
                                setCountTouched(true);
                                setCount(Number(e.target.value));
                            }}
                            aria-label="Batch size"
                        />
                    </label>
                    <button className="btn btn-primary" disabled={busy || !Number.isInteger(count) || count < 1 || count > 500} onClick={() => void start()}>
                        Start batch
                    </button>
                    <button
                        className="btn"
                        disabled={busy || !Number.isInteger(count) || count < 1 || count > 500}
                        onClick={() => void copyAgentPrompt()}
                        title="No local model: your coding agent writes the exercises itself. Creates the batch and copies its task."
                        data-testid="copy-agent-task"
                    >
                        <i className="pi pi-copy" aria-hidden="true" /> Copy agent prompt
                    </button>
                    {category === 'grammar' ? (
                        <button className="btn" disabled={busy} onClick={() => void calculateCourse()}>
                            Calculate for lessons
                        </button>
                    ) : (
                        <button className="btn" disabled={busy} onClick={() => void calculateVocabulary()}>
                            Calculate for words
                        </button>
                    )}
                </div>
                {category === 'grammar' && (thoughts.ready > 0 || thoughts.needSkills > 0) && (
                    <div className="actions" data-testid="thoughts-ready">
                        {thoughts.needSkills > 0 && (
                            <>
                                <span className="small">
                                    {thoughts.needSkills} saved thought{thoughts.needSkills === 1 ? ' needs' : 's need'} a grammar-skill check by your agent.
                                </span>
                                <button
                                    className="btn"
                                    onClick={() =>
                                        void navigator.clipboard
                                            ?.writeText(THOUGHTS_AGENT_TASK)
                                            .then(() => setNote('Task copied. Paste it to your coding agent.'))
                                    }
                                >
                                    Copy task for agent
                                </button>
                            </>
                        )}
                        {thoughts.ready > 0 && (
                            <>
                                <span className="small">
                                    {thoughts.ready} checked thought{thoughts.ready === 1 ? '' : 's'} ready to become practice patterns.
                                </span>
                                <button className="btn" disabled={busy} onClick={() => void startThoughts()}>
                                    Create drafts from my thoughts
                                </button>
                            </>
                        )}
                    </div>
                )}
            </section>
            <section className="card">
                <h2>Batches</h2>
                {otherCount > 0 && (
                    <p className="small muted">
                        Showing {category} batches.{' '}
                        <button className="link" onClick={() => onCategoryChange(category === 'grammar' ? 'vocabulary' : 'grammar')}>
                            Show {otherCount} {category === 'grammar' ? 'vocabulary' : 'grammar'} {otherCount === 1 ? 'batch' : 'batches'}
                        </button>
                    </p>
                )}
                {batches.length === 0 ? (
                    <p className="muted">No batches yet. Choose a number and start a batch.</p>
                ) : (
                    <>
                        <ul className="batch-list" data-testid="batches">
                            {batches.slice(0, 5).map(batchRow)}
                        </ul>
                        {batches.length > 5 && (
                            <details className="older-batches">
                                <summary>Earlier batches ({batches.length - 5})</summary>
                                <div className="older-batches-scroll">
                                    <ul className="batch-list">{batches.slice(5).map(batchRow)}</ul>
                                </div>
                            </details>
                        )}
                    </>
                )}
            </section>
            <section className="card">
                <h2>Coverage</h2>
                {low && (
                    <p className={`notice ${low.low ? 'notice-error' : 'notice-info'}`} role="status">
                        {low.message ??
                            `${low.available} new approved exercises available.${low.low ? ` Stock is running low (warning below ${low.threshold}). Create a new batch.` : ''}`}
                        {low.recommended ? ` Suggested batch size: ${low.recommended} (deficit + 20%).` : ''}
                    </p>
                )}
                {vocabularyPlan && (
                    <p className="small" role="status">
                        {vocabularyPlan.words} words: {vocabularyPlan.deficit} contexts missing; {vocabularyPlan.recommended} drafts suggested with 20% margin.
                        Target: {vocabularyPlan.targetPerWord} approved contexts per word (2 recognition, 2 recall, 1 collocation). Previously seen contexts
                        count as reusable; drafts do not count until approved. Recalculate after review.
                    </p>
                )}
                {course && (
                    <p className="small" role="status">
                        Remaining lessons: {course.sessions} sessions across {course.lessons} lessons; estimated {course.deficit} exercises short,{' '}
                        {course.recommended} drafts suggested with 20% review margin. Shared stock is allocated once; future repeats are not assumed. This is an
                        estimate: recalculate after review and practice.
                    </p>
                )}
                {category === 'vocabulary' ? (
                    <VocabularyStudio />
                ) : (
                    coverage && (
                        <>
                            <p>{coverage.totals.releasedExercises} published grammar exercises in total. Used sentences are excluded from available stock.</p>
                            <details>
                                <summary>Coverage by skill</summary>
                                <ul className="small">
                                    {coverage.skills.map((s) => (
                                        <li key={s.skill}>
                                            <code>{s.skill}</code>: {s.released} published, {s.inReview} awaiting agent
                                        </li>
                                    ))}
                                </ul>
                            </details>
                        </>
                    )
                )}
            </section>
        </>
    );
}
