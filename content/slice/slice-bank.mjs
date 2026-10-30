// Non-release vertical-slice bank (TASK_007 / D20). 45 hand-written exercises, individually reviewed by an AI agent
// (see scripts/seed-slice.mjs for the recorded review identity). NOT the first-ten-lessons bank (TASK_017) and NOT release content.
// Compact definitions are expanded into full exercise-v1 objects; ids are derived from the key so seeding is idempotent.
import { createHash } from "node:crypto";

const uuidFrom = (key) => {
  const h = createHash("sha1").update(`english-lab-slice:${key}`).digest("hex");
  const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`;
};

export const base = (key, type, dimension, skill, topic, prompt, hints, explanation, payload) => ({
  schema_version: "exercise-v1",
  id: uuidFrom(key),
  revision: 1,
  status: "draft",
  target_skill: skill,
  additional_skills: [],
  dimension,
  difficulty: "B2",
  context_level: "B2",
  topic,
  context_id: `ctx-${key}`,
  template_cluster: `tpl-${key}`,
  bank_role: "practice",
  prompt_en: prompt,
  hints_ru: hints,
  explanation_ru: explanation,
  sources: [],
  provenance: { origin: "agent", model_tag: null, model_digest: null, prompt_version: "slice-bank-v1" },
  rubric_version: "rubric-v1",
  type,
  payload,
});

export const opts = (...texts) => texts.map((text, i) => ({ id: "abc"[i], text }));

// [skill, topic, prompt, [options], correctIndex, hint, explanation]
const FORM = [
  ["tenses.past_perfect", "work", "She ___ the report before the meeting started.", ["had finished", "has finished", "finishes"], 0, "Действие завершилось раньше другого прошедшего действия.", "Завершённое действие до другого момента в прошлом выражается Past Perfect: had finished."],
  ["conditionals.second", "transport", "If we left now, we ___ the last tram.", ["would catch", "will catch", "caught"], 0, "Условие нереальное или маловероятное (If + Past Simple).", "В условном предложении второго типа (If we left) в главной части используется would + глагол: would catch."],
  ["passive.present", "services", "The tickets ___ at the front desk.", ["are sold", "is sold", "sells"], 0, "Билеты не продают сами: действие совершают над ними.", "Здесь нужен пассив настоящего времени: are sold."],
  ["countability.much_many", "household", "There isn't ___ milk left in the fridge.", ["much", "many", "few"], 0, "Milk — неисчисляемое существительное.", "С неисчисляемыми существительными в отрицании используется much."],
  ["questions.embedded_whether", "office", "He asked me ___ I had finished the form.", ["whether", "that", "what"], 0, "Во вложенном вопросе без вопросительного слова нужен союз со значением «ли».", "Во вложенном общем вопросе используется whether (или if): asked me whether I had finished."],
  ["tenses.present_perfect", "housing", "I've lived in this suburb ___ 2019.", ["since", "for", "during"], 0, "После слова указана точка начала, а не период.", "С точкой отсчёта (2019) используется since; for употребляется с длительностью."],
  ["agreement.third_person", "school", "Every student ___ a locker in the new building.", ["has", "have", "are having"], 0, "Every требует единственного числа.", "После every существительное в единственном числе, поэтому глагол has."],
  ["relatives.relative_pronouns", "neighbours", "The man ___ lives next door is a retired teacher.", ["who", "which", "whose"], 0, "Речь о человеке, и слово заменяет подлежащее.", "Для человека в роли подлежащего используется who."],
  ["tenses.past_continuous", "home", "She was making dinner when the power ___.", ["went out", "has gone out", "goes out"], 0, "Короткое действие прервало длительное.", "Короткое прерывающее действие выражается Past Simple (went out), длительное — Past Continuous (was making)."],
  ["verb_patterns.suggest_doing", "work", "They suggested ___ the meeting to Friday.", ["moving", "to move", "move"], 0, "После suggest используется форма на -ing.", "После suggest ставится герундий: suggested moving."],
  ["modals.obligation", "safety", "You ___ wear a helmet on this site; it's a safety rule.", ["must", "might", "can"], 0, "Правило безопасности — это обязанность.", "Для обязанности, заданной правилом, используется must."],
  ["prepositions.interested_in", "hobbies", "He is interested ___ learning to sail.", ["in", "on", "at"], 0, "Устойчивое сочетание с прилагательным interested.", "Прилагательное interested употребляется с предлогом in: interested in learning."],
];

const FRAGMENT = [
  ["prepositions.wait_for", "transport", "We are waiting ___ the bus to arrive.", ["for", "to", "at"], 0, "Глагол wait требует определённого предлога.", "После wait перед объектом используется for: waiting for the bus."],
  ["prepositions.explain_to", "tourism", "The guide explained the rules ___ the visitors.", ["to", "for", "with"], 0, "Кому объясняли — предлог для адресата.", "Адресат при explain вводится предлогом to: explained the rules to the visitors."],
  ["prepositions.depend_on", "events", "The result depends ___ the weather on the day.", ["on", "of", "from"], 0, "Устойчивое сочетание с глаголом depend.", "Глагол depend требует предлога on."],
  ["prepositions.time_at_on_in", "work", "The meeting is scheduled ___ Tuesday morning.", ["on", "in", "at"], 0, "С днями недели используется один предлог.", "С днями недели и частями конкретного дня (Tuesday morning) используется on."],
  ["prepositions.place_at_on_in", "travel", "She arrived ___ the airport just before midnight.", ["at", "to", "in"], 0, "Прибытие в конкретное место-пункт.", "С глаголом arrive и пунктом (airport) используется at."],
  ["prepositions.movement", "travel", "We drove ___ the bridge and into the city.", ["across", "between", "among"], 0, "Движение с одной стороны на другую.", "Для движения через поверхность или мост используется across."],
  ["verb_patterns.enjoy_doing", "hobbies", "She really enjoys ___ in the garden on weekends.", ["working", "to work", "work"], 0, "После enjoy ставится форма на -ing.", "После enjoy используется герундий: enjoys working."],
  ["collocations.natural_phrases", "events", "The speech made a strong impression ___ the audience.", ["on", "at", "in"], 0, "Устойчивое сочетание: впечатление на кого-то.", "Выражение make an impression используется с предлогом on: impression on the audience."],
  ["verb_patterns.would_rather", "plans", "Would you rather stay home ___ go out tonight?", ["or", "than", "nor"], 0, "Нужен союз выбора между двумя вариантами.", "В вопросе с выбором между вариантами используется or."],
  ["linking.contrast", "tours", "The tour was long, ___ everyone enjoyed it.", ["but", "so", "because"], 0, "Вторая часть противопоставлена первой.", "Для противопоставления используется but."],
  ["linking.cause", "sport", "The match was cancelled ___ the heavy rain.", ["because of", "because", "although"], 0, "После слова стоит существительное, а не предложение.", "Перед существительной группой причина вводится because of."],
  ["articles.indefinite", "office", "She made ___ appointment for next week.", ["an", "a", "the"], 0, "Слово начинается с гласного звука, и предмет назван впервые.", "Перед appointment (гласный звук) при первом упоминании используется неопределённый артикль an."],
];

// [skill, topic, segments[], faultyIndex | null (no mistake), corrections[], hint, explanation]
const DETECT = [
  ["prepositions.interested_in", "learning", ["They are interested ", "for", " learning more about the project."], 1, ["They are interested in learning more about the project."], "Проверьте предлог после interested.", "Прилагательное interested употребляется с предлогом in, а не for."],
  ["agreement.do_auxiliary", "work", ["She ", "don't", " usually work on Fridays."], 1, ["She doesn't usually work on Fridays."], "Посмотрите на подлежащее she.", "С she вспомогательный глагол — doesn't, а не don't."],
  ["collocations.natural_phrases", "meetings", ["We discussed ", "about", " the new schedule yesterday."], 1, ["We discussed the new schedule yesterday."], "Нужен ли предлог после discuss?", "Глагол discuss употребляется без предлога: discussed the schedule."],
  ["conditionals.first", "plans", ["If ", "I will see", " him, I will tell him."], 1, ["If I see him, I will tell him."], "Какое время стоит в условной части?", "В условном предложении первого типа в части с if используется Present Simple, а не will."],
  ["countability.much_many", "queues", ["There are ", "too much", " people in the queue."], 1, ["There are too many people in the queue."], "People — исчисляемое слово во множественном числе.", "С people (исчисляемое множественное число) используется many, а не much: too many people."],
  ["tenses.perfect_vs_past", "errands", ["He ", "has gone", " to the shop yesterday."], 1, ["He went to the shop yesterday."], "Слово yesterday указывает на законченное время.", "С yesterday используется Past Simple (went), а не Present Perfect."],
  ["countability.mass_nouns", "reports", ["The information ", "were", " very useful."], 1, ["The information was very useful."], "Information — неисчисляемое существительное.", "Неисчисляемое существительное information согласуется с глаголом в единственном числе: was."],
  ["questions.embedded_order", "directions", ["She asked me ", "where was the station", "."], 1, ["She asked me where the station was."], "Во вложенном вопросе порядок слов прямой.", "Во вложенном вопросе порядок слов повествовательный: where the station was."],
  ["questions.embedded_whether", "museum", ["Do you know whether the museum opens on Mondays?"], null, [], "Проверьте порядок слов после whether.", "Предложение верно: после whether идёт прямой порядок слов."],
  ["tenses.present_perfect", "council", ["She has worked at the council since 2018."], null, [], "Проверьте сочетание времени и since.", "Предложение верно: Present Perfect с since и точкой начала."],
  ["verb_patterns.would_rather", "transport", ["I'd rather walk than wait for the bus."], null, [], "Проверьте форму глагола после would rather.", "Предложение верно: после would rather стоит инфинитив без to, а сравнение вводится than."],
  ["passive.past", "events", ["The tickets were sold out within an hour."], null, [], "Проверьте форму пассива.", "Предложение верно: пассив прошедшего времени — were sold."],
];

const GUIDED = [
  ["verb_patterns.stop_doing_vs_stop_to_do", "health", "Complete the sentence in your own words, starting with: He stopped...", "Он перестал курить два года назад. Начни: He stopped…", ["He stopped smoking two years ago.", "He stopped smoking about two years ago."], "Прекращённое действие после stop выражается формой на -ing.", ["stop + -ing"], "Прекращённое действие после stop — герундий: stopped smoking."],
  ["conditionals.second", "study", "Complete the sentence in your own words, starting with: If I had more time,...", "Если бы у меня было больше времени, я бы выучил язык. Начни: If I had more time,…", ["If I had more time, I would learn the language.", "If I had more time, I'd learn the language."], "В главной части нужен would.", ["would + инфинитив"], "Условное второго типа: If + Past Simple, would + глагол."],
  ["passive.past", "city", "Complete the sentence in your own words, starting with: The bridge...", "Мост построили в 1998 году. Начни: The bridge…", ["The bridge was built in 1998."], "Действие совершили над мостом.", ["пассив прошедшего времени"], "Пассив прошедшего времени: was built."],
  ["modals.advice", "wellbeing", "Complete the sentence in your own words, starting with: You...", "Посоветуй коллеге отдохнуть. Начни: You…", ["You should take a break.", "You should have a rest.", "You should get some rest."], "Для совета используется специальный модальный глагол.", ["модальный глагол совета"], "Совет выражается модальным глаголом should."],
];

const TRANSLATE = [
  ["questions.embedded_whether", "museum", "Не знаете ли вы, открыт ли музей по понедельникам?", ["Do you know whether the museum is open on Mondays?", "Do you know if the museum is open on Mondays?"], "Вложенный вопрос: прямой порядок слов.", "Во вложенном вопросе после whether или if порядок слов прямой."],
  ["tenses.present_perfect", "work", "Я работаю здесь с 2020 года.", ["I have worked here since 2020.", "I've worked here since 2020.", "I have been working here since 2020."], "Действие началось в прошлом и продолжается.", "Для действия, начавшегося в прошлом и продолжающегося сейчас, используется Present Perfect с since."],
  ["reported_speech.statements", "office", "Она сказала, что опоздает.", ["She said that she would be late.", "She said she would be late."], "Косвенная речь: сдвиг времени.", "В косвенной речи will после глагола в прошедшем времени меняется на would."],
  ["modals.polite_requests", "office", "Не могли бы вы закрыть окно?", ["Could you close the window?", "Could you please close the window?", "Would you mind closing the window?"], "Вежливая просьба.", "Вежливая просьба выражается Could you… или Would you mind + -ing."],
  ["countability.mass_nouns", "study", "Мне нужен совет.", ["I need some advice.", "I need advice.", "I need a piece of advice."], "Advice неисчисляемое существительное.", "Advice неисчисляемое: без артикля a и без множественного числа."],
];

export const rubric = (meaning, markers, variation, reject) => ({ meaning_ru: meaning, target_markers: markers, acceptable_variation_ru: variation, reject_conditions_ru: reject });

export function buildSliceBank() {
  const out = [];
  FORM.forEach(([skill, topic, prompt, o, c, hint, expl], i) =>
    out.push(base(`form-${i + 1}`, "choose_form", "recognition", skill, topic, prompt, [hint], expl, { options: opts(...o), accepted_option_ids: ["abc"[c]], multiple: false })),
  );
  FRAGMENT.forEach(([skill, topic, prompt, o, c, hint, expl], i) =>
    out.push(base(`fragment-${i + 1}`, "choose_missing_fragment", "recognition", skill, topic, prompt, [hint], expl, { options: opts(...o), accepted_option_ids: ["abc"[c]], multiple: false })),
  );
  DETECT.forEach(([skill, topic, segs, bad, corrections, hint, expl], i) => {
    const sentence = segs.join("");
    out.push(
      base(`detect-${i + 1}`, "detect_error", "correction", skill, topic, "Find the part of the sentence that contains a mistake, or choose No mistake.", [hint], expl, {
        sentence,
        segments: segs.map((text, k) => ({ id: `s${k + 1}`, text })),
        accepted_segment_ids: bad === null ? [] : [`s${bad + 1}`],
        no_mistake: bad === null,
        corrections,
        optional_correction: bad !== null,
      }),
    );
  });
  GUIDED.forEach(([skill, topic, prompt, cue, answers, hint, markers, expl], i) =>
    out.push(base(`guided-${i + 1}`, "guided_short_answer", "production", skill, topic, prompt, [hint], expl, {
      cue_ru: cue,
      max_words: 15,
      accepted_answers: answers,
      rubric: rubric(cue.split(". Начни")[0] + ".", markers, "Допустимы близкие естественные формулировки с той же грамматикой.", "Неверная целевая форма не принимается."),
      allow_voice: true,
    })),
  );
  TRANSLATE.forEach(([skill, topic, cue, answers, hint, expl], i) =>
    out.push(base(`translate-${i + 1}`, "russian_to_english_short", "production", skill, topic, "Translate the idea into natural English.", [hint], expl, {
      cue_ru: cue,
      max_words: 15,
      accepted_answers: answers,
      rubric: rubric(cue, ["целевая грамматическая форма"], "Допустимы другие естественные формулировки с той же грамматикой.", "Неверная целевая форма не принимается."),
      allow_voice: true,
    })),
  );
  return out;
}

export const SLICE_BLUEPRINT = {
  key: "slice-everyday-mix",
  policy: {
    schema_version: "blueprint-policy-v1",
    title: "Everyday mix (non-release slice)",
    quotas: { choose_form: 5, choose_missing_fragment: 5, detect_error: 5, guided_short_answer: 1, russian_to_english_short: 2 },
    readingBlocks: 0,
    skillPool: [],
  },
};

export const SLICE_REVIEWER = "agent:claude-sonnet-5-5@task-007-slice-review";
