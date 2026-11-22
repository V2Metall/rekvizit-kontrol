// Движок «Реквизит-контроль»: прозрачные правила, без обращения к внешним сервисам.
// Каждый сработавший признак даёт баллы и объяснение; итог — сумма баллов.
var RK = (function () {
  var FREE_MAIL = ['gmail.com', 'mail.ru', 'yandex.ru', 'ya.ru', 'bk.ru', 'list.ru', 'inbox.ru',
    'rambler.ru', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'proton.me', 'protonmail.com', 'gmx.com'];

  var LEVELS = [
    { min: 50, id: 'high', name: 'Высокий риск', action: 'Не платить. Позвонить контрагенту по номеру из справочника и сообщить руководителю.' },
    { min: 25, id: 'mid', name: 'Требует проверки', action: 'Приостановить оплату до подтверждения звонком по номеру из справочника.' },
    { min: 0, id: 'low', name: 'Низкий риск', action: 'Можно провести после стандартной сверки реквизитов.' }
  ];
  var THRESHOLD = 25; // с этого балла запрос считается подозрительным (для метрик)

  var RX = {
    urgency: /(срочн|сегодня|до конца дня|немедленн|в течение часа|незамедлительн|последний день|иначе отгрузк|сорв[её]тся|штраф|urgent|asap|immediately|today)/i,
    secrecy: /(не звоните|не звонить|никому (пока )?не сообщ|не сообщайте|держ[а-яёa-z]* (информацию )?в тайне|не обсуждайте|не ставьте в копию|только по почте|не отвечайте на звонки|на старый (телефон|номер) не звоните|вопрос конфиденциальный|строго конфиденциально|keep (this|it) confidential|do not call)/i,
    reason: /(арест|заблокирован|блокировк|аудит|проверк[а-яёa-z]* банка|реорганизац|санкци|сменил[а-яёa-z]* банк|смен[а-яёa-z]* банк|переходим на расч|временно недоступ|счёт недоступ|сч[её]т закры)/i,
    representative: /(личный сч[её]т|на сч[её]т (нашего )?представител|на карту|физическ[а-яёa-z]* лиц)/i
  };

  function digits(s) { return String(s || '').replace(/\D/g, ''); }

  function lev(a, b) {
    var m = a.length, n = b.length, d = [], i, j;
    for (i = 0; i <= m; i++) { d[i] = [i]; }
    for (j = 0; j <= n; j++) { d[0][j] = j; }
    for (i = 1; i <= m; i++) for (j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[m][n];
  }

  function accountKeyOk(bik, acc) {
    if (!/^\d{9}$/.test(bik) || !/^\d{20}$/.test(acc)) return null;
    var s = bik.slice(-3) + acc, w = [7, 1, 3], sum = 0;
    for (var i = 0; i < s.length; i++) sum += (+s[i]) * w[i % 3];
    return sum % 10 === 0;
  }

  function innOk(inn) {
    inn = digits(inn);
    function chk(ds, w) { var s = 0; for (var i = 0; i < w.length; i++) s += ds[i] * w[i]; return s % 11 % 10; }
    var d = inn.split('').map(Number);
    if (inn.length === 10) return chk(d, [2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[9];
    if (inn.length === 12) return chk(d, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[10] && chk(d, [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[11];
    return false;
  }

  function core(domain) { return domain.replace(/\.(test|ru|com|рф|net|org)$/i, ''); }

  // req: {vendor, channel, sender, phoneInMessage, bankName, bik, account, country, recipientInn, text}
  function analyze(req) {
    var flags = [], info = [], v = req.vendor || null;
    function add(id, pts, title, detail, src) { flags.push({ id: id, pts: pts, title: title, detail: detail, src: src || '' }); }
    var text = String(req.text || '');
    var channel = req.channel || 'email';

    // 1. Контрагент
    if (!v) add('unknown', 20, 'Получателя нет в справочнике контрагентов', 'Платёж новому получателю по просьбе из письма, звонка или мессенджера — базовый сценарий подмены.', 'SRC-097');

    // 2. Отправитель (почта)
    var sender = String(req.sender || '').trim().toLowerCase();
    if (channel === 'email') {
      if (!sender) info.push('Адрес отправителя не указан — проверка домена пропущена.');
      else {
        var dom = sender.split('@')[1] || '';
        var nonAscii = /[^\x00-\x7f]/.test(dom);
        if (v) {
          var vdom = v.domain.toLowerCase();
          var vFree = FREE_MAIL.indexOf(vdom) >= 0;
          if (nonAscii) add('homoglyph', 40, 'В адресе есть буквы другого алфавита', 'Домен «' + dom + '» содержит кириллические символы, похожие на латинские. На глаз отличить нельзя.', 'SRC-046');
          else if (vFree) {
            if (v.email && sender !== v.email.toLowerCase()) add('mailbox', 30, 'Адрес не совпадает с адресом из справочника', 'Контрагент пишет с бесплатной почты, но не с того ящика, что в справочнике (' + v.email + ').', 'SRC-046');
          } else if (dom === vdom || dom.slice(-(vdom.length + 1)) === '.' + vdom) {
            info.push('Домен отправителя совпадает со справочником (' + vdom + '). Это не гарантия: ящик могли взломать.');
          } else {
            var a = core(dom), b = core(vdom);
            var base = b.split(/[-.]/)[0];
            var dist = lev(a.replace(/[-.]/g, ''), b.replace(/[-.]/g, ''));
            if (FREE_MAIL.indexOf(dom) >= 0) add('freemail', 30, 'Корпоративный контрагент пишет с бесплатной почты', 'В справочнике домен ' + vdom + ', письмо пришло с ' + dom + '.', 'SRC-046');
            else if (dist <= 2 || (base.length >= 4 && a.indexOf(base) >= 0)) add('lookalike', 40, 'Домен-двойник', 'Домен «' + dom + '» похож на «' + vdom + '» из справочника, но не совпадает.', 'SRC-046');
            else add('domain', 30, 'Домен отправителя не из справочника', 'В справочнике ' + vdom + ', письмо пришло с ' + dom + '.', 'SRC-046');
          }
        } else if (nonAscii) add('homoglyph', 40, 'В адресе есть буквы другого алфавита', 'Домен «' + dom + '» содержит нелатинские символы.', 'SRC-046');
      }
    }

    // 3. Канал и телефон
    var ph = digits(req.phoneInMessage);
    var vph = v ? digits(v.phone) : '';
    if (channel === 'messenger') add('messenger', 10, 'Запрос пришёл в мессенджере', 'Мессенджеры легко подделать: новый номер, чужое фото, голосовое сообщение.', 'SRC-088');
    if (channel === 'phone' || channel === 'messenger') {
      if (v && ph && ph !== vph) add('callerid', 20, 'Звонок или сообщение не с номера из справочника', 'Номер ' + req.phoneInMessage + ' не совпадает с ' + v.phone + '. Голос можно синтезировать.', 'SRC-007');
      if (v && ph && ph === vph) info.push('Номер звонившего совпадает со справочником.');
    } else if (v && ph && ph !== vph) add('newphone', 15, 'В сообщении новый номер для связи', 'Предлагают звонить на ' + req.phoneInMessage + ', а в справочнике ' + v.phone + '. Звонить нужно только по номеру из справочника.', 'SRC-007');

    // 4. Реквизиты
    var country = (req.country || 'RU').toUpperCase();
    var acc = digits(req.account), bik = digits(req.bik);
    if (v && country === 'RU' && acc === digits(v.account) && bik === v.bik) info.push('Реквизиты совпадают со справочником — смены реквизитов нет.');
    if (country !== 'RU') add('foreign', 20, 'Банк получателя за рубежом', 'Перевод за границу вместо привычного российского счёта контрагента.', 'SRC-A');
    else if (acc || bik) {
      if (!/^\d{20}$/.test(acc)) add('accformat', 25, 'Номер счёта неверного формата', 'Расчётный счёт в России состоит из 20 цифр, указано ' + acc.length + '.', 'ЦБ РФ');
      else if (!/^\d{9}$/.test(bik)) add('bikformat', 15, 'БИК неверного формата', 'БИК состоит из 9 цифр.', 'ЦБ РФ');
      else if (accountKeyOk(bik, acc) === false) add('acckey', 25, 'Контрольный ключ счёта не сходится с БИК', 'Счёт не проходит проверку по алгоритму Банка России: это опечатка или подделка.', 'ЦБ РФ');
      if (/^408/.test(acc) && !(v && /^408/.test(digits(v.account)))) add('personal', 25, 'Счёт физического лица', 'Счёт начинается с 408 — это счёт физлица или ИП, а не организации.', 'SRC-097');
    }

    // 5. ИНН получателя
    var rinn = digits(req.recipientInn);
    if (v && rinn && rinn !== digits(v.inn)) add('inn', 30, 'ИНН получателя отличается от ИНН контрагента', 'Деньги уйдут другому лицу: ' + rinn + ' вместо ' + v.inn + '.', 'SRC-001');
    if (rinn && !innOk(rinn)) add('innsum', 10, 'ИНН не проходит проверку контрольной суммы', 'Такого ИНН не может существовать.', 'ФНС');

    // 6. Текст
    var m;
    if ((m = text.match(RX.urgency))) add('urgency', 10, 'Давление сроком', 'Фраза «' + m[0] + '». Срочность мешает проверить запрос.', 'SRC-097');
    if ((m = text.match(RX.secrecy))) add('secrecy', 25, 'Просьба о секретности или запрет звонить', 'Фраза «' + m[0] + '». Мошенники отрезают пути проверки.', 'SRC-007');
    if ((m = text.match(RX.reason))) add('reason', 10, 'Типичное объяснение смены реквизитов', 'Фраза «' + m[0] + '». Арест, проверка, санкции и смена банка — частые легенды.', 'SRC-001');
    if ((m = text.match(RX.representative))) add('rep', 20, 'Оплата на счёт другого лица', 'Фраза «' + m[0] + '».', 'SRC-001');

    var score = flags.reduce(function (s, f) { return s + f.pts; }, 0);
    var level = LEVELS.filter(function (l) { return score >= l.min; })[0];
    return { score: score, level: level, flags: flags.sort(function (x, y) { return y.pts - x.pts; }), info: info, suspicious: score >= THRESHOLD };
  }

  function evaluate(cases, vendors) {
    var byId = {}; vendors.forEach(function (v) { byId[v.id] = v; });
    var res = cases.map(function (c) {
      var r = analyze(Object.assign({}, c, { vendor: byId[c.vendorId] || null }));
      return { c: c, r: r, ok: r.suspicious === (c.label === 'fraud') };
    });
    var tp = res.filter(function (x) { return x.c.label === 'fraud' && x.r.suspicious; }).length;
    var fn = res.filter(function (x) { return x.c.label === 'fraud' && !x.r.suspicious; }).length;
    var fp = res.filter(function (x) { return x.c.label === 'legit' && x.r.suspicious; }).length;
    var tn = res.filter(function (x) { return x.c.label === 'legit' && !x.r.suspicious; }).length;
    return { rows: res, tp: tp, fn: fn, fp: fp, tn: tn, recall: tp / (tp + fn || 1), fpr: fp / (fp + tn || 1) };
  }

  return { analyze: analyze, evaluate: evaluate, accountKeyOk: accountKeyOk, innOk: innOk, LEVELS: LEVELS, THRESHOLD: THRESHOLD };
})();
if (typeof module !== 'undefined') module.exports = RK;
