// TASK_017: the starting-diagnostic bank (24 = 3 blocks x [3 recognition + 3 correction incl. >=1 "No mistake" + 2 short production], 24 DIFFERENT skills)
// and the held-out bank (24, the SAME 24 skills with entirely different sentences, consumed once, feedback only after a check). All 24 skills come from
// the pools of the ten lesson blueprints, so a skill that is practised can later be checked independently and compared with its starting baseline.
// Written by an AI agent and individually self-reviewed as an agent (D59). Neither bank shares a sentence with the practice bank.
export const DIAGNOSTIC = {
  form: [
    ["articles.indefinite", "transport", "My cousin has just bought ___ electric scooter.", ["an", "a", "some"], 0, "Слово electric начинается с гласного звука.", "Перед существительным с гласным звуком в начале и первым упоминанием предмета ставится an: an electric scooter.", "A2"],
    ["agreement.be_auxiliary", "shelves", "The books on the top shelf ___ mine.", ["are", "is", "am"], 0, "Подлежащее books стоит во множественном числе.", "Подлежащее books — множественное число, поэтому нужна форма are.", "A2"],
    ["tenses.perfect_vs_past", "rules", "The council ___ the new rules last Tuesday.", ["announced", "has announced", "announces"], 0, "Указан конкретный момент в прошлом.", "С указанием конкретного момента в прошлом (last Tuesday) используется Past Simple: announced."],
    ["countability.much_many", "study", "How ___ homework did you get this week?", ["much", "many", "few"], 0, "Homework — неисчисляемое существительное.", "С неисчисляемым homework в вопросе используется much: how much homework.", "A2"],
    ["relatives.defining", "airport", "The driver ___ took us to the airport was very friendly.", ["who", "which", "whose"], 0, "Речь о человеке, и слово заменяет подлежащее.", "Для человека в роли подлежащего придаточного используется who."],
    ["pronouns.reflexives", "boxes", "She hurt ___ while she was carrying the boxes.", ["herself", "her", "hers"], 0, "Действие вернулось к тому, кто его совершил.", "Когда подлежащее и объект — одно лицо, используется возвратное местоимение: herself."],
  ],
  fragment: [
    ["prepositions.wait_for", "station", "Passengers were told to wait ___ further instructions.", ["for", "to", "at"], 0, "Глагол wait требует определённого предлога.", "После wait перед объектом ожидания используется for: wait for further instructions."],
    ["linking.contrast", "exam", "He studied hard; ___, he failed the exam.", ["however", "therefore", "besides"], 0, "Результат противоречит ожиданию.", "Для противопоставления между предложениями используется however.", "B2"],
    ["verb_patterns.enjoy_doing", "winter", "My aunt enjoys ___ jigsaw puzzles in winter.", ["doing", "to do", "do"], 0, "После enjoy ставится форма на -ing.", "После enjoy используется герундий: enjoys doing.", "A2"],
  ],
  detect: [
    ["tenses.present_perfect", "suburb", ["She ", "is living", " in this city since she was a child."], 1, ["She has lived in this city since she was a child.", "She has been living in this city since she was a child."], "Слово since требует другого времени.", "С since используется Present Perfect: has lived или has been living."],
    ["modals.advice", "shoulder", ["You ", "ought", " see a physiotherapist about that shoulder."], 1, ["You ought to see a physiotherapist about that shoulder.", "You should see a physiotherapist about that shoulder."], "После ought нужен ещё один маленький элемент.", "После ought для совета нужен to: ought to see (или используйте should)."],
    ["passive.past", "bridge", ["The old bridge ", "built", " in the 1950s."], 1, ["The old bridge was built in the 1950s."], "Мост не строит сам, его построили.", "Здесь нужен пассив прошедшего времени: was built."],
    ["prepositions.explain_to", "machine", ["Could you ", "explain me", " how this machine works?"], 1, ["Could you explain to me how this machine works?", "Could you explain how this machine works to me?"], "Какой предлог вводит адресата объяснения?", "Адресат при explain вводится предлогом to: explain to me."],
    ["questions.direct_auxiliary", "suburb", ["How long ", "you have", " lived in this suburb?"], 1, ["How long have you lived in this suburb?"], "Порядок слов в прямом вопросе.", "В прямом вопросе вспомогательный глагол стоит перед подлежащим: have you."],
    ["word_order.adverbs", "languages", ["She ", "speaks very well", " English."], 1, ["She speaks English very well."], "Где стоит наречие образа действия?", "Наречие very well ставится после объекта: speaks English very well."],
    ["conditionals.first", "picnic", ["If it rains tomorrow, we will move the picnic indoors."], null, [], "Проверьте времена в обеих частях.", "Предложение верно: Present Simple в условной части и will в главной."],
    ["countability.mass_nouns", "office", ["The furniture in the new office is very comfortable."], null, [], "Проверьте согласование с furniture.", "Предложение верно: furniture неисчисляемое и согласуется с is."],
    ["questions.embedded_whether", "museum", ["She wants to know whether the museum is open on public holidays."], null, [], "Проверьте союз и порядок слов.", "Предложение верно: whether вводит вложенный вопрос с прямым порядком слов."],
  ],
  guided: [
    ["conditionals.second", "sea", "Complete the sentence in your own words, starting with: If I lived by the sea,...", "Если бы я жил у моря, я бы каждый день плавал. Начни: If I lived by the sea,…", ["If I lived by the sea, I would swim every day.", "If I lived by the sea, I'd swim every day.", "If I lived by the sea, I would go swimming every day.", "If I lived by the sea, I'd go swimming every day."], "Нужна главная часть с would.", ["would + инфинитив"], "Во втором условном предложении в главной части используется would + инфинитив."],
    ["reported_speech.statements", "workload", "Complete the sentence in your own words, starting with: She said that...", "Она сказала, что очень занята. Начни: She said that…", ["She said that she was very busy.", "She said that she was really busy.", "She said that she was extremely busy."], "В косвенной речи время сдвигается в прошлое.", ["was"], "В косвенной речи после said настоящее время сдвигается в прошедшее: was busy."],
    ["verb_patterns.think_of_doing", "moving", "Complete the sentence in your own words, starting with: They are thinking of...", "Они думают о том, чтобы переехать в Мельбурн. Начни: They are thinking of…", ["They are thinking of moving to Melbourne.", "They are thinking of relocating to Melbourne.", "They are thinking of moving to Melbourne next year."], "После предлога of нужна форма на -ing.", ["thinking of + -ing"], "После предлога of используется герундий: thinking of moving."],
  ],
  translate: [
    ["modals.polite_requests", "waiting", "Не могли бы вы подождать минутку?", ["Could you wait a moment?", "Could you wait a minute?", "Would you mind waiting a moment?", "Would you mind waiting a minute?", "Could you please wait a moment?"], "Вежливая просьба.", "Вежливая просьба выражается Could you… или Would you mind + герундий.", "A2"],
    ["tenses.past_continuous", "queue", "Пока я стоял в очереди, мне позвонил друг.", ["While I was standing in the queue, a friend called me.", "While I was standing in the queue, a friend phoned me.", "A friend called me while I was standing in the queue.", "A friend rang me while I was standing in the queue.", "While I was waiting in the queue, a friend called me."], "Длительное действие прервано коротким.", "Длительное действие на фоне события выражается Past Continuous: was standing."],
    ["articles.definite", "door", "Закройте, пожалуйста, дверь.", ["Please close the door.", "Could you close the door, please?", "Close the door, please.", "Please shut the door."], "Дверь известна обоим собеседникам.", "Конкретный предмет, известный обоим собеседникам, требует определённого артикля: the door.", "A2"],
  ],
};

