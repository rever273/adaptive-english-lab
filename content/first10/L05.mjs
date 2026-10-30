// L05 Shopping and services: few/little, mass nouns, polite requests, past passive, demonstratives.
export const L05 = {
  form: [
    ["countability.few_little", "stock", "There's very ___ stock left, so please order soon.", ["little", "few", "a few"], 0, "Stock в этом значении неисчисляемое.", "С неисчисляемыми существительными используется little: very little stock.", "B1"],
    ["countability.few_little", "bookings", "We have only ___ appointments free on Friday.", ["a few", "a little", "much"], 0, "Appointments — исчисляемое существительное во множественном числе.", "С исчисляемыми существительными во множественном числе используется a few: only a few appointments."],
    ["countability.mass_nouns", "returns", "The shop gave me some useful ___ about the warranty.", ["information", "informations", "an information"], 0, "Information — неисчисляемое существительное.", "Information не имеет множественного числа и не употребляется с a/an: some useful information."],
    ["passive.past", "repairs", "The faulty heater ___ by the technician yesterday.", ["was repaired", "repaired", "has repaired"], 0, "Нагреватель не чинит сам, его чинят.", "Здесь нужен пассив прошедшего времени: was repaired.", "B2"],
    ["modals.polite_requests", "help", "___ you possibly help me carry this to the car?", ["Could", "Do", "Are"], 0, "Нужен модальный глагол для вежливой просьбы.", "Вежливая просьба строится с Could you…?", "A2"],
    ["pronouns.demonstratives", "clothes", "I like ___ jacket over there more than this one.", ["that", "those", "these"], 0, "Jacket в единственном числе, и он находится далеко.", "Для далёкого предмета в единственном числе используется that."],
  ],
  fragment: [
    ["pronouns.demonstratives", "clothes", "I'll take ___ blue shirt on the hanger over there.", ["that", "those", "these"], 0, "Shirt в единственном числе, и он находится далеко.", "Для далёкого предмета в единственном числе используется that."],
    ["passive.past", "orders", "Your order ___ packed this morning and posted at noon.", ["was", "were", "is"], 0, "Действие уже произошло в прошлом.", "Пассив прошедшего времени с подлежащим order в единственном числе: was packed.", "A2"],
    ["modals.polite_requests", "receipts", "Would you mind ___ the receipt in the bag?", ["putting", "to put", "put"], 0, "После Would you mind ставится форма на -ing.", "В вежливой просьбе Would you mind + герундий: Would you mind putting…?"],
    ["pronouns.demonstratives", "shoes", "Excuse me, how much are ___ sandals in the window?", ["those", "that", "this"], 0, "Sandals во множественном числе, и они далеко.", "Для далёких предметов во множественном числе используется those."],
    ["passive.past", "signs", "The old signs ___ replaced last summer.", ["were", "was", "are"], 0, "Знаки не заменяют сами, их заменили; подлежащее во множественном числе.", "Пассив прошедшего времени с подлежащим signs во множественном числе: were replaced.", "B1"],
    ["modals.polite_requests", "doors", "___ you mind holding the door for a moment?", ["Would", "Did", "Are"], 0, "Вежливая просьба с формой на -ing.", "Вежливая просьба Would you mind + герундий строится с would.", "B1"],
  ],
  detect: [
    ["countability.mass_nouns", "returns", ["We need some ", "informations", " about the return policy."], 1, ["We need some information about the return policy."], "Information — неисчисляемое существительное.", "Information не имеет множественного числа: нужно information.", "A2"],
    ["countability.few_little", "kitchen", ["There is ", "a few", " milk left in the carton."], 1, ["There is a little milk left in the carton."], "Milk — неисчисляемое существительное.", "С неисчисляемым milk используется a little, а не a few."],
    ["passive.past", "post", ["The parcels ", "delivered", " to the wrong address last week."], 1, ["The parcels were delivered to the wrong address last week."], "Посылки не доставляют сами, их доставили.", "Здесь нужен пассив прошедшего времени: were delivered."],
    ["modals.polite_requests", "shop", ["Could you ", "to show", " me the cheaper models, please?"], 1, ["Could you show me the cheaper models, please?"], "Нужен ли to после could?", "После could инфинитив используется без to: Could you show…?"],
    ["pronouns.demonstratives", "fruit", ["Those apples on the top shelf look fresher than these ones."], null, [], "Проверьте указательные местоимения.", "Предложение верно: those — далёкие яблоки, these — те, что рядом."],
    ["passive.past", "cleaning", ["The shop windows were cleaned every morning before opening."], null, [], "Проверьте форму пассива.", "Предложение верно: пассив прошедшего времени — were cleaned."],
  ],
  guided: [
    ["modals.polite_requests", "sizes", "Complete the sentence in your own words, starting with: Could you...", "Не могли бы вы проверить, есть ли этот размер на складе? Начни: Could you…", ["Could you check whether this size is in stock?", "Could you check if this size is in stock?", "Could you check whether you have this size in stock?", "Could you check if you have this size in stock?"], "После could идёт инфинитив без to.", ["Could you + инфинитив"], "Вежливая просьба: Could you + инфинитив без to."],
    ["passive.past", "post", "Complete the sentence in your own words, starting with: The cheque...", "Чек отправили по почте во вторник. Начни: The cheque…", ["The cheque was posted on Tuesday.", "The cheque was mailed on Tuesday.", "The cheque was sent on Tuesday.", "The cheque was sent by post on Tuesday."], "Чек не отправляет сам, его отправили.", ["was + третья форма"], "Пассив прошедшего времени: was posted, was sent."],
    ["countability.few_little", "closing", "Complete the sentence in your own words, starting with: We have...", "У нас осталось совсем мало времени до закрытия магазина. Начни: We have…", ["We have very little time before the shop closes.", "We have very little time before the store closes.", "We have little time before the shop closes.", "We have very little time left before the shop closes."], "Time здесь неисчисляемое.", ["little + неисчисляемое"], "С неисчисляемым time используется little."],
  ],
  translate: [
    ["countability.mass_nouns", "delivery", "Мне нужна информация о доставке.", ["I need some information about delivery.", "I need information about delivery.", "I need some information about the delivery.", "I need some information on delivery."], "Информация — неисчисляемое существительное.", "Information не имеет множественного числа и не употребляется с a/an.", "A2"],
    ["pronouns.demonstratives", "shoes", "Эти туфли удобнее, чем те.", ["These shoes are more comfortable than those.", "These shoes are more comfortable than those ones.", "These shoes are comfier than those."], "Эти — рядом, те — далеко; множественное число.", "Для близких предметов во множественном числе используется these, для далёких — those."],
    ["modals.polite_requests", "wrapping", "Не могли бы вы упаковать это отдельно?", ["Could you wrap this separately?", "Could you pack this separately?", "Would you mind wrapping this separately?", "Would you mind packing this separately?", "Could you please wrap this separately?"], "Вежливая просьба.", "Вежливая просьба выражается Could you… или Would you mind + герундий."],
  ],
};
