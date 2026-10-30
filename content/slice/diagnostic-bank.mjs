// Non-release DIAGNOSTIC and HELD-OUT banks for the vertical slice (TASK_013, D53). Written by an AI agent (claude-sonnet-5-5) and individually
// reviewed by the same agent family in seed-slice (recorded as an AGENT, never as a human). They exist to exercise the diagnostic protocol and the
// held-out checks end to end; they are NOT the 24 + 24 independent tasks the final protocol needs (TASK_017) and not release content.
// Diagnostic bank: exactly 24 items = 3 blocks x (3 recognition + 3 correction incl. >=1 "No mistake" + 2 short production), 24 DIFFERENT skills.
import { base, opts, rubric } from "./slice-bank.mjs";

const mark = (item, role) => ({ ...item, bank_role: role });

// [skill, topic, prompt, [options], correctIndex, hint, explanation]
const D_FORM = [
  ["articles.indefinite", "engineering", "She works as ___ engineer at the council.", ["an", "a", "some"], 0, "Слово engineer начинается с гласного звука.", "Перед словом с гласным звуком используется an: an engineer."],
  ["tenses.past_simple", "food", "We ___ the new menu at the cafe yesterday.", ["tried", "have tried", "try"], 0, "Слово yesterday указывает на законченное время в прошлом.", "С указанным прошедшим временем (yesterday) используется Past Simple: tried."],
  ["agreement.be_auxiliary", "office", "The keys to the storeroom ___ on the front desk.", ["are", "is", "am"], 0, "Подлежащее keys стоит во множественном числе.", "Подлежащее keys — множественное число, поэтому нужен глагол are."],
  ["countability.few_little", "time", "We have ___ time left, so please hurry.", ["little", "few", "many"], 0, "Time — неисчисляемое существительное.", "С неисчисляемыми существительными используется little, а few — с исчисляемыми."],
  ["conditionals.first", "transport", "If the train is late, we ___ a taxi.", ["will take", "would take", "took"], 0, "Условие реальное, результат относится к будущему.", "В условном предложении первого типа в главной части используется will + глагол."],
  ["relatives.defining", "family", "The woman ___ called this morning is my aunt.", ["who", "which", "whose"], 0, "Речь о человеке, и слово заменяет подлежащее.", "Для человека в роли подлежащего используется who."],
];
const D_FRAGMENT = [
  ["modals.deduction", "home", "The lights are on, so someone ___ be home.", ["must", "can't", "would"], 0, "Свет включён — это основание для уверенного вывода.", "Для уверенного вывода по признаку используется must be."],
  ["prepositions.listen_to", "safety", "Please listen ___ the instructions carefully.", ["to", "at", "for"], 0, "Глагол listen требует определённого предлога.", "После listen перед объектом используется to."],
  ["verb_patterns.want_to", "restaurant", "I would like ___ a table for two this evening.", ["to book", "booking", "book"], 0, "После would like нужна форма с to.", "После would like ставится инфинитив с to: would like to book."],
];

// [skill, topic, segments[], faultyIndex | null, corrections[], hint, explanation]
const D_DETECT = [
  ["tenses.present_perfect", "housing", ["She ", "have", " lived in this street since 2019."], 1, ["She has lived in this street since 2019."], "Проверьте вспомогательный глагол при she.", "С she используется has: She has lived."],
  ["questions.direct_auxiliary", "work", ["What time ", "you finish", " work on Fridays?"], 1, ["What time do you finish work on Fridays?"], "В прямом вопросе нужен вспомогательный глагол.", "В вопросе с what time перед подлежащим стоит do: What time do you finish."],
  ["word_order.adverbs", "news", ["He ", "reads always", " the news before breakfast."], 1, ["He always reads the news before breakfast."], "Где стоит наречие частоты?", "Наречие частоты ставится перед смысловым глаголом: always reads."],
  ["reported_speech.questions", "parking", ["She asked me ", "where did I park", " the car."], 1, ["She asked me where I had parked the car.", "She asked me where I parked the car."], "В косвенном вопросе порядок слов прямой.", "В косвенном вопросе нет вспомогательного did и порядок слов как в утверждении: where I parked."],
  ["pronouns.reflexives", "kitchen", ["He cut ", "him", " while he was chopping vegetables."], 1, ["He cut himself while he was chopping vegetables."], "Кто совершил действие и кто пострадал?", "Когда действие направлено на самого себя, используется возвратное местоимение himself."],
  ["linking.concession", "weather", ["The match went ahead ", "despite of", " the rain."], 1, ["The match went ahead despite the rain."], "Проверьте сочетание со словом despite.", "Despite употребляется без of: despite the rain."],
  ["modals.polite_requests", "office", ["Could you send me the final report by Friday?"], null, [], "Проверьте форму вежливой просьбы.", "Предложение верно: could + you + глагол — вежливая просьба."],
  ["relatives.nondefining", "retirement", ["My manager, who lives in Perth, is retiring next year."], null, [], "Проверьте запятые и слово who.", "Предложение верно: дополнительная информация о человеке отделена запятыми и вводится who."],
  ["tenses.future_forms", "travel", ["I will call you when I arrive at the station."], null, [], "Проверьте время после when.", "Предложение верно: после when в придаточном времени используется Present Simple (arrive), а не will."],
];

