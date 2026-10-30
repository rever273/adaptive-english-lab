// L10 Mixed transfer review: embedded order, stop doing vs stop to do, perfect vs past, singular/plural, make vs do. New contexts only.
export const L10 = {
  form: [
    ["questions.embedded_order", "contract", "I'd like to know why ___ the contract yesterday.", ["she cancelled", "did she cancel", "cancelled she"], 0, "Во вложенном вопросе порядок слов прямой.", "После вводной части вопрос превращается в утверждение: why she cancelled, без did.", "B2"],
    ["verb_patterns.stop_doing_vs_stop_to_do", "news", "He stopped ___ to the radio news because it made him anxious.", ["listening", "to listen", "listen"], 0, "Он прекратил привычное действие.", "Stop doing означает «перестать делать»: stopped listening."],
    ["tenses.perfect_vs_past", "hobart", "She ___ in Hobart for six years now, and she still loves it.", ["has lived", "lived", "is living"], 0, "Она живёт там до сих пор.", "Действие началось в прошлом и продолжается, поэтому используется Present Perfect: has lived."],
    ["countability.singular_plural", "police", "The police ___ investigating the break-in last night.", ["were", "was", "is"], 0, "Police — слово, которое согласуется как множественное число.", "Существительное police употребляется с глаголом во множественном числе: were investigating."],
    ["collocations.make_do", "decision", "She had to ___ a difficult decision before the deadline.", ["make", "do", "have"], 0, "Устойчивое сочетание с существительным decision.", "С decision используется глагол make: make a decision."],
    ["collocations.make_do", "favour", "Could you ___ me a favour and lock the door?", ["do", "make", "take"], 0, "Устойчивое сочетание с существительным favour.", "С favour используется глагол do: do me a favour.", "A2"],
    ["questions.embedded_order", "passport", "I can't remember where ___ my passport.", ["I put", "did I put", "put I"], 0, "Во вложенном вопросе порядок слов прямой.", "После вводной части вопрос превращается в утверждение: where I put, без did.", "B1"],
    ["tenses.perfect_vs_past", "music", "I ___ that song since I was a teenager.", ["have loved", "loved", "love"], 0, "Слово since связывает прошлое с настоящим.", "С since используется Present Perfect: have loved.", "B2"],
  ],
  fragment: [
    ["questions.embedded_order", "exit", "Can you show me ___ the nearest exit is?", ["where", "where is", "where does"], 0, "После вводной части вопрос превращается в утверждение.", "Во вложенном вопросе нет обратного порядка слов: where the nearest exit is.", "B1"],
    ["verb_patterns.stop_doing_vs_stop_to_do", "rain", "The rain stopped ___ at about noon.", ["falling", "to fall", "fall"], 0, "Дождь прекратился.", "Stop doing означает «перестать делать»: the rain stopped falling.", "A2"],
    ["tenses.perfect_vs_past", "festival", "We ___ the festival twice since it moved to the waterfront.", ["have attended", "attended", "were attending"], 0, "Слово since связывает прошлое с настоящим.", "С since используется Present Perfect: have attended.", "B2"],
    ["countability.singular_plural", "tools", "The scissors ___ on the desk next to the stapler.", ["are", "is", "am"], 0, "Scissors — слово, которое всегда множественного числа.", "Существительное scissors согласуется с глаголом во множественном числе: are.", "B1"],
    ["collocations.make_do", "homework", "I need to ___ my homework before dinner.", ["do", "make", "take"], 0, "Устойчивое сочетание с homework.", "С homework используется глагол do: do homework.", "A2"],
    ["collocations.make_do", "renovation", "They ___ a lot of noise during the renovation.", ["made", "did", "took"], 0, "Устойчивое сочетание с noise.", "С noise используется глагол make: make noise."],
    ["questions.embedded_order", "building", "Can you tell me ___ the lift is?", ["where", "where is", "where does"], 0, "После вводной части вопрос превращается в утверждение.", "Во вложенном вопросе нет обратного порядка слов: where the lift is.", "B1"],
    ["verb_patterns.stop_doing_vs_stop_to_do", "dance", "The children stopped ___ as soon as the music ended.", ["dancing", "to dance", "dance"], 0, "Дети перестали делать то, что делали.", "Stop doing означает «перестать делать»: stopped dancing.", "A2"],
    ["tenses.perfect_vs_past", "cities", "He ___ in three different cities since he left school.", ["has lived", "lived", "was living"], 0, "Слово since связывает прошлое с настоящим.", "С since используется Present Perfect: has lived.", "B2"],
    ["tenses.perfect_vs_past", "museum", "We ___ the museum yesterday, and it was crowded.", ["visited", "have visited", "visit"], 0, "Слово yesterday указывает на законченное время.", "С yesterday используется Past Simple: visited.", "A2"],
  ],
  detect: [
    ["questions.embedded_order", "time", ["She asked me ", "what time was it", "."], 1, ["She asked me what time it was."], "Во вложенном вопросе порядок слов прямой.", "После asked вопрос превращается в утверждение: what time it was.", "B1"],
    ["verb_patterns.stop_doing_vs_stop_to_do", "baby", ["He stopped ", "to smoke", " when his daughter was born."], 1, ["He stopped smoking when his daughter was born."], "Он прекратил привычку.", "Когда действие прекращают, после stopped используется форма на -ing: stopped smoking."],
    ["tenses.perfect_vs_past", "film", ["We ", "have seen", " that film last Friday."], 1, ["We saw that film last Friday."], "Какое время нужно с last Friday?", "С указанием конкретного момента в прошлом (last Friday) используется Past Simple: saw.", "A2"],
    ["countability.singular_plural", "queue", ["There were three ", "child", " waiting at the front desk."], 1, ["There were three children waiting at the front desk."], "У слова child особая форма множественного числа.", "Множественное число слова child — children.", "A2"],
    ["collocations.make_do", "kitchen", ["He did the washing-up while she made the coffee."], null, [], "Проверьте глаголы do и make.", "Предложение верно: do the washing-up и make the coffee — устойчивые сочетания."],
    ["tenses.perfect_vs_past", "speech", ["I have never made a speech in front of so many people."], null, [], "Проверьте время.", "Предложение верно: опыт до настоящего момента выражается Present Perfect с never."],
    ["verb_patterns.stop_doing_vs_stop_to_do", "sugar", ["She stopped ", "to eat", " sugar when her doctor warned her."], 1, ["She stopped eating sugar when her doctor warned her."], "Она прекратила привычку.", "Когда действие прекращают, после stopped идёт форма на -ing: stopped eating."],
    ["questions.embedded_order", "repairs", ["I'd like to know how long the repairs will take."], null, [], "Проверьте порядок слов после how long.", "Предложение верно: во вложенном вопросе порядок слов прямой."],
  ],
  guided: [
    ["questions.embedded_order", "atm", "Complete the sentence in your own words, starting with: Could you tell me...", "Не могли бы вы сказать, где находится ближайший банкомат? Начни: Could you tell me…", ["Could you tell me where the nearest ATM is?", "Could you tell me where the nearest cash machine is?", "Could you tell me where the closest ATM is?", "Could you tell me where I can find an ATM?"], "Вложенный вопрос: порядок слов как в утверждении.", ["where + подлежащее + глагол"], "Во вложенном вопросе порядок слов прямой: where the nearest ATM is."],
    ["collocations.make_do", "chores", "Complete the sentence in your own words, starting with: I have to...", "Мне нужно сделать уборку и приготовить ужин. Начни: I have to…", ["I have to do the cleaning and make dinner.", "I have to do the cleaning and make the dinner.", "I have to do the housework and make dinner."], "Какие глаголы нужны с уборкой и ужином?", ["do the cleaning", "make dinner"], "Устойчивые сочетания: do the cleaning, make dinner."],
    ["tenses.perfect_vs_past", "tasmania", "Complete the sentence in your own words, starting with: I have...", "Я ещё ни разу не был в Тасмании. Начни: I have…", ["I have never been to Tasmania.", "I have never been to Tasmania before.", "I have not been to Tasmania yet.", "I have never visited Tasmania."], "Опыт до настоящего момента.", ["have + третья форма"], "Опыт до настоящего момента выражается Present Perfect: have never been."],
  ],
  translate: [
    ["verb_patterns.stop_doing_vs_stop_to_do", "calls", "Она перестала звонить ему по вечерам.", ["She stopped calling him in the evenings.", "She stopped phoning him in the evenings.", "She stopped ringing him in the evenings.", "She stopped calling him in the evening."], "Перестала — значит прекратила привычку.", "Stop doing означает «перестать делать»: stopped calling."],
    ["countability.singular_plural", "queue", "В очереди было много людей.", ["There were a lot of people in the queue.", "There were many people in the queue.", "There were lots of people in the queue.", "A lot of people were in the queue."], "People — множественное число.", "Слово people согласуется с глаголом во множественном числе: there were.", "A2"],
    ["collocations.make_do", "mistakes", "Я сделал несколько ошибок в тесте.", ["I made a few mistakes in the test.", "I made some mistakes in the test.", "I made several mistakes in the test.", "I made a few mistakes on the test."], "Какой глагол сочетается со словом mistakes?", "С mistakes используется глагол make: make a mistake.", "A2"],
  ],
  reading: [
    [
      "verb_patterns.stop_doing_vs_stop_to_do",
      "bakery",
      [
        "Last year a small bakery in Fremantle stopped selling bread in plastic bags. The owner says the change made a real difference: customers now bring their own bags, and the staff have much less rubbish to deal with.",
        "On busy mornings, many cyclists stop to buy a coffee on their way to work. The owner has made an effort to serve them quickly, and she has hired two more people since the summer."
      ],
      [
        [
          "What did the bakery do last year?",
          [
            "It no longer put bread in plastic bags.",
            "It paused to buy plastic bags.",
            "It began selling plastic bags."
          ],
          0,
          "verb_patterns.stop_doing_vs_stop_to_do"
        ],
        [
          "Why do many cyclists stop at the bakery?",
          [
            "To get a coffee.",
            "Because they have given up coffee.",
            "To repair their bikes."
          ],
          0,
          "verb_patterns.stop_doing_vs_stop_to_do"
        ],
        [
          "What does \"she has hired two more people since the summer\" tell us?",
          [
            "The new staff joined after the summer began and still work there.",
            "She hired them before the summer and they have left.",
            "She is only planning to hire them."
          ],
          0,
          "tenses.perfect_vs_past"
        ]
      ],
      "Сравните stopped selling и stop to buy.",
      "Stopped selling — перестала продавать (stop + -ing); stop to buy — останавливаются, чтобы купить (stop + to). Has hired … since the summer — Present Perfect: период с лета до сейчас. Make a difference, make an effort — устойчивые сочетания с make."
    ],
    [
      "countability.singular_plural",
      "museum-guide",
      [
        "The museum's new guide answers the questions that visitors ask most often. People usually want to know where the cloakroom is and how late the cafe stays open.",
        "The guide also explains that the police are patrolling the car park at night after several break-ins, and that staff do a safety check of every gallery before closing."
      ],
      [
        [
          "Which direct question do visitors often ask?",
          [
            "Where is the cloakroom?",
            "Where the cloakroom is?",
            "Where does the cloakroom is?"
          ],
          0,
          "questions.embedded_order"
        ],
        [
          "Who is patrolling the car park at night?",
          [
            "Police officers.",
            "The museum staff.",
            "A single security guard."
          ],
          0,
          "countability.singular_plural"
        ],
        [
          "What do staff do before closing?",
          [
            "They check every gallery for safety.",
            "They make a list of lost property.",
            "They clean the car park."
          ],
          0,
          "collocations.make_do"
        ]
      ],
      "Как превратить вложенный вопрос в прямой? С каким числом согласуется police?",
      "Where the cloakroom is — вложенный вопрос; прямой вопрос: Where is the cloakroom? The police are — police согласуется во множественном числе. Do a safety check — устойчивое сочетание с do."
    ]
  ],
};
