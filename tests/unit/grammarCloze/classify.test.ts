import { describe, expect, it } from "vitest";
import { classify, formOf, type ClozeInput } from "../../../apps/server/src/domain/grammarCloze/classify.js";
import { canonicalCards } from "../../../apps/server/src/domain/skills/cards.js";

const mk = (sourceTopic: string, gappedText: string, solution: string, distractors: string[]): ClozeInput => ({ sourceTopic, gappedText, solution, distractors, filledText: gappedText.replace("___", solution) });
const skill = (i: ClozeInput) => classify(i).skillId;

describe("conditionals", () => {
  const c = (g: string, s: string, d: string[]) => skill(mk("conditionals", g, s, d));
  it("zero, first, second, third and mixed", () => {
    expect(c("If you heat ice, it ___.", "melts", ["will melt", "melted"])).toBe("conditionals.zero");
    expect(c("If it rains tomorrow, we ___ at home.", "will stay", ["would stay", "stayed"])).toBe("conditionals.first");
    expect(c("If I had a car, I ___ you a lift.", "would give", ["will give", "gave"])).toBe("conditionals.second");
    expect(c("If she had studied, she ___ the exam.", "would have passed", ["would pass", "passed"])).toBe("conditionals.third");
    expect(c("If I had studied law, I ___ a lawyer now.", "would be", ["will be", "am"])).toBe("conditionals.mixed");
  });
  it("handles the clauses in reverse order, unless, and the gap in the if-clause", () => {
    expect(c("We ___ at home if it rains tomorrow.", "will stay", ["stayed", "would stay"])).toBe("conditionals.first");
    expect(c("We will stay home unless the weather ___.", "improves", ["will improve", "improved"])).toBe("conditionals.first");
    expect(c("If she ___ harder, she would pass the exam.", "studied", ["studies", "will study"])).toBe("conditionals.second");
    expect(c("She would have called if she ___ the number.", "had known", ["knew", "has known"])).toBe("conditionals.third");
  });
  it("refuses when the sentence is not clearly conditional", () => {
    expect(c("She ___ a book every week.", "reads", ["read", "reading"])).toBeNull();
    expect(c("I asked if she ___ ready.", "was", ["is", "will be"])).toBeNull();
    expect(c("I wonder if he ___ come.", "will", ["would", "does"])).toBeNull();
    expect(c("___ you go there, call me.", "If", ["Unless", "When"])).toBeNull();
  });
});

describe("tenses and agreement", () => {
  it("recognises verb group forms", () => {
    expect(formOf("has not finished")).toBe("present_perfect");
    expect(formOf("was playing")).toBe("past_continuous");
    expect(formOf("went")).toBe("past_simple");
    expect(formOf("will go")).toBe("future");
  });
  it("labels the tense the solution makes against other tenses", () => {
    expect(skill(mk("past_perfect", "When we arrived, the film ___ already.", "had started", ["started", "has started"]))).toBe("tenses.past_perfect");
    expect(skill(mk("past_simple", "She ___ to Perth last year.", "moved", ["moves", "has moved"]))).toBe("tenses.past_simple");
  });
  it("labels agreement when options differ only in the auxiliary or -s", () => {
    expect(skill(mk("present_continuous", "The children ___ reading the map.", "are", ["am", "is"]))).toBe("agreement.be_auxiliary");
    expect(skill(mk("present_simple", "She ___ tennis every Sunday.", "plays", ["play"]))).toBe("agreement.third_person");
    expect(skill(mk("present_simple", "Are there two pictures? - Yes, ___.", "there are", ["there is"]))).toBe("agreement.be_auxiliary");
  });
  it("refuses when the solution is not the form of its topic", () => {
    expect(skill(mk("past_simple", "A new museum ___ in May.", "was built", ["is built", "built"]))).toBeNull();
  });
  it("flags present perfect vs past simple without a time marker, not with one", () => {
    expect(classify(mk("present_perfect", "I ___ my keys.", "have lost", ["lost", "lose"])).riskFlags).toContain("perfect_vs_past_no_marker");
    expect(classify(mk("present_perfect", "I ___ my keys yesterday.", "lost", ["have lost", "lose"])).riskFlags).toEqual([]);
  });
});