const D_GUIDED = [
  ["verb_patterns.make_let_bare", "work", "Complete the sentence in your own words, starting with: The manager let us...", "Начальник разрешил нам уйти пораньше. Начни: The manager let us…", ["The manager let us leave early.", "The manager let us go home early.", "The manager let us finish early."], "После let глагол стоит без to.", ["let us + глагол без to"], "После let + объект глагол используется без to: let us leave."],
  ["conditionals.third", "travel", "Complete the sentence in your own words, starting with: If we had left earlier,...", "Если бы мы вышли раньше, мы бы успели на поезд. Начни: If we had left earlier,…", ["If we had left earlier, we would have caught the train.", "If we had left earlier, we would have made the train."], "Нереальное прошлое: Past Perfect в условии.", ["if + Past Perfect, would have + причастие"], "В условном предложении третьего типа: if + had + причастие, would have + причастие."],
  ["passive.past", "city", "Complete the sentence in your own words, starting with: The new library...", "Новую библиотеку открыл мэр на прошлой неделе. Начни: The new library…", ["The new library was opened by the mayor last week."], "Библиотеку открыли — действие совершено над ней.", ["was/were + причастие"], "Пассив прошедшего времени: was opened (by ...)."],
];
const D_TRANSLATE = [
  ["questions.embedded_order", "directions", "Не подскажете, где находится ближайшая аптека?", ["Could you tell me where the nearest pharmacy is?", "Do you know where the nearest pharmacy is?"], "Во вложенном вопросе порядок слов прямой.", "Во вложенном вопросе после where идёт прямой порядок слов: where the nearest pharmacy is."],
  ["tenses.past_perfect", "station", "Когда я пришёл, поезд уже ушёл.", ["When I arrived, the train had already left.", "The train had already left when I arrived."], "Одно прошлое действие произошло раньше другого.", "Более раннее действие выражается Past Perfect: had already left."],
  ["collocations.make_do", "deadlines", "Мне нужно принять решение до пятницы.", ["I need to make a decision by Friday.", "I have to make a decision by Friday.", "I need to make a decision before Friday."], "Какой глагол сочетается со словом decision?", "Устойчивое сочетание: make a decision."],
];

// ---- held-out bank: different sentences, same skills where useful; consumed once, feedback only after the block ----
const H_FORM = [
  ["agreement.be_auxiliary", "office", "The documents on my desk ___ confidential.", ["are", "is", "am"], 0, "Подлежащее documents — множественное число.", "Подлежащее documents требует глагола are."],
  ["articles.indefinite", "electrics", "My brother works as ___ electrician in Darwin.", ["an", "a", "some"], 0, "Electrician начинается с гласного звука.", "Перед словом с гласным звуком используется an."],
  ["conditionals.first", "news", "If she calls tonight, I ___ her the good news.", ["will tell", "would tell", "told"], 0, "Условие реальное, результат относится к будущему.", "В условном предложении первого типа: will + глагол."],
];
const H_DETECT = [
  ["tenses.present_perfect", "work", ["They ", "has", " finished the report already."], 1, ["They have finished the report already."], "Проверьте согласование с they.", "С they используется have: They have finished."],
  ["word_order.adverbs", "sport", ["She ", "plays often", " tennis on Sundays."], 1, ["She often plays tennis on Sundays."], "Где стоит наречие частоты?", "Наречие частоты ставится перед смысловым глаголом: often plays."],
  ["pronouns.reflexives", "children", ["The children dressed themselves and went outside to play."], null, [], "Проверьте возвратное местоимение.", "Предложение верно: действие направлено на самих детей, поэтому themselves."],
];
const H_GUIDED = [
  ["verb_patterns.suggest_doing", "airport", "Complete the sentence in your own words, starting with: She suggested...", "Она предложила поехать в аэропорт на такси. Начни: She suggested…", ["She suggested taking a taxi to the airport.", "She suggested going to the airport by taxi."], "После suggest используется форма на -ing.", ["suggest + -ing"], "После suggest ставится герундий: suggested taking."],
];
const H_TRANSLATE = [
  ["tenses.past_perfect", "phone", "Я уже поел, когда он позвонил.", ["I had already eaten when he called.", "I had already eaten when he rang."], "Одно прошлое действие произошло раньше другого.", "Более раннее действие выражается Past Perfect: had already eaten."],
];

