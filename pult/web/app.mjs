/**
 * Состояние страницы, левая колонка и сборка рабочего места.
 *
 * Этот модуль — КОРЕНЬ СБОРКИ: он единственный знает про демона (адреса маршрутов) и про
 * весь документ сразу, а терминал, дерево, редактор и вкладка диффов получают от него
 * готовые зависимости (`api`, `ui`) и свой кусок разметки. Обратных импортов нет намеренно:
 * круговой импорт между модулями страницы работал бы «пока не сломается» — из-за временной
 * мёртвой зоны при первом же переносе вызова на уровень модуля.
 *
 * ВЕСЬ СВОБОДНЫЙ ТЕКСТ ОТ ДЕМОНА ВСТАВЛЯЕТСЯ ТОЛЬКО `textContent` И `createElement`.
 * Присваивания разметки строкой нет ни в одном файле страницы — это условие, а не привычка:
 * имена файлов, заголовки задач, строки журнала и ветки приходят из чужих файлов, демон
 * их не экранирует (и не должен — пункт 16 раздела 1.5 контракта прямо перекладывает это
 * на потребителя), поэтому заголовок задачи с угловой скобкой обязан остаться скобкой.
 *
 * ОПРОСА ПО ТАЙМЕРУ НЕТ. Ни одного `setInterval` за данными: полный обход отпечатка
 * на демоне синхронный и на время обхода держит цикл событий вместе с терминалом (принятый
 * риск 5 фазы 1). Обновление — по кнопке и при переключении проекта. Регулярный опрос
 * без переноса обхода в рабочий поток заводить нельзя, и это решение, а не недоделка.
 */

import { createTerminal } from './terminal.mjs';
import { createTree } from './tree.mjs';
import { createEditor } from './editor.mjs';
import { createDiff } from './diff.mjs';
import { createKitRun } from './kitrun.mjs';
import { createDeployWizard } from './deploy.mjs';
import { createAccept } from './accept.mjs';
import { addressFor } from './addresses.mjs';

// --- мелкая работа с документом ----------------------------------------------

/**
 * Создание узла. Текст идёт ТОЛЬКО третьим аргументом и ТОЛЬКО в `textContent`:
 * другой двери для чужого текста на этой странице нет.
 */
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function setText(node, text) {
  if (node) node.textContent = text === null || text === undefined ? '' : String(text);
}

/** Класс-состояние на узле: один из списка либо ни одного. */
function setState(node, cls, states) {
  if (!node) return;
  for (const s of states) node.classList.remove(s);
  if (cls) node.classList.add(cls);
}

const ui = { el, clear, setText };

const $ = (id) => document.getElementById(id);

// --- разговор с демоном -------------------------------------------------------

/**
 * СВЯЗЬ С ДЕМОНОМ — ГЛОБАЛЬНОЕ СОСТОЯНИЕ СТРАНИЦЫ, а не забота каждого виджета.
 *
 * Находка человека 02.09.2026 (дефект 2): демон остановился, и страница осталась выглядеть
 * живой — полоса состояния показывала «демон 0.3.0» с ЗЕЛЁНОЙ точкой, потому что `refreshDaemon()`
 * зовётся только на старте и по кнопке «Обновить». Каждый виджет при этом говорил своё:
 * дерево — «каталог не прочитан: нет связи», карточка — прочерки. Человек читал это как
 * поломку дерева при переключении проектов, а поломан был не виджет.
 *
 * Лечится в ОДНОМ месте, потому что дверь наружу одна: обрыв запроса (`status: 0`) переводит
 * страницу в состояние «демон не отвечает», а первый удавшийся запрос возвращает её обратно
 * и перечитывает здоровье. Виджеты при этом не трогаются — им незачем знать про сеть.
 */
let daemonReachable = true;

function setDaemonReachable(alive) {
  if (alive === daemonReachable) return;
  daemonReachable = alive;
  if (!alive) {
    setState($('daemon-dot'), 'is-alarm', ['is-ok', 'is-warn', 'is-alarm']);
    setText($('daemon-text'), 'демон не отвечает — страница ничего не прочитает');
    return;
  }
  refreshDaemon();
}

/**
 * Один запрос. Наружу отдаётся `{ok, status, body}` и НИКОГДА исключение: у демона отказ —
 * это тело с машинным кодом (`code`), а не обрыв, и страница обязана уметь его показать.
 * Сеть здесь всегда своя, петлевая: адреса относительные, чужих источников нет.
 */
