/**
 * Редактор в центре: `monaco-editor` вторым режимом того же места, что и терминал.
 *
 * ЗАГРУЗКА — ЧЕРЕЗ ЗАГРУЗЧИК AMD ИЗ ПОСТАВКИ (`vendor/monaco/vs/loader.js`), подключённый
 * обычным `<script src>`. Это важно для политики содержимого: у `script-src` нет
 * ни `'unsafe-inline'`, ни `'unsafe-eval'`, и загрузчик в них не нуждается — он берёт
 * модули обычными запросами. Воркеры редактор поднимает сам, файлами из `vendor/monaco/vs/assets`
 * того же происхождения (отсюда `worker-src 'self' blob:` в политике).
 *
 * ЗАПИСЬ ИДЁТ СО СВЕРКОЙ, А НЕ С БЛОКИРОВКОЙ. При открытии демон отдаёт токен состояния
 * файла; при сохранении токен уезжает обратно и пересчитывается по диску. Не совпал —
 * демон НЕ ПИШЕТ и отвечает `file_changed`, а страница показывает предупреждение С ВЫБОРОМ:
 * перечитать файл (потеряв свою правку) или перезаписать намеренно (взяв свежий токен).
 * Молчаливой перезаписи нет ни в одной ветке — иначе чужая правка исчезает без следа.
 *
 * Это защита ОТ ГОНКИ, а не от агента: помешать агенту писать она не может и не пытается.
 *
 * ЗАПРЕТ ЗАПИСИ ПРИХОДИТ ОТ ДЕМОНА полем `readonly` и здесь не пересчитывается. Внутри
 * `.claude`, в проекте без набора и у файла под образцом секрета кнопка сохранения
 * НЕАКТИВНА — не «отдаёт отказ по клику», а неактивна: кнопка-обманка хуже отсутствующей.
 *
 * «СОХРАНИТЬ» ВКЛЮЧАЕТ ПРАВКА, А НЕ ОТКРЫТИЕ ФАЙЛА. Признак несохранённых правок ведётся
 * от события модели (`onDidChangeModelContent`) и сбрасывается в трёх местах: подстановка
 * новой модели, удачное сохранение и закрытие. Активная кнопка на нетронутом файле — это
 * не безобидная мелочь: она говорит человеку, что он что-то менял, и заставляет гадать,
 * не потеряет ли он чужую работу нажатием.
 *
 * ПРАВКА ВИДНА ОТМЕТКОЙ У ИМЕНИ ФАЙЛА — иначе правленый файл неотличим от чистого, а
 * состояние «есть несохранённое» существует только в голове у кнопки. Отметка — отдельный
 * узел разметки (`#editor-dirty`), а не приписка к пути: путь приходит извне и живёт своей
 * жизнью, дописывать к нему служебные знаки значило бы смешивать чужой текст со своим.
 *
 * «ПЕРЕЧИТАТЬ» ОСТАЁТСЯ ЖИВОЙ И БЕЗ ПРАВОК — она подтягивает чужую версию с диска, и это
 * осмысленно на нетронутом файле. Но при несохранённых правках она СПРАШИВАЕТ: молча
 * выбросить работу человека кнопка не имеет права. Ветвь `file_changed` зовёт перечитывание
 * с уже сделанным выбором и второй раз не переспрашивает.
 *
 * ОКОНЧАНИЯ СТРОК НЕ ПЕРЕПИСЫВАЮТСЯ — В ПРЕДЕЛАХ ТОГО, ЧТО УМЕЕТ МОДЕЛЬ. Она заводится
 * с окончанием, ВЗЯТЫМ ИЗ САМОГО ФАЙЛА (`\r\n` в исходном тексте — CRLF, иначе LF): без
 * этого редактор подставляет своё умолчание, и сохранение без единой правки раздувает дифф
 * на весь файл. Проверяется это так: открыть файл, сохранить, посмотреть, что дифф пуст.
 *
 * ГРАНИЦА ЭТОГО ОБЕЩАНИЯ НАЗВАНА ЗДЕСЬ ЖЕ, ЧТОБЫ ОНО НЕ ЧИТАЛОСЬ ШИРЕ, ЧЕМ ЕСТЬ: файл
 * со СМЕШАННЫМИ окончаниями обещание не покрывает. Модель хранит ОДНО окончание на весь
 * документ — третьего значения у неё нет, — а выбор в `setModel()` идёт по наличию хотя бы
 * одного `\r\n`. Значит смешанный файл после круга «открыл — сохранил» станет целиком CRLF,
 * то есть получит ровно тот дифф на весь файл, от которого правило и защищает. Лечится это
 * не подкруткой условия, а отказом открывать такой файл на запись либо склейкой при
 * сохранении; ни того ни другого фаза 2 не делает, и брать такой файл в проверку нельзя.
 *
 * ЧЕГО ЗДЕСЬ НАМЕРЕННО НЕТ. Метки порядка байтов (BOM) страница не трогает: она приходит
 * первым символом текста, уезжает обратно тем же символом и в круге «открыл — сохранил»
 * не теряется. Специальной обработки у неё нет — если однажды окажется, что редактор её
 * ест, лечить это надо здесь, а не на записи.
 */