export function buildDiagnosticBank() {
  const out = [];
  D_FORM.forEach(([skill, topic, prompt, o, c, hint, expl], i) => out.push(mark(base(`diag-form-${i + 1}`, "choose_form", "recognition", skill, topic, prompt, [hint], expl, { options: opts(...o), accepted_option_ids: ["abc"[c]], multiple: false }), "diagnostic")));
  D_FRAGMENT.forEach(([skill, topic, prompt, o, c, hint, expl], i) => out.push(mark(base(`diag-fragment-${i + 1}`, "choose_missing_fragment", "recognition", skill, topic, prompt, [hint], expl, { options: opts(...o), accepted_option_ids: ["abc"[c]], multiple: false }), "diagnostic")));
  D_DETECT.forEach(([skill, topic, segs, bad, corrections, hint, expl], i) =>
    out.push(mark(base(`diag-detect-${i + 1}`, "detect_error", "correction", skill, topic, "Find the part of the sentence that contains a mistake, or choose No mistake.", [hint], expl, { sentence: segs.join(""), segments: segs.map((text, k) => ({ id: `s${k + 1}`, text })), accepted_segment_ids: bad === null ? [] : [`s${bad + 1}`], no_mistake: bad === null, corrections, optional_correction: bad !== null }), "diagnostic")),
  );
  D_GUIDED.forEach(([skill, topic, prompt, cue, answers, hint, markers, expl], i) =>
    out.push(mark(base(`diag-guided-${i + 1}`, "guided_short_answer", "production", skill, topic, prompt, [hint], expl, { cue_ru: cue, max_words: 15, accepted_answers: answers, rubric: rubric(cue.split(". Начни")[0] + ".", markers, "Допустимы близкие естественные формулировки с той же грамматикой.", "Неверная целевая форма не принимается."), allow_voice: true }), "diagnostic")),
  );
  D_TRANSLATE.forEach(([skill, topic, cue, answers, hint, expl], i) =>
    out.push(mark(base(`diag-translate-${i + 1}`, "russian_to_english_short", "production", skill, topic, "Translate the idea into natural English.", [hint], expl, { cue_ru: cue, max_words: 15, accepted_answers: answers, rubric: rubric(cue, ["целевая грамматическая форма"], "Допустимы другие естественные формулировки с той же грамматикой.", "Неверная целевая форма не принимается."), allow_voice: true }), "diagnostic")),
  );
  return out;
}

export function buildHeldoutBank() {
  const out = [];
  H_FORM.forEach(([skill, topic, prompt, o, c, hint, expl], i) => out.push(mark(base(`held-form-${i + 1}`, "choose_form", "recognition", skill, topic, prompt, [hint], expl, { options: opts(...o), accepted_option_ids: ["abc"[c]], multiple: false }), "heldout")));
  H_DETECT.forEach(([skill, topic, segs, bad, corrections, hint, expl], i) =>
    out.push(mark(base(`held-detect-${i + 1}`, "detect_error", "correction", skill, topic, "Find the part of the sentence that contains a mistake, or choose No mistake.", [hint], expl, { sentence: segs.join(""), segments: segs.map((text, k) => ({ id: `s${k + 1}`, text })), accepted_segment_ids: bad === null ? [] : [`s${bad + 1}`], no_mistake: bad === null, corrections, optional_correction: bad !== null }), "heldout")),
  );
  H_GUIDED.forEach(([skill, topic, prompt, cue, answers, hint, markers, expl], i) =>
    out.push(mark(base(`held-guided-${i + 1}`, "guided_short_answer", "production", skill, topic, prompt, [hint], expl, { cue_ru: cue, max_words: 15, accepted_answers: answers, rubric: rubric(cue.split(". Начни")[0] + ".", markers, "Допустимы близкие естественные формулировки с той же грамматикой.", "Неверная целевая форма не принимается."), allow_voice: true }), "heldout")),
  );
  H_TRANSLATE.forEach(([skill, topic, cue, answers, hint, expl], i) =>
    out.push(mark(base(`held-translate-${i + 1}`, "russian_to_english_short", "production", skill, topic, "Translate the idea into natural English.", [hint], expl, { cue_ru: cue, max_words: 15, accepted_answers: answers, rubric: rubric(cue, ["целевая грамматическая форма"], "Допустимы другие естественные формулировки с той же грамматикой.", "Неверная целевая форма не принимается."), allow_voice: true }), "heldout")),
  );
  return out;
}