describe("relatives, articles, modals, others", () => {
  it("labels relatives and flags interchangeable that/which and who/that", () => {
    const a = classify(mk("relatives", "The speaker told us about works ___ are known to us.", "that", ["where", "which"]));
    expect(a.skillId).toBe("relatives.relative_pronouns");
    expect(a.riskFlags).toContain("relative_that_which");
    expect(classify(mk("relatives", "The man ___ lives next door is kind.", "who", ["whom", "that"])).riskFlags).toContain("relative_who_that");
    const nd = classify(mk("relatives", "My brother, ___ lives in Perth, is a nurse.", "who", ["whom", "where"]));
    expect(nd.skillId).toBe("relatives.nondefining");
    expect(nd.riskFlags).toEqual([]);
  });
  it("labels articles", () => {
    expect(skill(mk("articles", "He is ___ honest man.", "an", ["a", "the"]))).toBe("articles.indefinite");
    expect(skill(mk("articles", "___ sun rises in the east.", "The", ["A", "An"]))).toBe("articles.definite");
  });
  it("labels modals by meaning and refuses unclear ones", () => {
    expect(skill(mk("modals", "You ___ see a doctor about that cough.", "should", ["can", "must"]))).toBe("modals.advice");
    expect(skill(mk("modals", "The light is on. He ___ be at home.", "must be", ["should be", "can be"]))).toBe("modals.deduction");
    expect(skill(mk("modals", "___ you help me with this bag?", "Could", ["Must", "Should"]))).toBe("modals.polite_requests");
    expect(skill(mk("modals", "Can I ___ you?", "help", ["is", "have"]))).toBeNull();
  });
  it("labels prepositions of time and place, and refuses the rest", () => {
    expect(skill(mk("prepositions", "We have a test ___ Monday.", "on", ["in", "at"]))).toBe("prepositions.time_at_on_in");
    expect(skill(mk("prepositions", "The keys are ___ the table.", "on", ["in", "at"]))).toBe("prepositions.place_at_on_in");
    expect(skill(mk("prepositions", "Congratulations ___ you.", "to", ["for", "with"]))).toBeNull();
  });
  it("labels pronouns, comparisons, quantifiers, non-finites and wh-words", () => {
    expect(skill(mk("personal_pronouns", "Help ___, please.", "yourself", ["you", "your"]))).toBe("pronouns.reflexives");
    expect(skill(mk("possessives", "Is this ___ pen?", "your", ["yours", "you"]))).toBe("possessives.determiners_pronouns");
    expect(skill(mk("comparisons", "This bag is ___ than that one.", "heavier", ["heaviest", "heavy"]))).toBe("comparisons.comparatives");
    expect(skill(mk("comparisons", "It was ___ day of the year.", "the hottest", ["hotter", "hot"]))).toBe("comparisons.superlatives");
    expect(skill(mk("quantifiers", "There is not ___ milk left.", "much", ["many", "few"]))).toBe("countability.much_many");
    expect(skill(mk("non_finites", "I enjoy ___ the guitar.", "playing", ["to play", "play"]))).toBe("verb_patterns.enjoy_doing");
    expect(skill(mk("non_finites", "She let me ___ early.", "leave", ["to leave", "leaving"]))).toBe("verb_patterns.make_let_bare");
    expect(skill(mk("wh_questions", "___ is your birthday?", "When", ["Where", "Who"]))).toBe("questions.wh_words");
  });
  it("only returns skills that exist in the canonical reference", () => {
    const ids = new Set(Object.keys(canonicalCards().skills));
    const samples = [mk("passive", "The road is being ___ today.", "repaired", ["repair"]), mk("passive", "The road ___ repaired last week.", "was", ["is", "were"]), mk("future_simple", "She ___ call you tomorrow.", "will", ["did", "has"]), mk("passive", "The door will ___ opened.", "be", ["is", "been"])];
    for (const s of samples) { const id = skill(s); if (id) expect(ids.has(id)).toBe(true); }
  });
});
