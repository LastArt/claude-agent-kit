#!/usr/bin/env node
/**
 * Собирает карту проекта: что с чем меняется вместе.
 *
 *   node .claude/hooks/map.mjs [ключи]
 *
 * Откуда данные (никакого разбора кода — карта языконезависима):
 *   1. git log — какие файлы попадали в один коммит. Это и есть связи: модули, которые
 *      правят вместе, связаны на деле, а не на бумаге. Работает с первого дня, даже если
 *      кит поставили вчера, а репозиторию два года.
 *   2. .claude/tasks/<id>/ — задачи кита, у каждой своя папка: STATE.md (заголовок, дата,
 *      статус), PLAN.md (из него берутся затронутые файлы), SECURITY.md и REVIEW.md.
 *      Отсюда второй слой связей и подсветка «что трогали в этой доработке». Копии до 1.10
 *      хранили то же самое одной записью на задачу в .claude/artifacts/history/ — этот
 *      источник читается как legacy, с пропуском задач, уже прочитанных из tasks/.
 *   3. .claude/explores/ — сохранённые разведки модулей. Вместе с задачами они образуют
 *      третий уровень карты, «память»: облако накопленного знания о проекте, где связи —
 *      общие файлы, общий модуль и общая тема. Тексты записей вшиваются в страницу, чтобы
 *      по клику открывать их прямо там.
 *
 * На выходе — САМОДОСТАТОЧНЫЙ .claude/map.html: данные вшиты в страницу, никакого сервера
 * и интернета. Файл можно переслать, открыть с флешки, положить в вики.
 *
 * Ключи:
 *   --commits N     сколько последних коммитов смотреть (по умолчанию 400)
 *   --max-nodes N   сколько самых живых модулей оставить на карте (по умолчанию 250)
 *   --files N       сколько самых важных файлов оставить на файловом уровне (по умолчанию 200)
 *   --depth K       до какого уровня пути схлопывать файлы в модуль (по умолчанию 2)
 *   --bulk N        коммит, тронувший больше N файлов, связей не даёт (по умолчанию 25):
 *                   массовый рефакторинг и релизные прогоны иначе связывают всё со всем
 *   --with-kit      не прятать саму папку .claude из карты
 *   --no-code       не вшивать содержимое файлов (карта уедет наружу — код останется дома)
 *   --out ПУТЬ      куда писать (по умолчанию .claude/map.html)
 *   --open          открыть готовую карту в браузере
 *   --json          выдать собранные данные в stdout и ничего не писать (для отладки)
 *
 * Скрипт ничего не меняет в проекте, кроме своего html, и не падает: нет git — соберёт карту
 * по одной истории задач; нет и её — честно скажет, что рисовать нечего.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, lstatSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_ROOT = path.resolve(KIT_DIR, '..');
const TEMPLATE = path.join(KIT_DIR, 'assets', 'map.template.html');
const TASKS = path.join(KIT_DIR, 'tasks');
const HISTORY = path.join(KIT_DIR, 'artifacts', 'history');   // память копий до 1.10
const EXPLORES = path.join(KIT_DIR, 'explores');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  if (i < 0 || i + 1 >= argv.length) return def;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) ? v : def;
};
const optStr = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
};

const COMMITS = Math.max(1, opt('--commits', 400));
const DEPTH = Math.max(1, opt('--depth', 2));
const BULK = Math.max(2, opt('--bulk', 25));
const WITH_KIT = flag('--with-kit');
const MAX_NODES = Math.max(10, opt('--max-nodes', 250));
const MAX_FILES = Math.max(10, opt('--files', 200));
const OUT = path.resolve(PROJECT_ROOT, optStr('--out', path.join(KIT_DIR, 'map.html')));

const out = (s = '') => process.stdout.write(s + '\n');

// -------- git --------
const git = (args) => {
  const r = spawnSync('git', args, { cwd: PROJECT_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? (r.stdout || '') : null;
};
const HAS_GIT = git(['rev-parse', '--is-inside-work-tree']) !== null;

// Мусор, который только зашумляет карту: собранное, привнесённое, залоченное.
const IGNORED = [
  /(^|\/)node_modules\//, /(^|\/)\.git\//, /(^|\/)dist\//, /(^|\/)build\//, /(^|\/)out\//,
  /(^|\/)target\//, /(^|\/)vendor\//, /(^|\/)coverage\//, /(^|\/)\.next\//, /(^|\/)__pycache__\//,
  /(^|\/)bin\//, /(^|\/)obj\//, /\.min\.(js|css)$/,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock)$/,
];
const isIgnored = (f) => IGNORED.some((re) => re.test(f));

// Пути из планов приходят как их написал человек: то с "./", то с обратными слэшами.
// Приводим к одному виду, иначе один и тот же файл раздвоится на карте.
const normPath = (p) => p.replace(/^\.\//, '').replace(/\\/g, '/');

// Модуль = первые DEPTH сегментов пути. Путь короче — значит файл сам себе модуль
// (корневые README, install.sh и прочее видно поимённо, они того стоят).
const toModule = (file) => {
  const parts = file.split('/');
  return parts.length <= DEPTH ? file : parts.slice(0, DEPTH).join('/');
};

// -------- сбор коммитов --------
const SEP_C = '\u0001', SEP_F = '\u0002';
function readCommits() {
  if (!HAS_GIT) return [];
  const raw = git(['log', `-n${COMMITS}`, '--no-merges', '--date=short',
    `--pretty=format:${SEP_C}%H${SEP_F}%ad${SEP_F}%an${SEP_F}%s`, '--name-only']);
  if (!raw) return [];
  const commits = [];
  for (const chunk of raw.split(SEP_C)) {
    if (!chunk.trim()) continue;
    const nl = chunk.indexOf('\n');
    const head = (nl < 0 ? chunk : chunk.slice(0, nl)).split(SEP_F);
    const files = (nl < 0 ? '' : chunk.slice(nl + 1)).split('\n')
      .map((s) => s.trim()).filter(Boolean);
    commits.push({
      hash: (head[0] || '').slice(0, 7), date: head[1] || '',
      author: head[2] || '', subject: head[3] || '', files,
    });
  }
  return commits;
}

// Папка кита в чужом проекте — служебная и карту засоряет. Но если прятать её не ради чего
// (проект — сам кит или правили только .claude), лучше показать, чем отдать пустую карту.
function pickKitVisibility(commits) {
  if (WITH_KIT) return { hideKit: false, forced: false };
  const outside = new Set();
  for (const c of commits) for (const f of c.files) {
    if (!f.startsWith('.claude/') && !isIgnored(f)) outside.add(toModule(f));
  }
  return outside.size >= 3 ? { hideKit: true, forced: false } : { hideKit: false, forced: true };
}

// -------- задачи проекта --------
// Что считается задачей — одно правило на всех читателей `tasks/` (task.mjs, эта карта,
// explorer и /cckit_recall):
//
//   папка внутри tasks/ считается задачей тогда и только тогда, когда её имя проходит
//   ^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*$ и внутри есть STATE.md.
//
// Всё остальное — включая папку без STATE.md (незавершённый перенос) и любые посторонние
// каталоги — пропускается МОЛЧА, без предупреждений и без попыток достроить. Иначе оборванный
// перенос приезжает на карту узлом без заголовка, даты и статуса, а посторонний каталог —
// узлом в памяти проекта.
const TASK_ID_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*$/;

function readTasks() {
  const fromTasks = readTaskDirs();
  const known = new Set(fromTasks.map((t) => t.source));
  // Legacy: одна запись на задачу в artifacts/history/. После миграции та же задача лежит
  // и там, и в tasks/ — на карте она должна быть ОДНА. Имя записи архива собиралось по той же
  // формуле `<дата>-<slug(заголовок)>`, что и имя папки, поэтому совпадение имени и есть
  // совпадение задачи.
  const legacy = readHistory().filter((t) => !known.has(t.source.replace(/\.md$/, '')));
  return [...fromTasks, ...legacy];
}

function readTaskDirs() {
  if (!existsSync(TASKS)) return [];
  let names = [];
  try { names = readdirSync(TASKS); } catch { return []; }
  const tasks = [];
  for (const name of names.sort()) {
    if (!TASK_ID_RE.test(name)) continue;
    const dir = path.join(TASKS, name);
    if (!isPlainDir(dir)) continue;
    const state = readTaskFile(dir, 'STATE.md');
    if (state === null) continue;               // нет STATE.md — задачей не считается
    const plan = readTaskFile(dir, 'PLAN.md') || '';
    const security = readTaskFile(dir, 'SECURITY.md') || '';
    const review = readTaskFile(dir, 'REVIEW.md') || '';
    const fm = frontMatter(state);
    tasks.push({
      title: fm.title || name,
      date: fm.created || name.slice(0, 10),
      status: fm.status || '',
      outcome: outcomeFromReview(review),
      files: filesFromPlan(plan),
      source: name,
      text: joinTask(plan, security, review),
    });
  }
  return tasks;
}

// Память копий до 1.10: задача целиком одной записью, файлы и итог ревью — строками шапки.
function readHistory() {
  if (!existsSync(HISTORY)) return [];
  let names = [];
  try { names = readdirSync(HISTORY).filter((n) => n.endsWith('.md') && n !== 'INDEX.md'); }
  catch { return []; }
  const tasks = [];
  for (const name of names.sort()) {
    let src = '';
    try { src = readFileSync(path.join(HISTORY, name), 'utf8'); } catch { continue; }
    const title = (src.match(/^#\s+(.+)$/m) || [, name.replace(/\.md$/, '')])[1].trim();
    const date = (src.match(/\*\*Дата:\*\*\s*(\S+)/) || [, ''])[1];
    const outcome = (src.match(/\*\*Итог ревью:\*\*\s*(.+)$/m) || [, ''])[1].trim();
    const filesRaw = (src.match(/\*\*Затронутые файлы:\*\*\s*(.+)$/m) || [, ''])[1].trim();
    const files = filesRaw && !/^не указаны/.test(filesRaw)
      ? filesRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];
    tasks.push({ title, date, status: 'done', outcome, files, source: name, text: src });
  }
  return tasks;
}

/**
 * Читаем ТОЛЬКО четыре известных имени и только обычные файлы. lstat не идёт по симлинку
 * намеренно: `tasks/<id>/PLAN.md`, подложенный ссылкой на чужой файл, иначе вшивается прямо
 * в map.html — а карту потом пересылают.
 */