export const HELDOUT = {
  form: [
    ["articles.indefinite", "work", "He applied for ___ internship at the museum.", ["an", "a", "some"], 0, "Слово internship начинается с гласного звука.", "Перед существительным с гласным звуком в начале и первым упоминанием предмета ставится an: an internship.", "A2"],
    ["agreement.be_auxiliary", "hall", "The windows in the hall ___ dirty.", ["are", "is", "am"], 0, "Подлежащее windows стоит во множественном числе.", "Подлежащее windows — множественное число, поэтому нужна форма are.", "A2"],
    ["tenses.perfect_vs_past", "moving", "My brother ___ to Tasmania in 2019.", ["moved", "has moved", "moves"], 0, "Указан конкретный год в прошлом.", "С указанием конкретного момента в прошлом (in 2019) используется Past Simple: moved."],
    ["countability.much_many", "trains", "We don't have ___ time before the train leaves.", ["much", "many", "few"], 0, "Time — неисчисляемое существительное.", "С неисчисляемым time в отрицании используется much.", "A2"],
    ["relatives.defining", "classroom", "The students ___ finished early can leave now.", ["who", "which", "whose"], 0, "Речь о людях, и слово заменяет подлежащее.", "Для людей в роли подлежащего придаточного используется who."],
    ["pronouns.reflexives", "animals", "The kitten taught ___ to climb the fence.", ["itself", "it", "its"], 0, "Котёнок сам выполнил действие над собой.", "Когда подлежащее и объект — одно существо, используется возвратное местоимение: itself."],
  ],
  fragment: [
    ["prepositions.wait_for", "results", "We are still waiting ___ the results of the test.", ["for", "to", "of"], 0, "Глагол wait требует определённого предлога.", "После wait перед объектом ожидания используется for: waiting for the results."],
    ["linking.contrast", "flat", "The flat is small; ___, it has a lovely view.", ["however", "therefore", "for example"], 0, "Вторая часть добавляет противоположное достоинство.", "Для противопоставления между предложениями используется however.", "B2"],
    ["verb_patterns.enjoy_doing", "garden", "Do your parents enjoy ___ in the garden?", ["working", "to work", "work"], 0, "После enjoy ставится форма на -ing.", "После enjoy используется герундий: enjoy working.", "A2"],
  ],
  detect: [
    ["tenses.present_perfect", "office", ["They ", "are working", " here since the beginning of the year."], 1, ["They have been working here since the beginning of the year.", "They have worked here since the beginning of the year."], "Слово since требует другого времени.", "С since используется Present Perfect: have been working или have worked."],
    ["modals.advice", "break", ["You ", "ought", " take a short break before you continue."], 1, ["You ought to take a short break before you continue.", "You should take a short break before you continue."], "После ought нужен ещё один маленький элемент.", "После ought для совета нужен to: ought to take (или используйте should)."],
    ["passive.past", "cleaning", ["The windows ", "cleaned", " yesterday morning by the staff."], 1, ["The windows were cleaned yesterday morning by the staff."], "Окна не моют сами, их помыли.", "Здесь нужен пассив прошедшего времени: were cleaned."],
    ["prepositions.explain_to", "tour", ["The guide ", "explained us", " the history of the building."], 1, ["The guide explained to us the history of the building.", "The guide explained the history of the building to us."], "Какой предлог вводит адресата объяснения?", "Адресат при explain вводится предлогом to: explained to us."],
    ["questions.direct_auxiliary", "phone", ["Why ", "you didn't", " call me last night?"], 1, ["Why didn't you call me last night?"], "Порядок слов в прямом вопросе.", "В прямом вопросе вспомогательный глагол стоит перед подлежащим: didn't you."],
    ["word_order.adverbs", "driving", ["He ", "drives carefully always", " on this road."], 1, ["He always drives carefully on this road."], "Где стоит наречие частоты?", "Наречие частоты always ставится перед смысловым глаголом: always drives carefully."],
    ["conditionals.first", "ferry", ["If you hurry, you will catch the early ferry."], null, [], "Проверьте времена в обеих частях.", "Предложение верно: Present Simple в условной части и will в главной."],
    ["countability.mass_nouns", "bus", ["The luggage was loaded onto the bus before nine."], null, [], "Проверьте согласование с luggage.", "Предложение верно: luggage неисчисляемое и согласуется с was."],
    ["questions.embedded_whether", "invitation", ["I'm not sure whether she has received the invitation."], null, [], "Проверьте союз и порядок слов.", "Предложение верно: whether вводит вложенный вопрос с прямым порядком слов."],
  ],
  guided: [
    ["conditionals.second", "car", "Complete the sentence in your own words, starting with: If I had a car,...", "Если бы у меня была машина, я бы ездил на работу сам. Начни: If I had a car,…", ["If I had a car, I would drive to work.", "If I had a car, I'd drive to work.", "If I had a car, I would drive myself to work.", "If I had a car, I'd drive myself to work."], "Нужна главная часть с would.", ["would + инфинитив"], "Во втором условном предложении в главной части используется would + инфинитив."],
    ["reported_speech.statements", "job", "Complete the sentence in your own words, starting with: He said that...", "Он сказал, что любит свою новую работу. Начни: He said that…", ["He said that he loved his new job.", "He said that he liked his new job.", "He said that he really liked his new job."], "В косвенной речи время сдвигается в прошлое.", ["loved / liked"], "В косвенной речи после said настоящее время сдвигается в прошедшее: loved, liked."],
    ["verb_patterns.think_of_doing", "classes", "Complete the sentence in your own words, starting with: She is thinking of...", "Она думает о том, чтобы записаться на курсы рисования. Начни: She is thinking of…", ["She is thinking of joining a drawing class.", "She is thinking of enrolling in a drawing class.", "She is thinking of signing up for a drawing class.", "She is thinking of taking a drawing class."], "После предлога of нужна форма на -ing.", ["thinking of + -ing"], "После предлога of используется герундий: thinking of joining."],
  ],
  translate: [
    ["modals.polite_requests", "questions", "Не могли бы вы повторить вопрос?", ["Could you repeat the question?", "Could you repeat the question, please?", "Would you mind repeating the question?", "Would you mind repeating that question?"], "Вежливая просьба.", "Вежливая просьба выражается Could you… или Would you mind + герундий.", "A2"],
    ["tenses.past_continuous", "rain", "Дети играли в саду, когда начался дождь.", ["The children were playing in the garden when it started to rain.", "The kids were playing in the garden when it started to rain.", "The children were playing in the garden when the rain started.", "When it started to rain, the children were playing in the garden."], "Длительное действие прервано коротким.", "Длительное действие на фоне события выражается Past Continuous: were playing."],
    ["articles.definite", "window", "Откройте, пожалуйста, окно.", ["Please open the window.", "Could you open the window, please?", "Open the window, please."], "Окно известно обоим собеседникам.", "Конкретный предмет, известный обоим собеседникам, требует определённого артикля: the window.", "A2"],
  ],
};
