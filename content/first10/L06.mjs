// L06 Technology and public decisions: present passive, reported statements, third-person agreement, first conditional, politeness.
export const L06 = {
  form: [
    ["passive.present", "security", "New passwords ___ to staff every three months.", ["are issued", "issue", "are issuing"], 0, "Пароли не выдают сами, их выдают.", "Здесь нужен пассив настоящего времени: are issued."],
    ["reported_speech.statements", "library", "The librarian said that the new catalogue ___ ready the next day.", ["would be", "will be", "is"], 0, "В косвенной речи после said время сдвигается.", "После глагола в прошедшем времени will в косвенной речи меняется на would: would be.", "B2"],
    ["agreement.third_person", "devices", "Every device in the building ___ updated automatically.", ["is", "are", "were being"], 0, "Every требует единственного числа.", "После every существительное стоит в единственном числе, поэтому нужен глагол is."],
    ["conditionals.first", "support", "If the app crashes again, we ___ the support team.", ["will call", "would call", "called"], 0, "Условие реальное, результат относится к будущему.", "В условном предложении первого типа в главной части используется will + инфинитив."],
    ["register.politeness", "deadline", "I was wondering ___ you could extend the deadline.", ["if", "that", "what"], 0, "Вежливая просьба в форме косвенного вопроса.", "Вежливая просьба I was wondering if you could… строится с союзом if.", "B2"],
    ["passive.present", "survey", "The results of the survey ___ on the council website.", ["are published", "publish", "are publishing"], 0, "Результаты не публикуют сами, их публикуют.", "Подлежащее results стоит во множественном числе, поэтому нужен пассив are published."],
  ],
  fragment: [
    ["reported_speech.statements", "updates", "He said that he ___ the update the night before.", ["had installed", "has installed", "installs"], 0, "Действие произошло раньше момента, о котором говорится в прошлом.", "В косвенной речи действие, предшествующее прошедшему моменту, выражается Past Perfect: had installed.", "B2"],
    ["agreement.third_person", "software", "The software ___ regular updates to stay secure.", ["needs", "need", "are needing"], 0, "Software — неисчисляемое существительное в единственном числе.", "С подлежащим software в единственном числе в Present Simple глагол получает -s: needs."],
    ["conditionals.first", "council", "Unless the council ___ the plan, the new system will go ahead.", ["changes", "will change", "changed"], 0, "После unless будущее выражается настоящим временем.", "После unless и if в условной части используется Present Simple, а не will: changes.", "B2"],
    ["register.politeness", "meeting", "Would it be possible ___ the meeting to Thursday?", ["to move", "moving", "move"], 0, "После Would it be possible нужна форма с to.", "Вежливая просьба Would it be possible to + инфинитив."],
    ["passive.present", "feedback", "Public feedback ___ collected online and at the library.", ["is", "are", "has"], 0, "Feedback — неисчисляемое существительное.", "Неисчисляемое feedback согласуется с is: is collected."],
    ["reported_speech.statements", "council", "The mayor said that the council ___ the proposal the previous week.", ["had approved", "has approved", "approves"], 0, "Событие произошло раньше момента, о котором говорится в прошлом.", "В косвенной речи после said предшествующее действие выражается Past Perfect: had approved.", "B2"],
  ],
  detect: [
    ["passive.present", "portal", ["Applications ", "are submit", " through the new portal."], 1, ["Applications are submitted through the new portal."], "Какая форма глагола нужна в пассиве?", "В пассиве после are стоит третья форма глагола: are submitted."],
    ["reported_speech.statements", "meeting", ["She said that she ", "will join", " the meeting the next day."], 1, ["She said that she would join the meeting the next day."], "После said время сдвигается.", "В косвенной речи после said will меняется на would: would join."],
    ["agreement.third_person", "systems", ["Each of the new systems ", "have", " a different password."], 1, ["Each of the new systems has a different password."], "Each требует единственного числа.", "После each of подлежащее единственное: нужно has."],
    ["conditionals.first", "library", ["If the library ", "will open", " late, I will go after work."], 1, ["If the library opens late, I will go after work."], "Какое время нужно в части с if?", "В условной части первого типа после if используется Present Simple: opens."],
    ["register.politeness", "schedule", ["Would you mind sending me the updated schedule when you have a moment?"], null, [], "Проверьте форму после Would you mind.", "Предложение верно: Would you mind + герундий — вежливая просьба."],
    ["passive.present", "data", ["The data is stored securely and backed up every night."], null, [], "Проверьте форму пассива.", "Предложение верно: пассив настоящего времени — is stored, backed up."],
  ],
  guided: [
    ["conditionals.first", "outage", "Complete the sentence in your own words, starting with: If the system fails tonight,...", "Если система выйдет из строя сегодня вечером, технический специалист придёт утром. Начни: If the system fails tonight,…", ["If the system fails tonight, a technician will come in the morning.", "If the system fails tonight, a technician will come tomorrow morning.", "If the system fails tonight, the technician will come in the morning.", "If the system fails tonight, someone will fix it in the morning."], "В главной части нужно будущее время.", ["will + инфинитив"], "В условном предложении первого типа главная часть строится с will + инфинитив."],
    ["passive.present", "library", "Complete the sentence in your own words, starting with: Printed copies...", "Распечатанные копии выдаются у стойки регистрации. Начни: Printed copies…", ["Printed copies are given out at the front desk.", "Printed copies are handed out at the front desk.", "Printed copies are issued at the front desk."], "Копии не выдают сами, их выдают.", ["are + третья форма"], "Пассив настоящего времени: are given out, are handed out, are issued."],
    ["reported_speech.statements", "calls", "Complete the sentence in your own words, starting with: He said that...", "Он сказал, что позвонит нам на следующий день. Начни: He said that…", ["He said that he would call us the next day.", "He said that he would call us the following day.", "He said that he would phone us the next day.", "He said that he would ring us the next day."], "В косвенной речи will меняется.", ["would + инфинитив"], "В косвенной речи после said will меняется на would."],
  ],
  translate: [
    ["agreement.third_person", "offices", "В каждом офисе есть принтер.", ["Every office has a printer.", "Each office has a printer.", "There is a printer in every office.", "There is a printer in each office."], "Every требует единственного числа.", "После every и each существительное стоит в единственном числе, а глагол получает форму has.", "A2"],
    ["register.politeness", "files", "Не могли бы вы отправить мне файл сегодня?", ["Could you send me the file today?", "Would you be able to send me the file today?", "Would you mind sending me the file today?", "Could you please send me the file today?"], "Вежливая просьба.", "Вежливая просьба выражается Could you…, Would you be able to… или Would you mind + герундий."],
    ["reported_speech.statements", "time", "Она сказала, что у неё нет времени.", ["She said that she had no time.", "She said she had no time.", "She said that she didn't have time.", "She said she didn't have time."], "Косвенная речь: время сдвигается в прошлое.", "В косвенной речи после said глагол сдвигается в прошедшее время: had no time, didn't have time."],
  ],
  reading: [
    [
      "passive.present",
      "library-booking",
      [
        "The city library has introduced a new booking system for its study rooms. Rooms are now reserved online, and confirmation emails are sent automatically to each borrower.",
        "At the launch, the head librarian said that the old paper list had caused too many arguments. She also said that staff would help anyone who found the new system difficult."
      ],
      [
        [
          "Who sends the confirmation emails?",
          [
            "The system sends them automatically.",
            "Each borrower sends them.",
            "The head librarian sends them by hand."
          ],
          0,
          "passive.present"
        ],
        [
          "What did the head librarian say about the old paper list?",
          [
            "It had led to disagreements.",
            "It would be used again next year.",
            "It was easier than the new system."
          ],
          0,
          "reported_speech.statements"
        ],
        [
          "What did she promise?",
          [
            "Staff would support people who have trouble with the system.",
            "Study rooms would be free at weekends.",
            "Paper bookings would continue."
          ],
          0,
          "reported_speech.statements"
        ]
      ],
      "Кто выполняет действие в пассиве? Какие времена использованы после said?",
      "Are reserved, are sent — пассив: действие выполняют над комнатами и письмами, а не они сами. Said that … had caused, would help — косвенная речь со сдвигом времён: had caused — раньше, would help — обещание на будущее."
    ],
    [
      "conditionals.first",
      "recycling-app",
      [
        "The council's new recycling app sends a reminder the evening before each collection. Each household receives its own schedule, which depends on the street it is in.",
        "If a bin is missed, residents can report it in the app. The council suggests a polite message such as 'Would you mind checking our street again?' because it works better than an angry one. If a report arrives before ten in the morning, a truck will return the same day."
      ],
      [
        [
          "What happens if a missed bin is reported at nine in the morning?",
          [
            "A truck comes back on the same day.",
            "The bin is collected next week.",
            "The resident receives a fine."
          ],
          0,
          "conditionals.first"
        ],
        [
          "What does each household get?",
          [
            "A schedule of its own.",
            "A new bin every year.",
            "A reminder every morning."
          ],
          0,
          "agreement.third_person"
        ],
        [
          "Why does the council suggest the message 'Would you mind checking our street again?'",
          [
            "A polite request gets better results.",
            "It is the only message the app accepts.",
            "It gives the driver a direct order."
          ],
          0,
          "register.politeness"
        ]
      ],
      "Найдите условие с if и посмотрите, что произойдёт в результате.",
      "If a report arrives …, a truck will return — первое условное: реальное условие и результат в будущем. Each household receives its own — после each глагол в единственном числе. Would you mind + -ing — вежливая просьба."
    ]
  ],
};