function readTaskFile(dir, name) {
  const file = path.join(dir, name);
  try {
    if (!lstatSync(file).isFile()) return null;
    return readFileSync(file, 'utf8');
  } catch { return null; }
}

function isPlainDir(p) {
  try { return lstatSync(p).isDirectory(); } catch { return false; }
}

function frontMatter(src) {
  const m = String(src).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fields = {};
  if (!m) return fields;
  for (const line of m[1].split(/\r?\n/)) {
    const f = line.match(/^([A-Za-z_][\w-]*)\s*:(.*)$/);
    if (f) fields[f[1]] = f[2].trim();
  }
  return fields;
}

/** Пути из шагов плана: строки вида «_Файл:_ `путь`». Столько же, сколько брал archive-task. */
function filesFromPlan(src) {
  const found = new Set();
  for (const m of String(src).matchAll(/_Файл:_\s*`([^`]+)`/g)) found.add(m[1].trim());
  return [...found].slice(0, 12);
}

/** Итог задачи одной строкой — та же логика, по которой его писал archive-task в шапку записи. */
function outcomeFromReview(src) {
  const text = String(src).trim();
  if (!text) return 'ревью не проводилось';
  if (/^APPROVED\s*$/m.test(text)) return 'APPROVED';
  const counts = ['🔴', '🟡', '⚪'].map((mark) => (text.split(mark).length - 1));
  const [crit, important] = counts;
  if (crit || important) return `замечания: 🔴 ${crit}, 🟡 ${important}`;
  return 'ревью проведено';
}

/** Запись для читалки: три файла задачи одним документом, как это выглядело в архиве. */
function joinTask(plan, security, review) {
  const parts = [String(plan).trim()];
  const sec = String(security).trim();
  const rev = String(review).trim();
  if (sec) parts.push(`---\n\n## Аудит безопасности\n\n${sec}`);
  if (rev) parts.push(`---\n\n## Ревью\n\n${rev}`);
  return parts.filter(Boolean).join('\n\n');
}