async function req(url, init) {
  try {
    const res = await fetch(url, init);
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    setDaemonReachable(true);
    return { ok: res.ok, status: res.status, body };
  } catch {
    // Сюда приходит ТОЛЬКО обрыв: отказ демона — это ответ с телом, он выше.
    setDaemonReachable(false);
    return { ok: false, status: 0, body: null };
  }
}

const q = (v) => encodeURIComponent(String(v === null || v === undefined ? '' : v));

export const api = {
  health: () => req('/health'),
  projects: () => req('/projects'),
  project: (id) => req(`/projects/${q(id)}`),
  tree: (id, dir) => req(`/projects/${q(id)}/tree?dir=${q(dir)}`),
  file: (id, path, reveal) => req(`/projects/${q(id)}/file?path=${q(path)}${reveal ? '&reveal=1' : ''}`),
  diffList: (id) => req(`/projects/${q(id)}/diff`),
  diffFile: (id, path) => req(`/projects/${q(id)}/diff?path=${q(path)}`),
  // ЕДИНСТВЕННЫЙ метод записи у демона. Тип содержимого обязателен: без него маршрут
  // отвечает отказом (и это не формальность — требование типа заставляет браузер делать
  // предварительный запрос, а заголовков общего доступа демон не отдаёт).
  save: (id, payload) => req(`/projects/${q(id)}/file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }),
};

// --- состояние интерфейса -----------------------------------------------------

const state = {
  projects: [],       // список из ответа `/projects`
  selected: null,     // идентификатор выбранного проекта
  project: null,      // полный ответ по выбранному проекту (`/projects/:id`)
  task: null,         // идентификатор раскрытой задачи
  pane: 'terminal',   // терминал | редактор | диффы
};

const WORDS = Object.freeze({
  state: {
    ok: 'набор на месте', unreachable: 'папка недоступна', no_kit: 'набора нет',
    foreign: 'чужой набор', legacy: 'старая структура',
    // ШЕСТОЕ СОСТОЯНИЕ ФАЗЫ 3, и фраза здесь говорит человеку, ЧТО ДЕЛАТЬ. Без строки
    // в этом словаре запись показывалась бы прочерком: состояние было бы видно машине
    // и невидимо человеку — а решение 11 плана ровно про обратное. Запись из реестра при
    // этом не пропадает: демон отказывается читать и писать под таким корнем, но список
    // ведёт человек.
    root_rejected: 'каталог отвергнут как корень проекта — выберите папку самого проекта',
  },
  // ЧЕТВЁРТОЕ СЛОВО ВЕРДИКТА (фаза 4): «сходится по составу профиля». Оно отдельное,
  // а не общий `match`, потому что утверждение слабее: сверялся не весь набор, а состав
  // профиля, и ПОЛНЫЕ значения при этом законно различаются. Без своей фразы человек читал
  // бы «сходится» и не знал, что часть файлов из сверки вынесена.
  verdict: {
    match: 'сходится', match_preset: 'сходится по составу профиля',
    mismatch: 'расхождение', unknown: 'неизвестно',
  },
  // Причины вердикта «неизвестно», у которых перевод что-то добавляет. Всё прочее уходит
  // общей строкой с самим кодом: выдумывать объяснение незнакомому коду хуже, чем показать код.
  reason: {
    core_foreign: 'ядро набора в проекте не наше',
    reference_missing: 'мастер-копия набора недоступна — сверять не с чем',
    deploy_record_invalid: 'запись о раскладке негодна',
    scan_truncated: 'обход состава неполон',
  },
  gateStatus: { implementing: 'взведён', verified: 'взведён, приёмка пройдена', blocked: 'взведён, заблокирован' },
  gateVerify: { pass: 'зелёная', partial: 'частичная', fail: 'красная', none: 'не гонялась' },
  review: { approved: 'принято', changes_requested: 'на доработку', blocked: 'заблокировано' },
});

const word = (dict, key, dash = '—') => (key && dict[key] ? dict[key] : dash);

// --- полоса состояния ---------------------------------------------------------

async function refreshDaemon() {
  const r = await api.health();
  const dot = $('daemon-dot');
  if (r.ok && r.body && r.body.ok) {
    setState(dot, 'is-ok', ['is-ok', 'is-warn', 'is-alarm']);
    setText($('daemon-text'), `демон ${r.body.pult}, Node ${r.body.node}`);
  } else {
    setState(dot, 'is-alarm', ['is-ok', 'is-warn', 'is-alarm']);
    setText($('daemon-text'), 'демон не отвечает');
  }
}

function renderStatusBar() {
  const p = state.project;
  setText($('status-project'), p ? p.name : 'проект не выбран');
  setText($('status-version'), p && p.version ? p.version : '—');
  const verdict = p && p.fingerprint ? p.fingerprint.verdict : null;
  setText($('status-fingerprint'), `отпечаток: ${word(WORDS.verdict, verdict)}`);
  const task = p && p.active_task ? p.active_task : null;
  setText($('status-task'), task ? `задача: ${task.title || task.id} (${task.status || '—'})` : 'задача: —');
}

// --- полоса гейта: ТРИ ФАКТА И ТОЛЬКО ОНИ -------------------------------------

/**
 * Взведён или нет, приёмка зелёная или нет, сколько попыток.
 *
 * Ленты событий здесь нет и не будет: она разрастается, а полоса обязана читаться за секунду.
 * История задачи живёт в её карточке (журнал из `STATE.md`).
 */
function renderGate() {
  const gate = state.project && state.project.gate ? state.project.gate : null;
  const dots = ['is-ok', 'is-warn', 'is-alarm'];

  if (!gate) {
    setState($('gate-armed-dot'), null, dots);
    setText($('gate-armed'), 'гейт: не взведён');
    setState($('gate-verify-dot'), null, dots);
    setText($('gate-verify'), 'приёмка: —');
    setText($('gate-attempts'), 'попыток: —');
    return;
  }

  setState($('gate-armed-dot'), gate.status === 'blocked' ? 'is-alarm' : 'is-ok', dots);
  setText($('gate-armed'), `гейт: ${word(WORDS.gateStatus, gate.status, 'взведён')}`);

  const verifyDot = { pass: 'is-ok', partial: 'is-warn', fail: 'is-alarm' }[gate.verify] || null;
  setState($('gate-verify-dot'), verifyDot, dots);
  setText($('gate-verify'), `приёмка: ${word(WORDS.gateVerify, gate.verify)}`);

  setText($('gate-attempts'), `попыток: ${gate.attempts === null || gate.attempts === undefined ? '—' : gate.attempts}`);
}

// --- левая колонка ------------------------------------------------------------

function projectRow(p) {
  const li = el('li', 'project');
  if (p.id === state.selected) li.classList.add('is-active');

  const dotCls = p.state !== 'ok' ? 'is-alarm'
    : (p.fingerprint && p.fingerprint.verdict === 'match' ? 'is-ok' : 'is-warn');
  li.appendChild(el('span', `dot ${dotCls}`));

  const box = el('div', 'grow');
  box.appendChild(el('div', 'name', p.name || p.id));
  const sub = el('div', 'small muted');
  const task = p.active_task;
  sub.textContent = task
    ? `${task.status || '—'} · ${task.title || task.id}`
    : word(WORDS.state, p.state, 'состояние неизвестно');
  box.appendChild(sub);
  li.appendChild(box);

  li.appendChild(el('span', 'ver', p.version || '—'));
  li.addEventListener('click', () => { selectProject(p.id); });
  return li;
}

function renderProjects() {
  const list = $('projects-list');
  clear(list);
  for (const p of state.projects) list.appendChild(projectRow(p));
  setText($('projects-count'), state.projects.length);
}

// --- карточка проекта ---------------------------------------------------------

/** Кнопка «открыть файл задачи в редакторе». Путь собирается здесь и только из id. */
function taskFileButton(taskId, name) {
  const b = el('button', 'btn btn-quiet', name);
  b.type = 'button';
  b.addEventListener('click', () => {
    openFile(`.claude/tasks/${taskId}/${name}`);
  });
  return b;
}

function renderTaskDetail(task) {
  const box = $('task-detail');
  if (!task) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  setText($('task-title'), task.title || task.id);

  const bits = [`id: ${task.id}`, `статус: ${task.status || '—'}`, `класс: ${task.class || '—'}`];
  if (task.branch) bits.push(`ветка: ${task.branch}`);
  if (task.updated && task.updated.value) bits.push(`изменено: ${task.updated.value}`);
  if (task.review_iterations !== null && task.review_iterations !== undefined) {
    bits.push(`ревью: ${task.review_iterations}/3`);
  }
  if (task.review && task.review.verdict) bits.push(`вердикт ревью: ${word(WORDS.review, task.review.verdict)}`);
  if (task.security && task.security.verdict) bits.push(`аудит: ${word(WORDS.review, task.security.verdict)}`);
  setText($('task-meta'), bits.join(' · '));

  const files = $('task-files');
  clear(files);
  // Файлы задачи читаются ТЕМ ЖЕ маршрутом файла, что и всё остальное; внутри `.claude`
  // они открываются только на чтение — признак приходит от демона, а не считается здесь.
  for (const name of ['PLAN.md', 'SECURITY.md', 'REVIEW.md', 'DONE.md']) {
    files.appendChild(taskFileButton(task.id, name));
  }

  const log = $('task-log');
  clear(log);
  for (const line of task.log || []) {
    const li = el('li');
    li.appendChild(el('span', 't', line.time && line.time.value ? line.time.value : '—'));
    li.appendChild(el('span', 'text', line.text || ''));
    log.appendChild(li);
  }
  if (!(task.log || []).length) log.appendChild(el('li', 'muted small', 'записей нет'));
}

function renderCard() {
  const card = $('project-card');
  const p = state.project;
  if (!p) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  setText($('card-name'), p.name || p.id);
  setText($('card-path'), p.path || '');
  setText($('card-version'), p.version ? `версия ${p.version}` : word(WORDS.state, p.state, 'версия неизвестна'));

  const verdict = p.fingerprint ? p.fingerprint.verdict : null;
  const badge = $('card-verdict');
  // Причина уезжает в подпись значка, когда она есть: «неизвестно» без причины человек
  // читает как поломку пульта, а не как состояние проекта.
  const reasonCode = p.fingerprint ? p.fingerprint.reason : null;
  const reasonText = reasonCode && verdict === 'unknown'
    ? ` (${WORDS.reason[reasonCode] || reasonCode})` : '';
  setText(badge, `отпечаток: ${word(WORDS.verdict, verdict)}${reasonText}`);
  const good = verdict === 'match' || verdict === 'match_preset';
  setState(badge, good ? 'is-ok' : (verdict === 'mismatch' ? 'is-alarm' : 'is-warn'),
    ['is-ok', 'is-warn', 'is-alarm']);

  const diverged = (p.fingerprint && p.fingerprint.diverged) || [];
  setText($('card-diverged'), diverged.length
    ? `расходится: ${diverged.slice(0, 12).join(', ')}${p.fingerprint.truncated ? ' …' : ''}`
    : '');

  // СОСТАВ ПРОФИЛЯ И ПРИЧИНА «ЯДРО НЕ НАШЕ» (шаг 21, находка N круга 3 аудита).
  //
  // Записи о раскладке нет — обе строки пусты, и карточка выглядит ровно как раньше.
  // Список исключённого ПОИМЁННЫЙ: число вместо перечня прячет ровно то, что вынесли
  // из сверки, а вынесенное — это то, что перестало охраняться.
  const comp = p.fingerprint && p.fingerprint.composition;
  const compNode = $('card-composition');
  const coreNode = $('card-core');
  if (!comp) {
    setText(compNode, '');
    setText(coreNode, '');
  } else {
    const bits = [`профиль состава: ${comp.profile}`];
    if (comp.excluded.length) {
      bits.push(`из сверки исключено (${comp.excluded.length}): ${comp.excluded.slice(0, 12).join(', ')}`
        + `${comp.excluded_truncated || comp.excluded.length > 12 ? ' …' : ''}`);
    }
    // ЗНАЧЕНИЕ ПО СОСТАВУ ПОКАЗЫВАЕТСЯ ВСЕГДА, КОГДА ОНО ЕСТЬ. При вердикте «сходится
    // по составу» ПОЛНОГО значения не существует вовсе (`value: null` — обход спотыкается
    // о пути, которых профиль не разворачивал), и пустое поле рядом со словом «сходится»
    // человек читает как поломку пульта. Показываем то, что реально сравнивалось.
    if (comp.value) bits.push(`значение по составу: ${comp.value} (эталон ${comp.reference || "—"})`);
    if (comp.compared) bits.push(`сверено путей: ${comp.compared}`);
    if (verdict === 'match_preset') {
      bits.push('полного значения у проекта с профилем не существует: список состава едет'
        + ' целиком, а исключённых каталогов в проекте нет — сверялся состав профиля');
    }
    setText(compNode, bits.join(' · '));

    // СОСТОЯНИЕ «ЯДРО НЕ НАШЕ» ОБЯЗАНО НАЗВАТЬ ПРИЧИНУ. Без этого самый частый случай
    // §4.2 — раскладка туда, где набор уже стоял, — давал бы человеку отказ без
    // объяснения, а необъяснённый отказ снимают первым.
    const core = [];
    if (comp.core_missing.length) {
      core.push(`нет в проекте или хеш разошёлся (${comp.core_missing.length}):`
        + ` ${comp.core_missing.slice(0, 12).join(', ')}`);
    }
    if (comp.skipped_core.length) {
      core.push(`эти файлы ядра уже были у вас, набор их не заменял (${comp.skipped_core.length}):`
        + ` ${comp.skipped_core.slice(0, 12).join(', ')}`);
    }
    setText(coreNode, core.join(' · '));
  }

  const tasks = $('card-tasks');
  clear(tasks);
  const items = p.tasks || (p.active_task ? [p.active_task] : []);
  for (const t of items) {
    const li = el('li', 'task');
    if (t.id === state.task) li.classList.add('is-active');
    li.appendChild(el('span', 'task-name', t.title || t.id));
    // КЛАСС РИСКА ВИДЕН В СПИСКЕ, а не только в раскрытой задаче: он решает, был ли аудит
    // безопасности вообще (при `cosmetic` он пропускается целиком), и человеку за пультом
    // это надо видеть БЕЗ открытия задачи. Посмотреть его иначе можно только в `STATE.md`
    // руками: кнопки «класс риска» у пульта нет намеренно — она ПИШЕТ (ревью 03.09.2026).
    if (t.class && t.class !== '-') li.appendChild(el('span', 'badge', t.class));
    li.appendChild(el('span', 'status', t.status || '—'));
    li.addEventListener('click', () => {
      state.task = t.id;
      renderCard();
      renderTaskDetail(t);
    });
    tasks.appendChild(li);
  }
  if (!items.length) tasks.appendChild(el('li', 'muted small', 'задач нет'));

  const current = items.find((t) => t.id === state.task) || p.active_task || null;
  if (current) state.task = current.id;
  renderTaskDetail(current);

  const faults = (p.faults || []).map((f) => `${f.field}: ${f.code}`);
  setText($('card-faults'), faults.length ? `отказы чтения — ${faults.join('; ')}` : '');
}

// --- переключение проекта -----------------------------------------------------

async function loadProject(id) {
  const r = await api.project(id);
  const found = r.ok && r.body && Array.isArray(r.body.projects) ? r.body.projects[0] : null;
  state.project = found || null;
  renderCard();
  renderGate();
  renderStatusBar();
  return found;
}

/**
 * Смена проекта меняет ВСЁ рабочее место: центр и дерево справа.
 *
 * Терминал при этом ОТКЛЮЧАЕТСЯ, но не убивается: сессия уходит таймеру пяти минут
 * на демоне, и возврат в проект подхватывает её вместе с последним экраном. Автоматически
 * поднимать сессию на каждый клик по проекту нельзя — это заводило бы оболочку машины
 * простым просмотром списка и упиралось бы в потолок числа сессий.
 */
/**
 * ПАНЕЛЬ КОМАНД НАБОРА И МАСТЕР УСТАНОВКИ. Оба живут ТОЛЬКО в оболочке: команды набора
 * и раскладку запускает главный процесс, и в браузере их запускать нечем. Здесь объявлены
 * пустыми, а собираются ниже — там, где становится известно, жив ли мост.
 */
let kitrun = null;
let wizard = null;
/** Экран приёмки и панель настроек проекта. Живут и без моста: они читают, а не действуют. */
let accept = null;

async function selectProject(id) {
  if (state.selected === id) return;
  state.selected = id;
  state.task = null;
  terminal.disconnect('проект переключён');
  editor.close();
  renderProjects();
  await loadProject(id);
  renderProjects();
  await tree.load(id);
  diff.reset();
  // Вывод чужой команды не должен пережить переключение проекта: сброс и показ заново.
  if (kitrun) { kitrun.reset(); kitrun.show(id); }
  // Панель настроек проекта — только показ; экран приёмки прячется до своего повода.
  if (accept) { accept.hide(); await accept.showSettings(state.project); }
}

async function refreshAll() {
  await refreshDaemon();
  const r = await api.projects();
  state.projects = r.ok && r.body && Array.isArray(r.body.projects) ? r.body.projects : [];
  if (!state.projects.some((p) => p.id === state.selected)) state.selected = null;
  renderProjects();
  if (state.selected) {
    await loadProject(state.selected);
    renderProjects();
  } else {
    state.project = null;
    renderCard();
    renderGate();
    renderStatusBar();
  }
}

// --- вкладки центра -----------------------------------------------------------

function showPane(name) {
  state.pane = name;
  for (const [pane, tab] of [['terminal', 'tab-terminal'], ['editor', 'tab-editor'], ['diff', 'tab-diff']]) {
    $(`pane-${pane}`).hidden = pane !== name;
    $(tab).classList.toggle('is-active', pane === name);
  }
  // Обе сборки считают свои размеры сами и только когда их видно: спрятанному узлу браузер
  // отдаёт нулевую высоту, и раскладка «схлопывается» ровно один раз — при первом показе.
  if (name === 'terminal') terminal.layout();
  if (name === 'editor') editor.layout();
  if (name === 'diff') diff.layout();
}

/** Открыть файл проекта в редакторе — общая дверь для дерева и карточки задачи. */
async function openFile(relPath, options) {
  if (!state.selected) return;
  showPane('editor');
  await editor.open(state.selected, relPath, options || {});
}

// --- сборка ------------------------------------------------------------------

const terminal = createTerminal({
  host: $('terminal-host'),
  button: $('btn-session'),
  kindSelect: $('session-kind'),
  status: $('terminal-status'),
  dot: $('terminal-dot'),
  ui,
});

const tree = createTree({
  root: $('tree-root'),
  note: $('tree-note'),
  api,
  ui,
  onOpenFile: (path, opts) => openFile(path, opts),
});

const editor = createEditor({
  host: $('editor-host'),
  pathLabel: $('editor-path'),
  dirtyLabel: $('editor-dirty'),
  flags: $('editor-flags'),
  notice: $('editor-notice'),
  saveButton: $('btn-save'),
  reloadButton: $('btn-reload'),
  api,
  ui,
  onSaved: () => { if (state.selected) tree.reload(); },
});

const diff = createDiff({
  host: $('diff-host'),
  files: $('diff-files'),
  summary: $('diff-summary'),
  modeButton: $('btn-diff-mode'),
  modeNote: $('diff-mode-note'),
  api,
  ui,
});

$('btn-refresh').addEventListener('click', () => { refreshAll(); });

$('btn-verify-fingerprint').addEventListener('click', async () => {
  if (!state.selected) return;
  const badge = $('card-verdict');
  setText(badge, 'отпечаток: считаю…');
  await loadProject(state.selected);
  await refreshDaemon();
});

$('btn-tree-reload').addEventListener('click', () => { if (state.selected) tree.reload(); });

$('btn-tree-collapse').addEventListener('click', () => {
  const columns = $('columns');
  const collapsed = columns.classList.toggle('is-right-collapsed');
  $('btn-tree-collapse').textContent = collapsed ? '|←' : '→|';
  terminal.layout();
  editor.layout();
  diff.layout();
});

$('btn-diff-reload').addEventListener('click', () => { if (state.selected) diff.load(state.selected); });

for (const [pane, id] of [['terminal', 'tab-terminal'], ['editor', 'tab-editor'], ['diff', 'tab-diff']]) {
  $(id).addEventListener('click', () => {
    showPane(pane);
    if (pane === 'diff' && state.selected) diff.load(state.selected);
  });
}

$('btn-session').addEventListener('click', () => {
  if (!state.selected) return;
  if (terminal.connected()) terminal.disconnect('отключено');
  else terminal.connect(state.selected, $('session-kind').value);
});

window.addEventListener('resize', () => {
  terminal.layout();
  editor.layout();
  diff.layout();
});

// --- оболочка: то, чего нет в браузере ----------------------------------------
//
// ЗДЕСЬ НЕ ПОЯВЛЯЕТСЯ НИ ОДНОГО НОВОГО ОБРАЩЕНИЯ К ДЕМОНУ, и это несущее свойство, а не
// экономия: маршрута записи в реестр у демона нет и не будет (решение по итогам круга 1
// аудита). Проект заводит инструмент кита, которого запускает оболочка; страница только
// просит и показывает результат.
//
// В браузере `window.cckitShell` не существует вовсе — значит кнопка остаётся скрытой,
// подписки нет, и ни одна строка этого раздела не исполняется.
const shell = window.cckitShell && window.cckitShell.present === true ? window.cckitShell : null;

/**
 * ЭКРАН ПРИЁМКИ И ПАНЕЛЬ НАСТРОЕК собираются ВСЕГДА, а не только в оболочке: оба ЧИТАЮТ
 * (итог задачи, профиль состава, служебный ключ владения) и без моста просто не показывают
 * кнопок решений — модуль сам говорит человеку, чего не хватает. Кнопка сноса без моста
 * остаётся выключенной.
 */
accept = createAccept({
  host: $('accept-panel'),
  taskLine: $('accept-task'),
  body: $('accept-body'),
  checklist: $('accept-checklist'),
  notice: $('accept-notice'),
  closeButton: $('btn-accept-close'),
  settingsHost: $('project-settings'),
  settingsPreset: $('settings-preset'),
  settingsExcluded: $('settings-excluded'),
  settingsSkippedCore: $('settings-skipped-core'),
  settingsOwns: $('settings-owns'),
  removeButton: $('btn-remove-kit'),
  api,
  shell,
  ui,
  onChanged: async () => {
    await refreshAll();
    if (state.selected) await accept.showSettings(state.project);
  },
});

/**
 * У КАЖДОЙ ПРИЧИНЫ ОЖИДАНИЯ — СВОЙ АДРЕС НАЗНАЧЕНИЯ (пункт 7 договора с фазой 4).
 *
 * Уведомление обязано ВЕСТИ, а не разворачивать окно: смысл его — сократить путь от «меня
 * ждут» до «я ответил». Уведомление, которое доводит до окна и бросает, экономит только
 * переключение между приложениями, а поиск места решения оставляет человеку.
 *
 * Семь причин из `PENDING_REASONS` (`pult/config.mjs`), четыре адреса:
 *   awaiting_approval    — карточка задачи и открытый `PLAN.md`;
 *   awaiting_acceptance  — экран приёмки;
 *   blocked              — карточка и открытый `STATE.md`;
 *   gate_blocked         — полоса машинной приёмки и, если отчёт есть, открытый отчёт;
 *   stop_product | stop_technical | stop_security — вкладка терминала с подсказкой.
 *
 * СЕССИЯ ТЕРМИНАЛА НЕ ПОДНИМАЕТСЯ АВТОМАТИЧЕСКИ, и это правило фазы 2, а не забывчивость:
 * поднимать оболочку машины по ВНЕШНЕМУ событию нельзя. Человек нажимает «Подключить» сам,
 * а страница только показывает вкладку и говорит, что ответ набирается в сессии.
 *
 * ПРИЧИНА НЕ ПРИШЛА ИЛИ НЕ ОПОЗНАНА — ПРЕЖНЕЕ ПОВЕДЕНИЕ: карточка задачи. Молчаливого
 * «никуда» здесь нет: адрес по умолчанию есть всегда.
 */
async function goToReason(reason, task) {
  // Таблица «причина → адрес» живёт отдельным чистым модулем и проверяется машинно
  // (проверка 9 в `pult/tools/page-check.mjs`): «у каждой из семи причин есть свой адрес» —
  // утверждение, которое ломается ТИХО, когда в набор добавят восьмую причину.
  const address = addressFor(reason);

  if (address === 'accept') {
    if (accept) await accept.show(state.project, task);
    return;
  }
  if (address === 'plan') {
    await openFile(`.claude/tasks/${task.id}/PLAN.md`);
    return;
  }
  if (address === 'state') {
    await openFile(`.claude/tasks/${task.id}/STATE.md`);
    return;
  }
  if (address === 'gate') {
    const gate = state.project && state.project.gate;
    // Отчёт приёмки открывается, только если демон его видел: файла может не быть вовсе.
    if (gate && gate.verify && gate.verify !== 'none') {
      await openFile('.claude/artifacts/VERIFY.json');
    }
    $('gatebar').scrollIntoView({ block: 'nearest' });
    return;
  }
  if (address === 'terminal') {
    // СЕССИЯ НЕ ПОДНИМАЕТСЯ САМА, и это правило фазы 2, а не забывчивость: поднимать
    // оболочку машины по ВНЕШНЕМУ событию (уведомлению) нельзя. Человек нажимает
    // «Подключить» сам, а страница только приводит его на вкладку и говорит, что делать.
    showPane('terminal');
    setText($('terminal-status'), 'задача ждёт ответа на [СТОП] — ответ набирается в сессии;'
      + ' нажмите «Подключить»');
    return;
  }
  // Адрес по умолчанию — карточка задачи, она уже показана. Молчаливого «никуда» нет.
}

/**
 * Открыть задачу, о которой пришло уведомление оболочки.
 *
 * ИДЕНТИФИКАТОРЫ СВЕРЯЮТСЯ С ОТВЕТОМ ДЕМОНА, а не принимаются на веру: чего в ответе нет,
 * то не открывается, а тихо игнорируется. Уведомление могло опоздать — задачу закрыли,
 * проект убрали из реестра.
 */
async function openTaskFromShell(projectId, taskId, reason) {
  await refreshAll();
  if (!state.projects.some((p) => p.id === projectId)) return;
  await selectProject(projectId);
  const items = (state.project && state.project.tasks) || [];
  const found = items.find((t) => t.id === taskId);
  if (!found) return;
  state.task = found.id;
  renderCard();
  renderTaskDetail(found);
  await goToReason(reason, found);
}

if (shell) {
  const addButton = $('btn-add-project');
  addButton.hidden = false;

  // ПАНЕЛЬ КОМАНД НАБОРА. Кнопки строит сам модуль из закрытого словаря ключей —
  // в разметке их нет ни одной, чтобы список кнопок и список ключей не разъезжались.
  kitrun = createKitRun({
    host: $('kitrun'),
    read: $('kitrun-read'),
    write: $('kitrun-write'),
    output: $('kitrun-output'),
    status: $('kitrun-status'),
    code: $('kitrun-code'),
    shell,
    ui,
  });
  if (state.selected) kitrun.show(state.selected);

  // МАСТЕР УСТАНОВКИ. Путь рождается в системном диалоге главного процесса; страница
  // только просит осмотр и показывает найденное ДО раскладки (§4.2, правило 2).
  wizard = createDeployWizard({
    host: $('deploy-wizard'),
    master: $('wizard-master'),
    found: $('wizard-found'),
    present: $('wizard-present'),
    hooks: $('wizard-hooks'),
    claudeMd: $('wizard-claude-md'),
    presetSelect: $('wizard-preset'),
    deployButton: $('btn-wizard-deploy'),
    backup: $('wizard-backup'),
    report: $('wizard-report'),
    closeButton: $('btn-wizard-close'),
    shell,
    ui,
    onDeployed: async (id) => {
      await refreshAll();
      if (id && state.projects.some((pr) => pr.id === id)) await selectProject(id);
    },
  });

  const deployButton = $('btn-deploy-kit');
  deployButton.hidden = false;
  deployButton.addEventListener('click', async () => {
    wizard.show();
    await wizard.inspect();
  });

  addButton.addEventListener('click', async () => {
    addButton.disabled = true;
    let res = null;
    try {
      // БЕЗ ЕДИНОГО АРГУМЕНТА, И ЭТО ПРАВИЛО, А НЕ УПРОЩЕНИЕ: путь рождается в системном
      // диалоге главного процесса и на страницу не возвращается. Именно на этом держится
      // свойство, ради которого снят маршрут записи, — чужой скрипт здесь не может назначить
      // корень проекта, потому что назначать его нечем.
      res = await shell.addProject();
    } finally {
      addButton.disabled = false;
    }
    if (!res || res.cancelled) return;
    if (res.ok) {
      await refreshAll();
      // Нет в обновлённом списке — просто оставляем список обновлённым, ничего не выдумывая.
      if (state.projects.some((p) => p.id === res.id)) await selectProject(res.id);
      return;
    }
    // ОТКАЗ ПОКАЗЫВАЕТСЯ ТЕКСТОМ ИНСТРУМЕНТА КАК ЕСТЬ, без пересказа: это отказ команды кита,
    // и он объясняет причину лучше, чем мог бы объяснить пересказ словами страницы. Своего
    // места под многострочный текст на странице нет, а заводить его ради одной ветви значило
    // бы расширять задачу; в оболочке это обычное системное окно.
    window.alert(res.message || 'проект не заведён');
  });

  // Подписка на «открыть задачу». Мост шлёт обычное сообщение окна — метод, принимающий
  // обработчик, объявил бы параметр, а у моста ни одна функция ничего не принимает.
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.kind !== shell.openTaskMessage) return;
    openTaskFromShell(data.project, data.task, data.reason);
  });
}

// На старте проект НЕ выбирается сам, и это решение, а не недоделка: запрос одного проекта
// стоит полного обхода отпечатка, а он синхронный и держит цикл событий вместе с терминалом
// (принятый риск 5 фазы 1). Правая колонка при этом не молчит — она говорит, чего ждёт.
tree.load(null);
refreshAll();
