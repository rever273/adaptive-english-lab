import { Chart } from "./Chart";

type Day = { date: string; cumulativeChars?: number };
export function CumulativeCharacters({ data, submitted = false }: { data: Day[]; submitted?: boolean }) {
  if (!data.length) return null;
  const label = submitted ? "Submitted characters over time" : "Characters typed over time";
  return <div><h4 className="chart-title">{label}</h4><Chart ariaLabel={label}
    line={{ color: "#b78bff", format: (v) => Math.round(v).toLocaleString("en-AU") }}
    legend={submitted ? "All-time total through each day: submitted answers for completed sentences, including retries." : "All-time total through each day, including wrong keys in finished attempts."}
    points={data.map((d) => ({ key: d.date, label: new Date(d.date + "T00:00:00").toLocaleDateString("en-AU", { day: "numeric", month: "short" }), line: d.cumulativeChars ?? 0, tip: [d.date, `Total: ${(d.cumulativeChars ?? 0).toLocaleString("en-AU")}`] }))} /></div>;
}