// -------- кэш разведок как часть памяти --------
// Разведка модуля — такое же знание о проекте, как и завершённая задача: где что живёт,
// обо что споткнулись. На карте памяти она стоит рядом с задачами и связывает их по модулю.
function readExplores() {
  if (!existsSync(EXPLORES)) return [];
  let names = [];
  try { names = readdirSync(EXPLORES).filter((n) => n.endsWith('.md') && n !== 'INDEX.md'); }
  catch { return []; }
  const found = [];
  for (const name of names.sort()) {
    let src = '';
    try { src = readFileSync(path.join(EXPLORES, name), 'utf8'); } catch { continue; }
    const mod = (src.match(/^module:\s*(.+)$/m) || [, ''])[1].trim();
    const date = (src.match(/^date:\s*(.+)$/m) || [, ''])[1].trim();
    const commit = (src.match(/^git_commit:\s*(.+)$/m) || [, ''])[1].trim();
    found.push({
      module: mod || name.replace(/\.md$/, '').split('__').join('/'),
      date, commit, source: name, text: src,
    });
  }
  return found;
}

// Слова заголовка, по которым задачи тянутся друг к другу тематически. Стемминга нет и
// не надо: сравниваем начала слов — «кэшировани» и «кэширование» сходятся, а короткие
// служебные слова отсекаются длиной.
const STOP = new Set([
  'после', 'перед', 'через', 'между', 'когда', 'чтобы', 'также', 'более', 'менее', 'может',
  'нужно', 'новый', 'новая', 'новое', 'общий', 'общая', 'самый', 'этого', 'который', 'которая',
  'этот', 'эта', 'все', 'всех', 'для', 'над', 'под', 'при', 'без', 'from', 'with', 'that', 'this',
]);
function topicKeys(text) {
  const out = new Set();
  for (const raw of String(text).toLowerCase().split(/[^0-9a-zа-яё_]+/)) {
    if (raw.length < 5 || STOP.has(raw)) continue;
    out.add(raw.slice(0, 6));   // грубая основа слова: хватает, чтобы сцепить однокоренные
  }
  return out;
}