/** Расширение → язык подсветки. Чужое расширение — обычный текст, а не догадка по содержимому. */
const LANGS = Object.freeze({
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  json: 'json', md: 'markdown', markdown: 'markdown',
  css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html', xml: 'xml', svg: 'xml',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini',
  sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell', bat: 'bat', cmd: 'bat',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', php: 'php',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', sql: 'sql', lua: 'lua',
});

function languageFor(path) {
  const name = String(path).split('/').pop() || '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'plaintext';
  return LANGS[name.slice(dot + 1).toLowerCase()] || 'plaintext';
}

const FAULT_WORDS = Object.freeze({
  secret_hidden: 'файл закрыт как секрет: открыть можно только действием «показать» в дереве',
  not_text_file: 'файл не разбирается как текст (двоичный или чужая кодировка) — редактор его не открывает',
  file_too_big: 'файл больше потолка редактора',
  path_unreachable: 'путь недоступен',
  not_plain_file: 'это не обычный файл',
  git_dir_closed: 'служебная папка репозитория закрыта целиком',
  file_changed: 'файл изменился с момента открытия',
  write_into_kit: 'запись в папку набора запрещена',
  write_no_kit: 'у проекта нет папки .claude — такой проект закрыт на запись целиком',
  write_into_secret: 'запись в файл под образцом секрета запрещена',
  write_outside_root: 'путь ведёт мимо корня проекта',
  target_not_plain_file: 'цель записи — не обычный файл',
  bad_body: 'демон не принял тело запроса',
  body_too_big: 'тело запроса больше потолка',
});

const fault = (code) => FAULT_WORDS[code] || `отказ демона: ${code || 'неизвестно'}`;

let monacoPromise = null;

/**
 * Загрузить редактор один раз на страницу.
 *
 * Экспортируется, потому что вкладка диффов берёт РЕДАКТОР СРАВНЕНИЯ ИЗ ЭТОЙ ЖЕ ПОСТАВКИ
 * (третьей библиотеки в фазе нет): два независимых загрузчика подняли бы одни и те же
 * модули дважды.
 */
export function loadMonaco() {
  if (monacoPromise) return monacoPromise;
  monacoPromise = new Promise((resolve, reject) => {
    const amd = globalThis.require;
    if (!amd || typeof amd.config !== 'function') {
      reject(new Error('загрузчик редактора не подключён'));
      return;
    }
    amd.config({ paths: { vs: 'vendor/monaco/vs' } });
    amd(['vs/editor/editor.main'], () => {
      if (globalThis.monaco) resolve(globalThis.monaco);
      else reject(new Error('редактор не поднялся'));
    }, () => reject(new Error('модули редактора не загрузились')));
  });
  return monacoPromise;
}

