/** American to Australian spelling for the words the model keeps getting wrong (D69); applied to the visible English text only */
const AU_WORDS: Record<string, string> = { color: "colour", colors: "colours", colored: "coloured", flavor: "flavour", flavors: "flavours", neighbor: "neighbour", neighbors: "neighbours", neighborhood: "neighbourhood", center: "centre", centers: "centres", favor: "favour", favorite: "favourite", behavior: "behaviour", honor: "honour", labor: "labour", humor: "humour", theater: "theatre", organization: "organisation", analyze: "analyse", analyzed: "analysed", analyzing: "analysing" };
const AU_STEMS = /\b(realiz|organiz|recogniz|summariz|emphasiz|criticiz|apologiz|prioritiz|minimiz|maximiz|utiliz|customiz|specializ|finaliz|categoriz|generaliz|memoriz|standardiz|capitaliz|authoriz|familiariz|visualiz|stabiliz|socializ|penaliz|legitimiz)(e|es|ed|ing|ation|ations)\b/gi;
export function australian(text: string): string {
  return text.replace(AU_STEMS, (_m, stem: string, end: string) => stem.slice(0, -1) + "s" + end).replace(/\b[A-Za-z]+\b/g, w => { const au = AU_WORDS[w.toLowerCase()]; return au === undefined ? w : w[0] === w[0]!.toUpperCase() ? au[0]!.toUpperCase() + au.slice(1) : au; });
}
const CYR = /[А-Яа-яЁё]/;
/** the same spelling fix for every English string of a draft (strings with Cyrillic are left alone) */
export function australianDeep<T>(v: T): T {
  if (typeof v === "string") return (CYR.test(v) ? v : australian(v)) as T;
  if (Array.isArray(v)) return v.map(australianDeep) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, australianDeep(x)])) as T;
  return v;
}
/** "a"/"an" in front of the gap only fits options that start with a matching sound */
export const takesAn = (w: string): boolean => /^(?:[aeio]|u(?![nsi]))/i.test(w.trim()) && !/^(?:one|once)/i.test(w.trim()) || /^(?:hour|honest|honou?r|heir)/i.test(w.trim());
/** the article right before the gap, when every option has to agree with it; undefined when the options all fit */
export function articleMismatch(head: string, options: string[]): "a" | "an" | undefined {
  const article = /\b(a|an)\s*$/i.exec(head)?.[1]?.toLowerCase() as "a" | "an" | undefined;
  return article && options.some(o => takesAn(o) !== (article === "an")) ? article : undefined;
}
export const hasCyrillic = (s: string): boolean => CYR.test(s);