// -------- сборка графа --------
const commits = readCommits();
const { hideKit, forced } = pickKitVisibility(commits);
const visible = (f) => !isIgnored(f) && (!hideKit || !f.startsWith('.claude/'));
const tasks = readTasks();

const MAX_LINKS = 2000;
const groupOf = (id) => id.split('/')[0];

/**
 * Граф собирается на двух уровнях: «модули» (папки — общая картина, с чего начинают смотреть)
 * и «файлы» (конкретика — что именно правят). Разница только в том, во что превращать путь
 * и сколько узлов оставить, поэтому сборка живёт в одной функции.
 *
 * Важность узла = как часто его правят + сколько задач кита через него прошло. Задача весит
 * втрое: это осознанная доработка, а не случайное соседство в одном прогоне. По этой важности
 * и отбираются «те самые» файлы, когда их в проекте тысячи.
 */
function buildLevel(idOf, cap) {
  const nodes = new Map();
  const touch = (id) => {
    if (!nodes.has(id)) {
      nodes.set(id, { id, commits: 0, files: new Set(), first: '', last: '', tasks: [] });
    }
    return nodes.get(id);
  };
  let bulkSkipped = 0;

  // первый проход — узлы и их вес
  for (const c of commits) {
    const ids = new Set();
    for (const f of c.files) {
      if (!visible(f)) continue;
      const id = idOf(f);
      touch(id).files.add(f);
      ids.add(id);
    }
    for (const id of ids) {
      const n = nodes.get(id);
      n.commits++;
      if (c.date) {
        if (!n.last || c.date > n.last) n.last = c.date;
        if (!n.first || c.date < n.first) n.first = c.date;
      }
    }
    if (c.files.length > BULK) bulkSkipped++;
  }

  const taskIds = tasks.map((t) => {
    const ids = new Set();
    for (const f of t.files) {
      const norm = normPath(f);
      if (!visible(norm)) continue;
      const id = idOf(norm);
      touch(id).files.add(norm);
      ids.add(id);
    }
    return [...ids];
  });
  taskIds.forEach((ids, ti) => { for (const id of ids) nodes.get(id).tasks.push(ti); });

  const all = [...nodes.values()].map((n) => ({
    id: n.id,
    group: groupOf(n.id),
    commits: n.commits,
    files: n.files.size,
    first: n.first,
    last: n.last,
    tasks: n.tasks,
    score: n.commits + n.tasks.length * 3,
  })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  const keptList = all.slice(0, cap);
  const kept = new Set(keptList.map((n) => n.id));

  // второй проход — связи, и только между теми, кто остался на карте
  const links = new Map();
  const bind = (a, b, kind) => {
    if (a === b || !kept.has(a) || !kept.has(b)) return;
    const key = a < b ? a + '\u0000' + b : b + '\u0000' + a;
    if (!links.has(key)) links.set(key, { git: 0, task: 0 });
    links.get(key)[kind]++;
  };
  for (const c of commits) {
    if (c.files.length > BULK) continue;   // массовая правка связей не доказывает
    const ids = [...new Set(c.files.filter(visible).map(idOf))];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) bind(ids[i], ids[j], 'git');
    }
  }
  taskIds.forEach((ids) => {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) bind(ids[i], ids[j], 'task');
    }
  });

  const linkList = [...links.entries()]
    .map(([key, w]) => {
      const p = key.split('\u0000');
      return { source: p[0], target: p[1], git: w.git, task: w.task };
    })
    .sort((a, b) => (b.git + b.task * 2) - (a.git + a.task * 2));

  return {
    nodes: keptList,
    links: linkList.slice(0, MAX_LINKS),
    total: all.length,
    dropped: all.length - keptList.length,
    linksTotal: linkList.length,
    linksDropped: Math.max(0, linkList.length - MAX_LINKS),
    bulkSkipped,
    taskIds,
  };
}