export function createEditor({
  host, pathLabel, dirtyLabel, flags, notice, saveButton, reloadButton, api, ui, onSaved,
}) {
  const { el, clear, setText } = ui;

  let monaco = null;
  let editor = null;
  let current = null;   // {projectId, path, token, readonly, reveal}
  let openSeq = 0;      // номер последнего открытия: по нему отбрасываются устаревшие ответы
  let dirty = false;    // есть несохранённые правки
  let applying = false; // идёт подстановка модели: её события правкой человека не являются

  function showNotice(text, actions) {
    clear(notice);
    if (!text) {
      notice.hidden = true;
      return;
    }
    notice.hidden = false;
    notice.appendChild(el('span', null, text));
    for (const [label, fn] of actions || []) {
      const b = el('button', 'btn btn-quiet', label);
      b.type = 'button';
      b.addEventListener('click', fn);
      notice.appendChild(b);
    }
  }

  async function ensureEditor() {
    if (editor) return editor;
    monaco = await loadMonaco();
    editor = monaco.editor.create(host, {
      theme: 'vs-dark',
      automaticLayout: false,     // размеры считаем сами: скрытая вкладка даёт нулевую высоту
      readOnly: true,
      minimap: { enabled: false },
      fontFamily: 'ui-monospace, "Cascadia Mono", Consolas, Menlo, monospace',
      fontSize: 13,
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
    });
    // Подписка ОДНА на весь редактор, а не на модель: событие приходит от той модели,
    // которая стоит сейчас, и переживает подстановку следующей. Подписка на модель
    // потребовала бы отписки при каждой смене — и первая же забытая отписка держала бы
    // выброшенную модель живой.
    editor.onDidChangeModelContent(() => {
      if (applying) return;
      setDirty(true);
    });
    return editor;
  }

  function setModel(text, path) {
    const model = monaco.editor.createModel(text, languageFor(path));
    // ОКОНЧАНИЯ СТРОК — ИЗ САМОГО ФАЙЛА, а не по умолчанию редактора.
    model.setEOL(text.includes('\r\n')
      ? monaco.editor.EndOfLineSequence.CRLF
      : monaco.editor.EndOfLineSequence.LF);
    const old = editor.getModel();
    applying = true;
    try {
      editor.setModel(model);
    } finally {
      applying = false;
    }
    if (old) old.dispose();
    setDirty(false);
  }

  function renderFlags(data) {
    clear(flags);
    if (!data) return;
    if (data.readonly) flags.appendChild(el('span', 'badge is-warn', 'только чтение'));
    if (data.secret) flags.appendChild(el('span', 'badge is-alarm', 'секрет'));
  }

  /** Отметка несохранённых правок и обе кнопки — из одного места: два источника разъедутся. */
  function setDirty(value) {
    const next = value === true;
    if (dirty === next) return;
    dirty = next;
    if (dirtyLabel) dirtyLabel.hidden = !dirty;
    setButtons();
  }

  function setButtons() {
    const writable = !!current && current.readonly !== true;
    // «Сохранить» включает ПРАВКА: на нетронутом файле сохранять нечего, а активная кнопка
    // означала бы, что человек что-то менял.
    saveButton.disabled = !(writable && dirty);
    // «Перечитать» живёт при открытом файле и без правок: подтянуть чужую версию с диска
    // осмысленно всегда. О потере несохранённого она спрашивает — см. `reload()`.
    reloadButton.disabled = !current;
  }

  /**
   * Открыть файл.
   *
   * ПОДПИСЬ ПУТИ, МОДЕЛЬ И `current` СТАВЯТСЯ ОДНИМ КУСКОМ И ТОЛЬКО ПОСЛЕ ОТВЕТА ДЕМОНА,
   * а каждый вход считает свой номер. Два быстрых клика по разным файлам дают два запроса,
   * и ответы вправе прийти в обратном порядке: всё, что пришло не на последний запрос,
   * отбрасывается целиком. Иначе в подписи оказывается файл B, а в редакторе и в `current`
   * — файл A, и человек правит один файл, думая, что правит другой.
   */
  async function open(projectId, path, options) {
    const reveal = options && options.reveal === true;
    const seq = (openSeq += 1);

    try {
      await ensureEditor();
    } catch (e) {
      // ОТКАЗ ЗАГРУЗКИ РЕДАКТОРА ЧЕЛОВЕКУ ВИДЕН, а не только в консоли: иначе клик по файлу
      // оставляет пустое полотно и выглядит как «пульт завис». Терминал в этом же случае
      // говорит вслух («сборка терминала не загрузилась» в `ensureTerm()`), и здесь так же.
      if (seq !== openSeq) return;
      current = null;
      setText(pathLabel, path);
      renderFlags(null);
      setDirty(false);
      setButtons();
      showNotice(`редактор не загрузился: ${e && e.message ? e.message : 'причина неизвестна'}`);
      return;
    }
    if (seq !== openSeq) return;

    const r = await api.file(projectId, path, reveal);
    if (seq !== openSeq) return;   // ответ на устаревший запрос: применять его нельзя
    const data = r.body || {};
    setText(pathLabel, path);
    showNotice(null);
    if (!r.ok || !data.ok) {
      current = null;
      renderFlags(data);
      setButtons();
      setModel('', path);
      editor.updateOptions({ readOnly: true });
      showNotice(fault(data.code));
      layout();
      return;
    }

    current = {
      projectId, path, token: data.token, readonly: data.readonly === true, reveal,
    };
    setModel(data.text, path);
    editor.updateOptions({ readOnly: current.readonly });
    renderFlags(data);
    setButtons();
    layout();
  }

  /**
   * Перечитать файл с диска. Это всегда явное действие, и при несохранённых правках оно
   * СПРАШИВАЕТ: выбросить чужую… то есть свою же работу молча кнопка не имеет права.
   * `force` ставят там, где выбор уже сделан человеком, — предупреждение о потере правки
   * и ветвь `file_changed`.
   */
  async function reload(options) {
    if (!current) return;
    if (dirty && !(options && options.force === true)) {
      showNotice('в файле есть несохранённые правки — перечитывание вернёт версию с диска, и они пропадут', [
        ['Перечитать и потерять правку', () => { reload({ force: true }); }],
        ['Оставить как есть', () => { showNotice(null); }],
      ]);
      return;
    }
    await open(current.projectId, current.path, { reveal: current.reveal });
  }

  async function post(token) {
    const model = editor.getModel();
    const text = model ? model.getValue() : '';
    return api.save(current.projectId, { path: current.path, text, token });
  }

  /**
   * Перезаписать намеренно: свежий токен берётся отдельным чтением и тут же уезжает
   * обратно. Это НЕ обход сверки — сверка на демоне остаётся на месте; это осознанное
   * решение человека, нажавшего кнопку в предупреждении.
   */
  async function force() {
    if (!current) return;
    const r = await api.file(current.projectId, current.path, current.reveal);
    if (!current) return;   // проект переключили под летящим чтением: писать уже некуда
    const data = r.body || {};
    if (!r.ok || !data.ok || !data.token) {
      showNotice(fault(data.code));
      return;
    }
    const saved = await post(data.token);
    handleSave(saved);
  }

  function handleSave(r) {
    // Ответ пришёл ПОСЛЕ `await`, а `close()` (его зовёт смена проекта) обнуляет `current`.
    // Без этой проверки здесь падает обращение к полю у `null`, и падает молча —
    // необработанным отклонением промиса: ответ демона теряется, человек не узнаёт ничего.
    if (!current) return;
    const data = r.body || {};
    if (r.ok && data.ok) {
      current.token = data.token;
      setDirty(false);
      showNotice('сохранено');
      if (typeof onSaved === 'function') onSaved(current.path);
      return;
    }
    if (data.code === 'file_changed') {
      // ПРЕДУПРЕЖДЕНИЕ С ВЫБОРОМ, а не молчаливая перезапись: файл на диске уже другой.
      showNotice('файл изменился с момента открытия — на диске уже другая версия', [
        ['Перечитать файл', () => { reload({ force: true }); }],
        ['Перезаписать', () => { force(); }],
      ]);
      return;
    }
    showNotice(fault(data.code));
  }

  async function save() {
    if (!current || current.readonly) return;
    const r = await post(current.token);
    handleSave(r);
  }

  function layout() {
    if (!editor) return;
    try { editor.layout(); } catch { /* полотно не показано */ }
  }

  function close() {
    // Летящие открытия обесцениваются вместе с закрытием: их ответ уже не наш, и применить
    // его после смены проекта значило бы вернуть на страницу файл покинутого проекта.
    openSeq += 1;
    current = null;
    setText(pathLabel, 'файл не открыт');
    clear(flags);
    showNotice(null);
    setDirty(false);
    setButtons();
    if (editor) {
      const old = editor.getModel();
      applying = true;
      try {
        if (monaco) editor.setModel(monaco.editor.createModel('', 'plaintext'));
      } finally {
        applying = false;
      }
      if (old) old.dispose();
    }
  }

  saveButton.addEventListener('click', () => { save(); });
  reloadButton.addEventListener('click', () => { reload(); });
  if (dirtyLabel) dirtyLabel.hidden = true;
  setButtons();

  return { open, reload, save, layout, close };
}
