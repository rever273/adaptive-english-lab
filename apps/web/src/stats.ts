import skillLabels from "./skillLabels.json";

/** 26464 -> "26 464" (a no-break space between thousands) */
export const groupDigits = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");

/** Wilson 95% interval for a share k of n (null when there are no tries) */
export function wilson(k: number, n: number): { low: number; high: number } | null {
  if (n === 0) return null;
  const z = 1.96, p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d, h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { low: Math.max(0, c - h), high: Math.min(1, c + h) };
}

const LABELS = skillLabels as Record<string, { en: string; ru: string }>;
/** "tenses.present_perfect" -> "Present Perfect"; the sentence-case fallback "Tenses: present perfect" for skills without a label */
export function skillName(id: string): string {
  const l = LABELS[id];
  if (l) return l.en;
  const [family, ...rest] = id.split(".");
  const text = rest.join(" ").replace(/_/g, " ");
  return `${family![0]!.toUpperCase()}${family!.slice(1).replace(/_/g, " ")}: ${text}`;
}
export const skillNameRu = (id: string): string | null => LABELS[id]?.ru ?? null;