// -------- уровень памяти --------
// Третий взгляд на проект: не код, а то, что о нём надумано. Узлы — завершённые задачи
// и сохранённые разведки, связи — общие файлы, общий модуль и общая тема в заголовке.
// Получается облако накопленного знания: видно, вокруг чего проект вертится и что с чем
// в голове связано, а клик открывает саму запись целиком.
function buildMemory() {
  const explores = readExplores();
  const nodes = [];

  tasks.forEach((t, i) => {
    const files = t.files.map(normPath).filter(visible);
    nodes.push({
      id: 'task:' + (t.source || i),
      kind: 'task',
      title: t.title,
      date: t.date,
      subtitle: t.outcome,
      group: 'задачи',
      files,
      modules: [...new Set(files.map(toModule))],
      topics: topicKeys(t.title),
      score: 2 + files.length,
      taskIndex: i,
    });
  });

  explores.forEach((e) => {
    nodes.push({
      id: 'explore:' + e.source,
      kind: 'explore',
      title: e.module,
      date: e.date,
      subtitle: e.commit ? 'разведка на ' + e.commit : 'разведка',
      group: 'разведки',
      files: [],
      modules: [e.module, toModule(e.module)],
      topics: topicKeys(e.module),
      score: 3,
      taskIndex: -1,
    });
  });

  const links = new Map();
  const bind = (a, b, kind, add) => {
    const key = a < b ? a + '\u0000' + b : b + '\u0000' + a;
    if (!links.has(key)) links.set(key, { git: 0, task: 0 });
    links.get(key)[kind] += add;
  };

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];

      // общие файлы — самая крепкая связь: две задачи правили одно и то же
      const shared = a.files.filter((f) => b.files.indexOf(f) >= 0).length;
      if (shared) bind(a.id, b.id, 'task', shared * 2);

      // общий модуль — задача и разведка про одно место в коде
      const sameModule = a.modules.some((m) => b.modules.indexOf(m) >= 0);
      if (sameModule && !shared) bind(a.id, b.id, 'task', 1);

      // общая тема в заголовке — то самое «об одном и том же думали»
      let topics = 0;
      a.topics.forEach((k) => { if (b.topics.has(k)) topics++; });
      if (topics) bind(a.id, b.id, 'git', topics);
    }
  }

  const packed = nodes
    .map((n) => ({
      id: n.id, kind: n.kind, group: n.group, title: n.title, date: n.date,
      subtitle: n.subtitle, commits: 0, files: n.files.length, score: n.score,
      first: n.date, last: n.date, tasks: n.taskIndex >= 0 ? [n.taskIndex] : [],
    }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  const linkList = [...links.entries()]
    .map(([key, w]) => {
      const p = key.split('\u0000');
      return { source: p[0], target: p[1], git: w.git, task: w.task };
    })
    .sort((a, b) => (b.git + b.task * 2) - (a.git + a.task * 2));

  // Документы для читалки: markdown как есть, страница отрисует его сама.
  const docs = {};
  tasks.forEach((t, i) => {
    docs['task:' + (t.source || i)] = { title: t.title, date: t.date, kind: 'задача', text: clampDoc(t.text) };
  });
  explores.forEach((e) => {
    docs['explore:' + e.source] = { title: e.module, date: e.date, kind: 'разведка', text: clampDoc(e.text) };
  });

  return {
    nodes: packed,
    links: linkList.slice(0, MAX_LINKS),
    total: packed.length,
    dropped: 0,
    linksTotal: linkList.length,
    linksDropped: Math.max(0, linkList.length - MAX_LINKS),
    docs,
    exploresFound: explores.length,
  };
}

// Записи бывают длинными, а страница носит их в себе. Режем по-честному и говорим об этом
// прямо в тексте, чтобы никто не решил, что документ на этом и заканчивается.
const DOC_LIMIT = 60000;

// Служебная шапка разведки (module / date / git_commit) в читалке не нужна: эти поля уже
// вынесены в заголовок карточки, а в тексте они выглядят мусором.
function stripFrontmatter(text) {
  const t = String(text || '');
  if (!t.startsWith('---')) return t;
  const close = t.indexOf('\n---', 3);
  if (close < 0) return t;
  const after = t.indexOf('\n', close + 1);
  return after < 0 ? '' : t.slice(after + 1).replace(/^\s+/, '');
}

function clampDoc(text) {
  const s = stripFrontmatter(text);
  if (s.length <= DOC_LIMIT) return s;
  return s.slice(0, DOC_LIMIT) + '\n\n---\n\n_(запись длиннее ' + DOC_LIMIT
    + ' знаков — здесь показано начало, целиком она лежит в папке своей задачи '
    + '`.claude/tasks/<id>/`, а для копий до 1.10 — в `.claude/artifacts/history/`)_\n';
}

// -------- содержимое файлов для читалки --------
// Клик по файлу должен открывать сам файл, иначе карта обрывается на полуслове. Вшиваем
// содержимое только тех файлов, что реально попали на карту, и только текстовых — с потолком
// на файл и общим бюджетом, чтобы страница не превратилась в архив репозитория.
// Ключ --no-code отключает это целиком: бывает, что карту отдают наружу, а код показывать нельзя.
const NO_CODE = flag('--no-code');
const FILE_LIMIT = 80000;
const CODE_BUDGET = 6000000;
const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'avif', 'pdf', 'zip', 'gz', 'tar', 'rar',
  '7z', 'exe', 'dll', 'so', 'dylib', 'class', 'jar', 'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'mp4', 'mov', 'avi', 'wav', 'psd', 'ai', 'sqlite', 'db', 'bin', 'pyc',
]);

