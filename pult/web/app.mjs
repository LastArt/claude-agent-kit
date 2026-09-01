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
 * Один запрос. Наружу отдаётся `{ok, status, body}` и НИКОГДА исключение: у демона отказ —
 * это тело с машинным кодом (`code`), а не обрыв, и страница обязана уметь его показать.
 * Сеть здесь всегда своя, петлевая: адреса относительные, чужих источников нет.
 */
async function req(url, init) {
  try {
    const res = await fetch(url, init);
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { ok: res.ok, status: res.status, body };
  } catch {
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
  },
  verdict: { match: 'сходится', mismatch: 'расхождение', unknown: 'неизвестно' },
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
  setText(badge, `отпечаток: ${word(WORDS.verdict, verdict)}`);
  setState(badge, verdict === 'match' ? 'is-ok' : (verdict === 'mismatch' ? 'is-alarm' : 'is-warn'),
    ['is-ok', 'is-warn', 'is-alarm']);

  const diverged = (p.fingerprint && p.fingerprint.diverged) || [];
  setText($('card-diverged'), diverged.length
    ? `расходится: ${diverged.slice(0, 12).join(', ')}${p.fingerprint.truncated ? ' …' : ''}`
    : '');

  const tasks = $('card-tasks');
  clear(tasks);
  const items = p.tasks || (p.active_task ? [p.active_task] : []);
  for (const t of items) {
    const li = el('li', 'task');
    if (t.id === state.task) li.classList.add('is-active');
    li.appendChild(el('span', 'task-name', t.title || t.id));
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

// На старте проект НЕ выбирается сам, и это решение, а не недоделка: запрос одного проекта
// стоит полного обхода отпечатка, а он синхронный и держит цикл событий вместе с терминалом
// (принятый риск 5 фазы 1). Правая колонка при этом не молчит — она говорит, чего ждёт.
tree.load(null);
refreshAll();
