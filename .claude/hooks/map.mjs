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
 *   2. .claude/artifacts/history/ — архив задач кита. В шапке каждой записи уже лежит строка
 *      «Затронутые файлы» (её кладёт archive-task.mjs), поэтому задача сразу знает свои модули.
 *      Отсюда второй слой связей и подсветка «что трогали в этой доработке».
 *
 * На выходе — САМОДОСТАТОЧНЫЙ .claude/map.html: данные вшиты в страницу, никакого сервера
 * и интернета. Файл можно переслать, открыть с флешки, положить в вики.
 *
 * Ключи:
 *   --commits N     сколько последних коммитов смотреть (по умолчанию 400)
 *   --max-nodes N   сколько самых живых модулей оставить на карте (по умолчанию 250)
 *   --depth K       до какого уровня пути схлопывать файлы в модуль (по умолчанию 2)
 *   --bulk N        коммит, тронувший больше N файлов, связей не даёт (по умолчанию 25):
 *                   массовый рефакторинг и релизные прогоны иначе связывают всё со всем
 *   --with-kit      не прятать саму папку .claude из карты
 *   --out ПУТЬ      куда писать (по умолчанию .claude/map.html)
 *   --open          открыть готовую карту в браузере
 *   --json          выдать собранные данные в stdout и ничего не писать (для отладки)
 *
 * Скрипт ничего не меняет в проекте, кроме своего html, и не падает: нет git — соберёт карту
 * по одной истории задач; нет и её — честно скажет, что рисовать нечего.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_ROOT = path.resolve(KIT_DIR, '..');
const TEMPLATE = path.join(KIT_DIR, 'assets', 'map.template.html');
const HISTORY = path.join(KIT_DIR, 'artifacts', 'history');

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

// -------- история задач --------
function readTasks() {
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
    tasks.push({ title, date, outcome, files, source: name });
  }
  return tasks;
}

// -------- сборка графа --------
const commits = readCommits();
const { hideKit, forced } = pickKitVisibility(commits);
const visible = (f) => !isIgnored(f) && (!hideKit || !f.startsWith('.claude/'));

const nodes = new Map();   // id -> узел
const links = new Map();   // "a\u0000b" -> { git, task }

function touchNode(id) {
  if (!nodes.has(id)) {
    nodes.set(id, { id, group: id.split('/')[0], commits: 0, files: new Set(), first: '', last: '', tasks: [] });
  }
  return nodes.get(id);
}
function touchLink(a, b, kind) {
  if (a === b) return;
  const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
  if (!links.has(key)) links.set(key, { git: 0, task: 0 });
  links.get(key)[kind]++;
}

let bulkSkipped = 0;
for (const c of commits) {
  const mods = new Set();
  for (const f of c.files) {
    if (!visible(f)) continue;
    const id = toModule(f);
    touchNode(id).files.add(f);
    mods.add(id);
  }
  for (const id of mods) {
    const n = nodes.get(id);
    n.commits++;
    if (c.date) {
      if (!n.last || c.date > n.last) n.last = c.date;
      if (!n.first || c.date < n.first) n.first = c.date;
    }
  }
  if (c.files.length > BULK) { bulkSkipped++; continue; }   // массовая правка связей не доказывает
  const arr = [...mods];
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) touchLink(arr[i], arr[j], 'git');
  }
}

const tasks = readTasks();
tasks.forEach((t, ti) => {
  const mods = new Set();
  for (const f of t.files) {
    const norm = f.replace(/^\.\//, '').split('\\').join('/');
    if (!visible(norm)) continue;
    const id = toModule(norm);
    touchNode(id).files.add(norm);
    mods.add(id);
  }
  t.modules = [...mods];
  for (const id of mods) nodes.get(id).tasks.push(ti);
  const arr = [...mods];
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) touchLink(arr[i], arr[j], 'task');
  }
});

const allNodes = [...nodes.values()]
  .map((n) => ({ id: n.id, group: n.group, commits: n.commits, files: n.files.size, first: n.first, last: n.last, tasks: n.tasks }))
  .sort((a, b) => b.commits - a.commits || a.id.localeCompare(b.id));

// Силовая раскладка на странице перебирает все пары узлов. Сотни — нормально, тысячи — уже
// подвисание, поэтому оставляем самые живые модули, а остальные честно считаем скрытыми.
const nodeList = allNodes.slice(0, MAX_NODES);
const nodesDropped = allNodes.length - nodeList.length;
const kept = new Set(nodeList.map((n) => n.id));

const linkList = [...links.entries()]
  .map(([key, w]) => { const [source, target] = key.split('\u0000'); return { source, target, git: w.git, task: w.task }; })
  .filter((l) => kept.has(l.source) && kept.has(l.target))
  .sort((a, b) => (b.git + b.task * 2) - (a.git + a.task * 2));

const MAX_LINKS = 2000;
const linksShown = linkList.slice(0, MAX_LINKS);

let version = '';
try { version = (readFileSync(path.join(KIT_DIR, 'VERSION'), 'utf8').split('\n')[0] || '').trim(); }
catch { /* нет файла */ }
let generated = '';
try { generated = new Date().toISOString().slice(0, 10); } catch { /* без даты */ }

const data = {
  project: path.basename(PROJECT_ROOT),
  generated,
  version,
  meta: {
    hasGit: HAS_GIT,
    commitsScanned: commits.length,
    commitsRequested: COMMITS,
    bulkSkipped, bulkLimit: BULK,
    depth: DEPTH,
    hideKit, kitForced: forced,
    nodesTotal: allNodes.length,
    nodesDropped,
    maxNodes: MAX_NODES,
    linksTotal: linkList.length,
    linksDropped: Math.max(0, linkList.length - linksShown.length),
    tasksFound: tasks.length,
  },
  nodes: nodeList,
  links: linksShown,
  tasks: tasks.map((t) => ({ title: t.title, date: t.date, outcome: t.outcome, modules: t.modules || [], files: t.files })),
};

if (flag('--json')) { out(JSON.stringify(data, null, 2)); process.exit(0); }

if (!nodeList.length) {
  out('Рисовать нечего: не нашлось ни коммитов с файлами, ни задач в artifacts/history.');
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
out(`Модулей: ${nodeList.length}${nodesDropped ? ` (ещё ${nodesDropped} тише прочих скрыто, показать: --max-nodes ${allNodes.length})` : ''}`
  + ` · связей: ${linksShown.length}`
  + `${data.meta.linksDropped ? ` (ещё ${data.meta.linksDropped} самых слабых не попали)` : ''}`
  + ` · задач из истории: ${tasks.length}`);
if (HAS_GIT) {
  out(`Просмотрено коммитов: ${commits.length}`
    + `${bulkSkipped ? `, из них ${bulkSkipped} массовых (>${BULK} файлов) связей не дали` : ''}.`);
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