function collectFileDocs(fileNodes) {
  const docs = {};
  const stat = { embedded: 0, missing: 0, binary: 0, budget: 0, chars: 0 };
  if (NO_CODE) return { docs, stat, off: true };

  for (const n of fileNodes) {
    const ext = (n.id.split('.').pop() || '').toLowerCase();
    if (BINARY_EXT.has(ext)) { stat.binary++; continue; }

    const abs = path.join(PROJECT_ROOT, n.id);
    let text = '';
    try { text = readFileSync(abs, 'utf8'); }
    catch { stat.missing++; continue; }   // файл переименован или удалён — в истории он есть, на диске нет

    // Признак двоичного: нулевой байт в начале. Дешевле и надёжнее, чем гадать по расширению.
    if (text.slice(0, 8000).indexOf('\u0000') >= 0) { stat.binary++; continue; }

    if (stat.chars + Math.min(text.length, FILE_LIMIT) > CODE_BUDGET) { stat.budget++; continue; }

    let clipped = false;
    if (text.length > FILE_LIMIT) { text = text.slice(0, FILE_LIMIT); clipped = true; }
    stat.chars += text.length;
    stat.embedded++;

    const isMd = ext === 'md' || ext === 'markdown';
    docs[n.id] = {
      title: n.id,
      date: n.last || '',
      kind: 'файл',
      lines: text.split('\n').length,
      code: !isMd,          // markdown показываем как документ, остальное — как исходник
      clipped,
      text,
    };
  }
  return { docs, stat, off: false };
}

