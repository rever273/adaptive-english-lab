// Vocabulary Practice starter pack (vocabulary TZ): short exercises for a few common dictionary words, and the FORMAT that later vocabulary
// packs copy. Written by an AI agent; published only with an independent review manifest (npm run pack -- publish vocab-starter --review ...).
// Exercises are offered only for words that are in the learner's own dictionary (matched by vocabulary.target.lemma).
//
// Three families, one format each (the Practice screen labels them by format):
//   recognition()  -> choose_missing_fragment: one gap, 4 options of the same part of speech and form, one fits the context
//   recall()       -> guided_short_answer:     one gap ___ in the sentence, the learner types the word; every acceptable answer listed
//   collocation()  -> choose_form:             the natural partner word / preposition of the target
// Every option carries rationaleRu: why it fits, or why it is not the best choice HERE (never "wrong everywhere").
import { createHash } from "node:crypto";

export const AUTHOR = "agent:claude-sonnet-5-5@vocab-author-v2";
const PROMPT_VERSION = "vocab-starter-v2";
// a nominal taxonomy skill: vocabulary sessions write no grammar skill evidence (assessments there create no skill opportunities)
const SKILL = "collocations.natural_phrases";

const uuidFrom = (key) => {
  const h = createHash("sha1").update(`english-lab-vocab:${key}`).digest("hex");
  const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`;
};


// Russian for the feedback after an answer: the whole sentence and the word as it stands in it (the page colours it). Revision 2 of the pack.
const TR = {
  "home-rec-1": ["Спустя десять лет маленький деревянный домик по-прежнему кажется всей семье родным домом.", "родным домом"],
  "home-rec-2": ["Многие пожилые австралийцы хотят как можно дольше оставаться дома, а не переезжать в дом престарелых.", "оставаться дома"],
  "home-col-1": ["Соседи с самой первой недели помогли нам почувствовать себя как дома.", "как дома"],
  "endeavour-rec-1": ["Создание общественного сада было долгим начинанием, на которое ушло два года выходных всей улицы.", "долгим начинанием"],
  "endeavour-rec-2": ["Столь подробное картирование рифа стало выдающимся научным начинанием совсем небольшой команды.", "научным начинанием"],
  "endeavour-verb-1": ["Совет постарается ответить на каждое письменное обращение в течение десяти рабочих дней.", "постарается"],
  "endeavour-col-1": ["Наша служба поддержки старается решать каждую заявку в тот же день, когда она зарегистрирована.", "старается"],
  "dog-rec-1": ["Наши соседи взяли собаку из приюта, которая лает на каждую чайку во время утренней прогулки по пляжу.", "собаку"],
  "dog-rec-2": ["Пожалуйста, всегда держите собаку на поводке на детской площадке.", "собаку"],
  "dog-col-1": ["Сегодня твоя очередь выгуливать собаку; я делал это вчера и позавчера.", "выгуливать собаку"],
  "great-rec-1": ["Новая трамвайная линия очень сильно изменила то, сколько времени мне нужно на дорогу до работы.", "очень сильно изменила"],
  "great-rec-2": ["Было просто замечательно наконец встретиться вживую с коллегами, которых я видел только на видеозвонках.", "замечательно"],
  "great-col-1": ["Она потратила очень много времени на проверку цифр перед заседанием совета.", "очень много времени"],
};

function item(key, type, dimension, topic, prompt, hint, explanation, payload, vocabulary) {
  return {
    schema_version: "exercise-v1",
    id: uuidFrom(key),
    revision: 2,
    status: "draft",
    target_skill: SKILL,
    additional_skills: [],
    dimension,
    difficulty: "B2",
    context_level: "B2",
    topic: `vocab:${topic}`,
    context_id: `ctx-vocab-${key}`,
    template_cluster: `tpl-vocab-${key}`,
    bank_role: "practice",
    prompt_en: prompt,
    hints_ru: [hint],
    explanation_ru: explanation,
    sources: [],
    provenance: { origin: "agent", model_tag: null, model_digest: null, prompt_version: PROMPT_VERSION },
    rubric_version: "rubric-v1",
    type,
    payload,
    vocabulary: { schemaVersion: "vocabulary-practice-v1", ...vocabulary, ...(TR[key] ? { sentenceRu: TR[key][0], wordRu: TR[key][1] } : {}) },
  };
}

const target = (lemma, pos, sense, form) => ({ entryId: lemma, lemma, senseId: `${lemma}.${pos}.${sense}`, partOfSpeech: pos, surfaceForm: form ?? lemma });
const options = (list) => list.map(([text, rationaleRu], i) => ({ id: "abcd"[i], text, rationaleRu }));

/** [key, topic, sentence with ___, [[option, why], ...] (first = correct), hint, explanation, target] */
export function recognition(key, topic, prompt, opts, hint, explanation, t) {
  const o = options(opts);
  return item(key, "choose_missing_fragment", "recognition", topic, prompt, hint, explanation, { options: o.map(({ id, text }) => ({ id, text })), accepted_option_ids: ["a"], multiple: false }, { family: "recognition", target: t, options: o, acceptedOptionId: "a" });
}
export function collocation(key, topic, prompt, pattern, opts, hint, explanation, t) {
  const o = options(opts);
  return item(key, "choose_form", "recognition", topic, prompt, hint, explanation, { options: o.map(({ id, text }) => ({ id, text })), accepted_option_ids: ["a"], multiple: false }, { family: "collocation", target: t, pattern, options: o, acceptedOptionId: "a" });
}
/** cue: the controlled clue shown with the task (Russian meaning + first letter); answers: every acceptable word */
export function recall(key, topic, prompt, cue, answers, meaning, hint, explanation, t) {
  return item(key, "guided_short_answer", "production", topic, prompt, hint, explanation, {
    cue_ru: cue,
    max_words: 1,
    accepted_answers: answers,
    rubric: { meaning_ru: meaning, target_markers: [t.lemma], acceptable_variation_ru: answers.length > 1 ? `Принимаются: ${answers.join(", ")}.` : "Принимается только это слово.", reject_conditions_ru: "Другое слово или неверная форма не принимаются." },
    allow_voice: false,
  }, { family: "guided_recall", target: t, guidedCue: cue, expectedWords: 1, acceptedAnswers: answers });
}

const HOME = target("home", "noun", "1");
const ENDEAVOUR_N = target("endeavour", "noun", "1");
const ENDEAVOUR_V = target("endeavour", "verb", "1");
const DOG = target("dog", "noun", "1");
const GREAT = target("great", "adjective", "1");
// "great" = excellent is a different sense from "great" = large (great difference, a great deal of)
const GREAT_EXCELLENT = target("great", "adjective", "2");

export const pack = {
  name: "vocab-starter",
  author: AUTHOR,
  blueprints: [],
  items: [
    // home
    recognition("home-rec-1", "housing", "Ten years on, the little weatherboard cottage still feels like ___ to the whole family.",
      [["home", "Подходит: feel like home — «ощущается как родной дом», речь о чувстве принадлежности."], ["shelter", "Shelter — укрытие от непогоды или опасности, а не место, к которому привязаны."], ["property", "Property — недвижимость как имущество; «ощущается как имущество» здесь не по смыслу."], ["accommodation", "Accommodation — временное жильё (гостиница, съёмная комната), без чувства «родного»."]],
      "Речь о чувстве, а не о типе жилья.", "Feel like home — устойчивое выражение: место ощущается родным. Остальные слова описывают жильё как укрытие, имущество или временное размещение.", HOME),
    recall("home-rec-2", "ageing", "Many older Australians want to stay at ___ for as long as possible rather than move into aged care.",
      "Одно слово на «h»: «дома» в выражении stay at …", ["home"], "Многие пожилые австралийцы хотят как можно дольше жить дома, а не переезжать в дом престарелых.",
      "Устойчивое выражение «оставаться дома».", "Stay at home — «оставаться (жить) дома». С house так не говорят: at house звучит неверно.", HOME),
    collocation("home-col-1", "neighbours", "Our neighbours made us feel ___ home from the very first week.", "feel at home",
      [["at", "Подходит: feel at home — «чувствовать себя как дома»."], ["in", "In home так не говорят; в этом выражении нужен предлог at."], ["to", "To указывает направление (go home без предлога), здесь не подходит."], ["by", "By home — не сочетание английского языка."]],
      "Устойчивое выражение «чувствовать себя как дома».", "Feel at home — фиксированное сочетание с предлогом at.", HOME),

    // endeavour (noun)
    recognition("endeavour-rec-1", "community", "Building the community garden was a long ___ that took the whole street two years of weekends.",
      [["endeavour", "Подходит: endeavour — серьёзное начинание, требующее долгих усилий."], ["complaint", "Complaint — жалоба; жалоба не строится два года выходными."], ["shortcut", "Shortcut — короткий путь; противоречит «long … two years»."], ["reminder", "Reminder — напоминание, а не долгая совместная работа."]],
      "Речь о деле, на которое ушли годы совместного труда.", "Endeavour (сущ.) — серьёзное, долгое начинание или усилие. Контекст «long… two years of weekends» исключает остальные варианты.", ENDEAVOUR_N),
    recall("endeavour-rec-2", "science", "Mapping the reef in such detail was a remarkable scientific ___ by a very small team.",
      "Одно слово на «e»: книжное «смелое, серьёзное начинание» (существительное); в Австралии пишется с -our.", ["endeavour", "endeavor"], "Подробное картирование рифа было выдающимся научным начинанием очень небольшой команды.",
      "Существительное после scientific; британское/австралийское написание с -our.", "A scientific endeavour — «научное начинание». Американское написание endeavor тоже принимается.", ENDEAVOUR_N),

    // endeavour (verb)
    recall("endeavour-verb-1", "public services", "The council will ___ to reply to every written submission within ten working days.",
      "Одно слово на «e»: официально «постараться, приложить усилия» (глагол).", ["endeavour", "endeavor"], "Совет постарается ответить на каждое письменное обращение в течение десяти рабочих дней.",
      "После will нужен глагол в начальной форме; официальный стиль.", "Endeavour to do something — официальное «стараться, прилагать усилия». После will — начальная форма глагола.", ENDEAVOUR_V),
    collocation("endeavour-col-1", "it support", "Our support team endeavours ___ resolve every ticket on the same day it is logged.", "endeavour to + infinitive",
      [["to", "Подходит: endeavour to do — после глагола endeavour идёт инфинитив с to."], ["at", "At не используется после глагола endeavour."], ["for", "For + существительное (strive for success), но не перед глаголом resolve."], ["with", "With здесь не образует сочетания с endeavour."]],
      "Подумайте, как этот официальный синоним try соединяется со следующим глаголом.", "Глагол endeavour управляет инфинитивом: endeavour to resolve.", ENDEAVOUR_V),

    // dog
    recognition("dog-rec-1", "pets", "Our neighbours adopted a rescue ___ that barks at every seagull on their morning walk along the beach.",
      [["dog", "Подходит: лает (barks) собака."], ["cat", "Кошку тоже берут из приюта, но кошки не лают."], ["rabbit", "Кролик не лает и обычно не гуляет по пляжу."], ["horse", "Лошадь не лает; гулять с ней по пляжу можно, но barks исключает этот вариант."]],
      "Обратите внимание на глагол barks.", "Rescue dog — собака из приюта. Глагол barks (лает) однозначно указывает на собаку.", DOG),
    recall("dog-rec-2", "parks", "Please keep your ___ on a lead in the playground area at all times.",
      "Одно слово на «d»: домашнее животное, которое лает.", ["dog", "dogs"], "Пожалуйста, держите собаку на поводке на детской площадке.",
      "On a lead — на поводке.", "Keep your dog on a lead — «держите собаку на поводке». Принимается и dogs.", DOG),
    collocation("dog-col-1", "household", "It's your turn to ___ the dog tonight; I did it yesterday and the day before.", "walk the dog",
      [["walk", "Подходит: walk the dog — «выгуливать собаку»."], ["chase", "Chase the dog — «гоняться за собакой», это не ежедневная обязанность по уходу."], ["drive", "Drive the dog — «везти собаку на машине»; так не говорят о прогулке."], ["pull", "Pull the dog — «тянуть собаку», а не выгуливать её."]],
      "Ежедневная обязанность владельца собаки.", "Walk the dog — устойчивое сочетание: выгуливать собаку.", DOG),

    // great
    recognition("great-rec-1", "transport", "The new tram line has made a ___ difference to how long it takes me to get to work.",
      [["great", "Подходит: make a great difference — «очень сильно изменить»."], ["high", "High сочетается с level, price, standard, но не с make a … difference."], ["strong", "Strong сочетается с effect, influence, но не с make a … difference."], ["long", "Long описывает длину и время; a long difference — не сочетание английского языка."]],
      "Какое прилагательное сочетается с make a … difference?", "Make a great difference — естественное сочетание «сильно изменить» (чаще всего говорят make a big difference). High, strong и long с difference в этом выражении не сочетаются.", GREAT),
    recall("great-rec-2", "work", "It was absolutely ___ to finally meet the colleagues I had only ever seen on video calls.",
      "Одно слово на «g»: «замечательно, здорово» (прилагательное).", ["great"], "Было просто замечательно наконец встретиться с коллегами, которых я видел только на видеозвонках.",
      "После absolutely нужно сильное прилагательное.", "Absolutely great — «просто замечательно». Absolutely сочетается с сильными прилагательными, поэтому good здесь не подходит.", GREAT_EXCELLENT),
    collocation("great-col-1", "office", "She spent a great ___ of time checking the figures before the board meeting.", "a great deal of",
      [["deal", "Подходит: a great deal of time — «очень много времени»."], ["piece", "A piece of — «кусок, часть»; a great piece of time не говорят."], ["number", "A great number of — со счётными существительными; time здесь неисчисляемое."], ["range", "A great range of time — не сочетание английского языка."]],
      "Устойчивое выражение со значением «много» для неисчисляемого.", "A great deal of + неисчисляемое существительное (time) — «много».", GREAT),
  ],
};
