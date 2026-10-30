// L03 Travel and public transport: embedded order, embedded whether, movement prepositions, perfect vs past, much/many.
export const L03 = {
  form: [
    ["tenses.perfect_vs_past", "tram", "The tram ___ ten minutes ago, so you have just missed it.", ["left", "has left", "leaves"], 0, "Слова ten minutes ago указывают на законченное время в прошлом.", "С указанием момента в прошлом (ten minutes ago) используется Past Simple: left."],
    ["tenses.perfect_vs_past", "terminal", "I ___ to the new bus terminal twice so far this month.", ["have been", "went", "was going"], 0, "Этот месяц ещё не закончился: so far.", "Период so far this month ещё продолжается, поэтому используется Present Perfect: have been.", "B2"],
    ["countability.much_many", "luggage", "How ___ luggage are you taking on the trip?", ["much", "many", "few"], 0, "Luggage — неисчисляемое существительное.", "С неисчисляемыми существительными в вопросе используется much: how much luggage.", "A2"],
    ["countability.much_many", "ferry", "There weren't ___ passengers on the early ferry.", ["many", "much", "a little"], 0, "Passengers — исчисляемое существительное во множественном числе.", "С исчисляемыми существительными во множественном числе в отрицании используется many.", "A2"],
    ["questions.embedded_whether", "express", "I'm not sure ___ the express service stops at this station or not.", ["whether", "that", "what"], 0, "Во вложенном вопросе без вопросительного слова нужен союз со значением «ли».", "Фраза or not показывает вопрос «да или нет», поэтому нужен союз whether."],
    ["questions.embedded_order", "fares", "Could you tell me how much ___?", ["the ticket costs", "does the ticket cost", "costs the ticket"], 0, "Во вложенном вопросе порядок слов прямой.", "После вводной части вопрос превращается в утверждение: how much the ticket costs, без does."],
    ["questions.embedded_order", "journey", "Do you know how long the journey ___?", ["takes", "does take", "take"], 0, "Во вложенном вопросе порядок слов прямой.", "После Do you know вопрос становится утверждением: how long the journey takes, без does.", "B1"],
  ],
  fragment: [
    ["prepositions.movement", "tunnel", "Water was dripping from the roof as we walked ___ the long tunnel.", ["through", "across", "among"], 0, "Движение внутри замкнутого пространства от одного конца к другому.", "Для движения сквозь тоннель используется through."],
    ["prepositions.movement", "harbour", "We took a ferry ___ the harbour to get to the other side.", ["across", "through", "between"], 0, "Движение с одного берега на другой.", "Для движения с одной стороны водного пространства на другую используется across."],
    ["prepositions.movement", "pier", "The ferry slowly moved ___ the pier and stopped.", ["towards", "through", "among"], 0, "Паром приближался к причалу.", "Для движения в направлении цели используется towards."],
    ["countability.much_many", "stops", "How ___ stops are there before the airport?", ["many", "much", "little"], 0, "Stops можно посчитать.", "С исчисляемыми существительными во множественном числе в вопросе используется many."],
    ["tenses.perfect_vs_past", "timetable", "The timetable has changed ___ last week's announcement.", ["since", "for", "during"], 0, "Указано событие, с которого всё началось.", "После слова с точкой отсчёта (событием) используется since.", "B2"],
    ["questions.embedded_whether", "platform", "She asked ___ the platform had changed.", ["whether", "that", "what"], 0, "Вопрос с ответом «да или нет» во вложенной форме.", "Для вложенного вопроса «да или нет» используется whether (или if).", "B2"],
    ["questions.embedded_order", "ferry", "She wanted to know ___ the next ferry left.", ["when", "when did", "when does"], 0, "После вводной части вопрос превращается в утверждение.", "Во вложенном вопросе нет вспомогательного глагола и обратного порядка слов: when the next ferry left.", "B1"],
  ],
  detect: [
    ["tenses.perfect_vs_past", "tickets", ["He ", "has booked", " the tickets yesterday afternoon."], 1, ["He booked the tickets yesterday afternoon."], "Какое время нужно со словом yesterday?", "С yesterday используется Past Simple: booked.", "A2"],
    ["countability.much_many", "luggage", ["She didn't bring ", "many", " luggage on the day trip."], 1, ["She didn't bring much luggage on the day trip."], "Luggage — неисчисляемое существительное.", "С неисчисляемым luggage используется much, а не many."],
    ["questions.embedded_order", "museum", ["Do you know ", "when does the museum close", " on weekends?"], 1, ["Do you know when the museum closes on weekends?"], "Во вложенном вопросе порядок слов прямой.", "После Do you know вопрос становится утверждением: when the museum closes, без does."],
    ["prepositions.movement", "bridge", ["The bus drove ", "through", " the bridge and then turned left."], 1, ["The bus drove across the bridge and then turned left."], "Мост пересекают, а не проходят сквозь него.", "Для движения по мосту с одной стороны на другую используется across, а не through."],
    ["questions.embedded_whether", "ferry", ["I wonder whether the ferry will run in this wind."], null, [], "Проверьте союз и порядок слов.", "Предложение верно: whether вводит вложенный вопрос, порядок слов прямой."],
    ["tenses.perfect_vs_past", "harbours", ["We have visited three different harbours since we arrived."], null, [], "Проверьте время и слово since.", "Предложение верно: Present Perfect с since и точкой отсчёта."],
  ],
  guided: [
    ["questions.embedded_whether", "trains", "Complete the sentence in your own words, starting with: I would like to know...", "Я хотел бы узнать, ходит ли этот поезд по воскресеньям. Начни: I would like to know…", ["I would like to know whether this train runs on Sundays.", "I would like to know if this train runs on Sundays.", "I would like to know whether this train runs on a Sunday.", "I would like to know whether this train operates on Sundays."], "Вложенный вопрос «да или нет»: союз и прямой порядок слов.", ["whether / if", "прямой порядок слов"], "Вложенный вопрос «да или нет» вводится whether или if, а порядок слов остаётся прямым."],
    ["tenses.perfect_vs_past", "trip", "Complete the sentence in your own words, starting with: Last month, we...", "В прошлом месяце мы поехали на поезде в Аделаиду. Начни: Last month, we…", ["Last month, we took the train to Adelaide.", "Last month, we travelled to Adelaide by train.", "Last month, we went to Adelaide by train.", "Last month, we caught the train to Adelaide."], "Last month — законченный период в прошлом.", ["Past Simple"], "С last month используется Past Simple: took, travelled, went."],
    ["prepositions.movement", "cycling", "Complete the sentence in your own words, starting with: The cyclists...", "Велосипедисты проехали через тоннель и выехали к реке. Начни: The cyclists…", ["The cyclists rode through the tunnel and came out near the river.", "The cyclists rode through the tunnel and reached the river.", "The cyclists went through the tunnel and came out by the river.", "The cyclists rode through the tunnel and came out by the river."], "Какой предлог нужен для движения сквозь тоннель?", ["through"], "Для движения сквозь тоннель используется through."],
  ],
  translate: [
    ["countability.much_many", "luggage", "У меня не так много багажа.", ["I don't have much luggage.", "I haven't got much luggage.", "I don't have much baggage.", "I haven't got much baggage."], "Багаж — неисчисляемое существительное.", "С неисчисляемым luggage в отрицании используется much.", "A2"],
    ["questions.embedded_order", "fares", "Вы не знаете, сколько стоит билет до аэропорта?", ["Do you know how much a ticket to the airport costs?", "Do you know how much the ticket to the airport costs?", "Could you tell me how much a ticket to the airport costs?", "Do you know how much a ticket to the airport is?"], "Вложенный вопрос: порядок слов как в утверждении.", "Во вложенном вопросе нет вспомогательного глагола: how much a ticket costs."],
    ["tenses.perfect_vs_past", "visit", "Мы были в этом городе в прошлом году.", ["We were in this city last year.", "We were in this town last year.", "We visited this city last year.", "We visited this town last year."], "Last year — законченное время в прошлом.", "С last year используется Past Simple: were или visited."],
  ],
  reading: [
    [
      "tenses.perfect_vs_past",
      "timetable-change",
      [
        "The regional rail operator has changed the weekend timetable on the coast line. The new timetable started last Saturday, and the first train now leaves Central twenty minutes later than before.",
        "Passengers travelling towards the airport now change trains at Eastwood and walk across the footbridge to platform 3. One passenger emailed the operator to ask whether the late service would still run on Sundays."
      ],
      [
        [
          "What does \"has changed\" suggest about the new timetable?",
          [
            "It is in use now.",
            "It was used only in the past.",
            "It has not been approved yet."
          ],
          0,
          "tenses.perfect_vs_past"
        ],
        [
          "How do airport passengers get to platform 3 at Eastwood?",
          [
            "They go over the tracks on a footbridge.",
            "They go under the tracks through a tunnel.",
            "They stay on the same train."
          ],
          0,
          "prepositions.movement"
        ],
        [
          "What did the passenger want to know?",
          [
            "If the late Sunday train was still running.",
            "How much the airport fare was.",
            "Why the first train left later."
          ],
          0,
          "questions.embedded_whether"
        ]
      ],
      "Обратите внимание на время глагола в первом предложении и на союз после ask.",
      "Has changed — Present Perfect: изменение произошло недавно и действует сейчас. Across the footbridge — по мосту над путями. Ask whether — пассажир спрашивал, будет ли поезд ходить по воскресеньям."
    ],
    [
      "countability.much_many",
      "ferry-guide",
      [
        "Before the school holidays, the ferry office received so many calls that it published a short guide. Most callers wanted to know how long the crossing takes and where they can leave their cars.",
        "The guide explains that the crossing takes about forty minutes. There isn't much parking near the wharf, so travellers are asked to come by bus if they can."
      ],
      [
        [
          "Which direct question did many callers ask?",
          [
            "How long does the crossing take?",
            "How long the crossing takes?",
            "How long does the crossing takes?"
          ],
          0,
          "questions.embedded_order"
        ],
        [
          "What does the guide say about parking near the wharf?",
          [
            "There is only a little of it.",
            "There are plenty of free spaces.",
            "It is closed during the holidays."
          ],
          0,
          "countability.much_many"
        ],
        [
          "Why did the office publish the guide?",
          [
            "It received a large number of calls.",
            "The crossing had become longer.",
            "The wharf had moved."
          ],
          0,
          "countability.much_many"
        ]
      ],
      "Calls можно посчитать, parking — нет. Как звучит прямой вопрос?",
      "So many calls — много звонков (calls исчисляемое); isn't much parking — мало парковки (parking неисчисляемое). Вложенный вопрос how long the crossing takes в прямой форме звучит How long does the crossing take?"
    ]
  ],
};