const levelModule = buildLevel(toModule, MAX_NODES);
const levelFile = buildLevel((f) => f, MAX_FILES);
const levelMemory = buildMemory();
const fileDocs = collectFileDocs(levelFile.nodes);

let version = '';
try { version = (readFileSync(path.join(KIT_DIR, 'VERSION'), 'utf8').split('\n')[0] || '').trim(); }
catch { /* нет файла */ }
let generated = '';
try { generated = new Date().toISOString().slice(0, 10); } catch { /* без даты */ }

const packLevel = (lv) => ({
  nodes: lv.nodes,
  links: lv.links,
  total: lv.total,
  dropped: lv.dropped,
  linksTotal: lv.linksTotal,
  linksDropped: lv.linksDropped,
});

const data = {
  project: path.basename(PROJECT_ROOT),
  generated,
  version,
  meta: {
    hasGit: HAS_GIT,
    commitsScanned: commits.length,
    commitsRequested: COMMITS,
    bulkSkipped: levelModule.bulkSkipped,
    bulkLimit: BULK,
    depth: DEPTH,
    hideKit,
    kitForced: forced,
    maxNodes: MAX_NODES,
    maxFiles: MAX_FILES,
    tasksFound: tasks.length,
    exploresFound: levelMemory.exploresFound,
    code: {
      off: fileDocs.off,
      embedded: fileDocs.stat.embedded,
      missing: fileDocs.stat.missing,
      binary: fileDocs.stat.binary,
      budget: fileDocs.stat.budget,
      limit: FILE_LIMIT,
    },
  },
  levels: {
    module: packLevel(levelModule),
    file: packLevel(levelFile),
    memory: packLevel(levelMemory),
  },
  // Читалка одна на всю карту: и записи памяти, и содержимое файлов лежат в общем словаре.
  docs: Object.assign({}, levelMemory.docs, fileDocs.docs),
  tasks: tasks.map((t, i) => ({
    title: t.title,
    date: t.date,
    status: t.status,
    outcome: t.outcome,
    files: t.files,
    module: levelModule.taskIds[i],
    file: levelFile.taskIds[i],
    // на уровне памяти задача — это сам узел, так подсветка работает одинаково везде
    memory: ['task:' + (t.source || i)],
  })),
};

