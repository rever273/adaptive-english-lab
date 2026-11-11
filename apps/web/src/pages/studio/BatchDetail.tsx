import { useEffect, useState } from 'react';
import { fetchBatch, fetchRevisionContent, type BatchItem, type BatchSummary } from '../../api';
import { STATUS_LABEL, errorText, batchAgentTask } from './shared';

export function BatchDetail({ id, category }: { id: string; category: 'grammar' | 'vocabulary' }) {
    const [data, setData] = useState<(BatchSummary & { items: BatchItem[] }) | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    useEffect(() => {
        const load = async () => {
            try {
                setData(await fetchBatch(id));
            } catch (e) {
                setError(errorText(e));
            }
        };
        void load();
        const t = setInterval(() => void load(), 4000);
        return () => clearInterval(t);
    }, [id]);
    const task = batchAgentTask(id, category);
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(task);
            setCopied(true);
        } catch {
            setError('Clipboard unavailable. Select and copy the task below.');
        }
    };
    return (
        <div className="batch-detail" data-testid="batch-detail">
            {error && (
                <p className="notice notice-error" role="alert">
                    {error}
                </p>
            )}
            {!data ? (
                <p>Loading?</p>
            ) : data.completion ? (
                <p className="notice notice-info" role="status">
                    Completed: {data.completion.accepted} accepted, {data.completion.corrected} revised, {data.completion.rejected} rejected
                    {data.completion.flagged ? `, ${data.completion.flagged} flagged` : ''}. Accepted exercises are available for practice.
                </p>
            ) : data.generationDone ? (
                <>
                    <h3>Task for the reviewing agent</h3>
                    <p className="small muted">
                        This task is for {data.requestedCount} {category} items in batch #{id.slice(0, 8)}. The agent checks every item, including generation
                        failures, and publishes accepted exercises.
                    </p>
                    <textarea readOnly rows={4} value={task} aria-label="Task for the reviewing agent" onFocus={(e) => e.currentTarget.select()} />
                    <button className="btn btn-primary" onClick={() => void copy()}>
                        {copied ? 'Copied' : 'Copy'}
                    </button>
                </>
            ) : (
                <p role="status">Generating drafts? Follow progress in AI Tasks. The reviewing task appears when generation finishes.</p>
            )}
            {data && (
                <details>
                    <summary>Item details ({data.requestedCount})</summary>
                    <table className="summary-table">
                        <thead>
                            <tr>
                                <th>#</th>
                                <th>Skill / word</th>
                                <th>Status</th>
                                <th />
                            </tr>
                        </thead>
                        <tbody>
                            {data.items.map((i) => (
                                <ItemRow key={i.ordinal} item={i} />
                            ))}
                        </tbody>
                    </table>
                </details>
            )}
        </div>
    );
}
function ItemRow({ item }: { item: BatchItem }) {
    const [content, setContent] = useState<Record<string, unknown> | null>(null);
    const [open, setOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const toggle = async () => {
        setOpen(!open);
        if (!open && item.revisionId && !content) {
            try {
                setContent((await fetchRevisionContent(item.revisionId)).content);
            } catch (e) {
                setError(errorText(e));
            }
        }
    };
    return (
        <>
            <tr>
                <td>{item.ordinal + 1}</td>
                <td>
                    {item.plan.vocabulary?.lemma ?? item.plan.target_skill}
                    {item.plan.lesson ? (
                        <span className="muted small">
                            {' '}
                            · {/l(\d+)$/i.test(item.plan.lesson) ? `L${/l(\d+)$/i.exec(item.plan.lesson)![1]!.padStart(2, '0')}` : item.plan.lesson}
                        </span>
                    ) : null}
                </td>
                <td>{STATUS_LABEL[item.status]}</td>
                <td>
                    <button className="link" onClick={() => void toggle()}>
                        {open ? 'Hide' : 'View'}
                    </button>
                </td>
            </tr>
            {open && (
                <tr>
                    <td colSpan={4}>
                        {error ? (
                            <p>{error}</p>
                        ) : content ? (
                            <Preview c={content} />
                        ) : item.error ? (
                            <p className="muted">Generation did not produce a valid draft. The agent can replace or reject this item.</p>
                        ) : (
                            <p>Loading?</p>
                        )}
                    </td>
                </tr>
            )}
        </>
    );
}
function Preview({ c }: { c: Record<string, unknown> }) {
    const p = c.payload as Record<string, any>;
    const type = c.type as string;
    return (
        <div className="preview small">
            <p>
                <strong>{String(c.prompt_en)}</strong>
            </p>
            {(type === 'choose_form' || type === 'choose_missing_fragment') && (
                <ul>
                    {(p.options as Array<{ id: string; text: string }>).map((o) => (
                        <li key={o.id}>
                            {(p.accepted_option_ids as string[]).includes(o.id) ? '✔ ' : ''}
                            {o.text}
                        </li>
                    ))}
                </ul>
            )}
            {type === 'detect_error' && (
                <p>
                    {p.sentence} {p.no_mistake ? <em>(no mistake)</em> : <>→ {(p.corrections as string[]).join(' / ')}</>}
                </p>
            )}
            {(type === 'guided_short_answer' || type === 'russian_to_english_short') && (
                <>
                    <p className="ru">{p.cue_ru}</p>
                    <ul>
                        {(p.accepted_answers as string[]).map((a, k) => (
                            <li key={k}>{a}</li>
                        ))}
                    </ul>
                </>
            )}
            {type === 'context_reading' && (
                <>
                    {(p.paragraphs as string[]).map((t, k) => (
                        <p key={k} className="passage">
                            {t}
                        </p>
                    ))}
                    {(p.questions as Array<{ prompt: string; options: Array<{ id: string; text: string }>; accepted_option_ids: string[] }>).map((q, k) => (
                        <div key={k}>
                            <p>{q.prompt}</p>
                            <ul>
                                {q.options.map((o) => (
                                    <li key={o.id}>
                                        {q.accepted_option_ids.includes(o.id) ? '✔ ' : ''}
                                        {o.text}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ))}
                </>
            )}
            <p className="ru muted">{String((c.hints_ru as string[])[0] ?? '')}</p>
            <p className="ru">{String(c.explanation_ru)}</p>
        </div>
    );
}