if (flag('--json')) { out(JSON.stringify(data, null, 2)); process.exit(0); }

if (!levelModule.nodes.length && !levelFile.nodes.length && !levelMemory.nodes.length) {
  out('Рисовать нечего: не нашлось ни коммитов с файлами, ни задач в .claude/tasks/.');
  out(HAS_GIT
    ? 'Репозиторий пуст или всё попало под фильтр — попробуй --with-kit.'
    : 'Проект вне git — карта соберётся, когда накопится история задач кита.');
  process.exit(0);
}

// -------- страница --------
if (!existsSync(TEMPLATE)) {
  out(`Нет шаблона ${path.relative(PROJECT_ROOT, TEMPLATE)} — карту собрать не из чего.`);
  process.exit(0);
}
let html = '';
try { html = readFileSync(TEMPLATE, 'utf8'); }
catch (err) { out(`Не смог прочитать шаблон: ${err.message}`); process.exit(0); }

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// split/join, а не replace: плейсхолдер встречается в шаблоне не один раз
// (заголовок вкладки и шапка), а строковый replace меняет только первое вхождение.
html = html
  .split('{{PROJECT}}').join(esc(data.project))
  .split('{{VERSION}}').join(esc(version || '—'))
  // Данные вшиваем в <script type="application/json">, поэтому рвём только последовательность,
  // которой браузер закрывает тег. Всё остальное JSON переживает как есть.
  .split('{{DATA}}').join(JSON.stringify(data).split('</script').join('<\\/script'));

try { writeFileSync(OUT, html, 'utf8'); }
catch (err) { out(`Не смог записать карту: ${err.message}`); process.exit(0); }

const rel = path.relative(PROJECT_ROOT, OUT) || OUT;
out(`Карта собрана: ${rel}`);
const cap = (lv, key) => lv.dropped ? ` (ещё ${lv.dropped} тише прочих скрыто, показать: ${key} ${lv.total})` : '';
out(`Модули: ${levelModule.nodes.length}${cap(levelModule, '--max-nodes')} · связей ${levelModule.links.length}`);
out(`Файлы: ${levelFile.nodes.length}${cap(levelFile, '--files')} · связей ${levelFile.links.length}`);
if (fileDocs.off) {
  out('Содержимое файлов не вшито (--no-code) — читалка откроет только записи памяти.');
} else {
  const s = fileDocs.stat;
  const tail = [];
  if (s.missing) tail.push(`${s.missing} нет в рабочей копии`);
  if (s.binary) tail.push(`${s.binary} двоичных`);
  if (s.budget) tail.push(`${s.budget} не влезло в бюджет страницы`);
  out(`Файлов доступно для чтения в карте: ${s.embedded}` + (tail.length ? ` (${tail.join(', ')})` : ''));
}
out(`Память: ${levelMemory.nodes.length} ` +
  `(задач ${tasks.length}, разведок ${levelMemory.exploresFound}) · связей ${levelMemory.links.length}`);
if (HAS_GIT) {
  out(`Просмотрено коммитов: ${commits.length}`
    + `${levelModule.bulkSkipped ? `, из них ${levelModule.bulkSkipped} массовых (>${BULK} файлов) связей не дали` : ''}.`);
} else {
  out('git в проекте не найден — связи взяты только из истории задач.');
}
if (forced) out('Папка .claude/ показана: без неё карта осталась бы пустой.');
else if (hideKit) out('Папка .claude/ скрыта как служебная — показать: --with-kit.');

if (flag('--open')) {
  const p = process.platform;
  const cmd = p === 'win32' ? ['cmd', ['/c', 'start', '', OUT]]
    : p === 'darwin' ? ['open', [OUT]]
    : ['xdg-open', [OUT]];
  try { spawnSync(cmd[0], cmd[1], { stdio: 'ignore', detached: true }); }
  catch { out('Открыть в браузере не получилось — откройте файл вручную.'); }
}
