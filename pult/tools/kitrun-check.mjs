#!/usr/bin/env node
/**
 * ПОСТОЯННЫЕ МАШИННЫЕ ПРОВЕРКИ ЗАПУСКА КОМАНД НАБОРА: словарь, дословность, подтверждение.
 *
 *   node pult/tools/kitrun-check.mjs [каталог для стендов] [--negative <имя пробы>]
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ИНСТРУМЕНТ. `pult/tools/shell-check.mjs` меряет ОБОЛОЧКУ и без Electron
 * честно отвечает «ничего не доказано»; `pult/tools/deploy-check.mjs` меряет РАСКЛАДКУ.
 * Запуск команд набора живёт в `pult/shell/kit-commands.mjs` и Electron не требует вовсе —
 * значит его проверка обязана идти всюду, где есть Node, а не только там, где стоит оболочка.
 *
 * ЧТО МЕРИТСЯ:
 *
 *   1. СЛОВАРЬ И ТАБЛИЦА. Ключи таблицы совпадают с двумя списками `pult/config.mjs`; каждый
 *      массив аргументов ЗАМОРОЖЕН; свободного текста в аргументах нет ни одного; команд
 *      с произвольной строкой (`task.mjs new`, `task.mjs log`) в таблице нет.
 *
 *   2. ДОСЛОВНОСТЬ. Вывод читающей команды, полученный через модуль, совпадает с прямым
 *      запуском той же команды в терминале ПОСИМВОЛЬНО — оба потока и код возврата. Это и есть
 *      критерий готовности фазы «отказ команды набора показан человеку дословно».
 *
 *   3. ОТКАЗ — ТОЖЕ ДОСЛОВНО. Команда с ненулевым кодом возврата отдаёт тот же текст и тот же
 *      код, что и в терминале: пересказа нет ни в одной ветви.
 *
 *   4. МЕНЯЮЩИЙ КЛЮЧ БЕЗ ПОДТВЕРЖДЕНИЯ НЕ ИСПОЛНЯЕТСЯ. Отказ приходит своим кодом,
 *      и папка набора стенда не меняется ни одним байтом.
 *
 *   5. ЧИТАЮЩИЙ КЛЮЧ НЕ МЕНЯЕТ НИ БАЙТА — по ВСЕМ читающим ключам сразу, снимком всего
 *      стенда до и после. Заведено по 🔴 ревью 03.09.2026: ключ «класс риска» выглядел
 *      читающим, а писал в `STATE.md` и молча понижал класс, — и прошёл мимо аппаратуры
 *      именно потому, что про читающие ключи не утверждалось ничего.
 *
 *   6. САНИТАРИЯ ВХОДА. Неизвестный ключ, чужой идентификатор, идентификатор не той формы
 *      и ОТВЕРГНУТЫЙ КОРЕНЬ — каждый своим кодом отказа, и ни один не запускает процесса.
 *
 * ЧЕГО ЭТОТ ИНСТРУМЕНТ НЕ МЕРИТ, И ЭТО НАЗВАНО ЗДЕСЬ, А НЕ ПОДРАЗУМЕВАЕТСЯ: он не проверяет
 * ОКНО ПОДТВЕРЖДЕНИЯ — оно живёт в главном процессе Electron (`pult/shell/main.mjs`) и без
 * Electron не существует. Проверяется то, что БЕЗ признака подтверждения команда не идёт;
 * что признак ставит именно человек через системное окно, держится разбором кода и ручным
 * пунктом протокола приёмки.
 *
 * НАЗВАННЫЙ ОСТАТОК: У ПРОВЕРКИ 5 НЕТ СВОЕЙ ОТДЕЛЬНОЙ ПРОБЫ (решение человека 03.09.2026 —
 * записать, а не чинить). Проба `kitreadonly` красит ДВЕ проверки сразу, 4 и 5, и обе строки
 * верны об одном и том же уроне; но у проверки 4 своя проба есть (`kitconfirm`), а проверка 5
 * своего сторожа не имеет. Следствие называется прямо: **удаление проверки 5 набор проб
 * не заметит** — `kitreadonly` продолжит краснеть проверкой 4, и прогон останется красным
 * по «правильной» причине. Это граница утверждения аппаратуры, а не долг: закрывается она
 * пробой, которая красит ТОЛЬКО проверку 5 (например, возвращает в копию ключ, который
 * пишет, не трогая деления словарей).
 *
 * СТЕНД СВОЙ, БОЕВОЕ НЕ ТРОГАЕТСЯ: копия модулей пульта во временном каталоге, проект-стенд
 * с настоящими хуками набора, СВОЙ реестр через `APPDATA`/`XDG_CONFIG_HOME`.
 *
 * КОДЫ ВОЗВРАТА: 0 — всё зелено; 1 — проверка провалилась (для отрицательной пробы это
 * ожидаемый исход); 2 — проба НЕ покраснела; 3 — прогон ничего не доказывает.
 */

import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile, realpath, lstat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PULT = path.resolve(HERE, '..');
const REPO = path.resolve(PULT, '..');
const KIT_HOOKS = path.join(REPO, '.claude', 'hooks');

const NL = String.fromCharCode(10);
const out = (s = '') => process.stdout.write(`${s}${NL}`);
const err = (s = '') => process.stderr.write(`[pult] ${s}${NL}`);

/** Копируются только модули, нужные запуску команд: страница и Electron стенду не нужны. */
const MIRROR_DIRS = ['lib', 'shell'];
const MIRROR_FILES = ['config.mjs'];

/**
 * КАТАЛОГ ХУКОВ КОПИРУЕТСЯ ЦЕЛИКОМ, а не двумя файлами: хуки набора импортируют друг друга
 * (`task.mjs` тянет `md-fence.mjs`), и стенд из двух файлов падал бы на разрешении модуля —
 * то есть проверка сравнивала бы ПУСТОЙ вывод с ПУСТЫМ и не могла бы покраснеть.
 */
const STAND_HOOKS_DIR = KIT_HOOKS;

// --- отрицательные пробы ------------------------------------------------------

const PROBES = Object.freeze({
  kitfreeze: {
    what: 'аргумент команды собирается конкатенацией, а массив перестаёт быть замороженным',
    edits: [{
      file: 'shell/kit-commands.mjs',
      from: "    args: Object.freeze(['list']),",
      to: "    args: ['li' + 'st'],",
    }],
  },
  kitkeys: {
    what: 'словарь ключей в константах расходится с таблицей аргументов',
    edits: [{
      file: 'config.mjs',
      from: "  'task_path',         // task.mjs path",
      to: '',
    }],
  },
  kitreadonly: {
    what: 'меняющий состояние ключ объявлен читающим — «читающая» кнопка начинает писать в проект',
    edits: [
      { file: 'config.mjs', from: "  'status_done',         // task.mjs status done", to: '' },
      {
        file: 'config.mjs',
        from: "  'task_list',         // task.mjs list",
        to: [
          "  'task_list',         // task.mjs list",
          "  'status_done',       // проба: перенесён в читающие",
        ].join(NL),
      },
      {
        file: 'shell/kit-commands.mjs',
        from: [
          "    args: Object.freeze(['status', 'done']),",
          '    changes: true,',
        ].join(NL),
        to: [
          "    args: Object.freeze(['status', 'done']),",
          '    changes: false,',
        ].join(NL),
      },
    ],
  },
  kitverbatim: {
    what: 'вывод «улучшается» обрезкой пробелов — дословность теряется молча',
    edits: [{
      file: 'shell/kit-commands.mjs',
      from: '    stdout: capText(run.stdout, OUT_MAX_BYTES).text,',
      to: '    stdout: capText(run.stdout, OUT_MAX_BYTES).text.trim(),',
    }],
  },
  kitconfirm: {
    what: 'меняющий состояние ключ исполняется без подтверждения главного процесса',
    edits: [{
      file: 'shell/kit-commands.mjs',
      from: '  if (command.changes && options.confirmed !== true) {',
      to: '  if (false) {',
    }],
  },
});

// --- служебное ----------------------------------------------------------------

async function patchText(file, from, to) {
  const text = await readFile(file, 'utf8');
  const parts = text.split(from);
  if (parts.length !== 2) return { ok: false, hits: parts.length - 1 };
  await writeFile(file, parts.join(to), 'utf8');
  return { ok: true, hits: 1 };
}

async function mirror(dst) {
  await mkdir(dst, { recursive: true });
  let copied = 0;
  for (const name of MIRROR_FILES) {
    await copyFile(path.join(PULT, name), path.join(dst, name));
    copied += 1;
  }
  for (const dir of MIRROR_DIRS) {
    await mkdir(path.join(dst, dir), { recursive: true });
    for (const name of (await readdir(path.join(PULT, dir))).sort()) {
      if (!name.endsWith('.mjs')) continue;
      await copyFile(path.join(PULT, dir, name), path.join(dst, dir, name));
      copied += 1;
    }
  }
  return copied;
}

/** Снимок дерева: относительный путь → хеш и размер. Нужен, чтобы поймать чужую запись. */
async function snapshot(root) {
  const map = new Map();
  const walk = async (dir, rel) => {
    let names;
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const abs = path.join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = await lstat(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) { await walk(abs, relPath); continue; }
      if (!st.isFile()) continue;
      let hash = '';
      try {
        hash = createHash('sha256').update(await readFile(abs)).digest('hex');
      } catch {
        hash = 'не прочитан';
      }
      map.set(relPath, `${st.size}:${hash}`);
    }
  };
  await walk(root, '');
  return map;
}

function diff(before, after) {
  const changed = [];
  for (const [rel, v] of before.entries()) {
    const w = after.get(rel);
    if (w === undefined) changed.push(`пропал ${rel}`);
    else if (w !== v) changed.push(`изменился ${rel}`);
  }
  for (const rel of after.keys()) if (!before.has(rel)) changed.push(`появился ${rel}`);
  return changed;
}

/** Стенд-проект: настоящие хуки набора и пустая папка задач. */
async function makeStand(parent) {
  const root = path.join(parent, 'проект');
  await mkdir(path.join(root, '.claude', 'hooks'), { recursive: true });
  await mkdir(path.join(root, '.claude', 'tasks'), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'index.js'), `код${NL}`);
  for (const name of (await readdir(STAND_HOOKS_DIR)).sort()) {
    if (!name.endsWith('.mjs')) continue;
    await copyFile(path.join(STAND_HOOKS_DIR, name), path.join(root, '.claude', 'hooks', name));
  }

  // НАСТОЯЩАЯ ЗАДАЧА, А НЕ ПУСТОЙ СПИСОК: сравнение пустого вывода с пустым ничего
  // не доказывает и не умеет покраснеть. С задачей `task.mjs list` печатает строки,
  // и дословность становится проверяемой.
  const taskId = '2026-01-01-stend-proverki';
  await mkdir(path.join(root, '.claude', 'tasks', taskId), { recursive: true });
  await writeFile(path.join(root, '.claude', 'tasks', taskId, 'STATE.md'), [
    '---',
    `id: ${taskId}`,
    'title: Стенд проверки запуска команд',
    'status: planning',
    'class: elevated',
    'created: 2026-01-01 00:00',
    'updated: 2026-01-01 00:00',
    '---',
    '',
  ].join(NL));
  await writeFile(path.join(root, '.claude', 'tasks', 'ACTIVE'), `${taskId}${NL}`);

  // ПАПКА ЗАДАЧИ ОБОРУДУЕТСЯ ЦЕЛИКОМ, А НЕ ОДНИМ СОСТОЯНИЕМ — по 🟡 ревью 03.09.2026.
  //
  // Стенд был СЛЕП к тому классу ошибки, ради которого заведена проверка 5. Ревью вернуло
  // исходный дефект (ключ «класс риска» как читающий) и увидело «не тронул»: `cmdClass()`
  // в `.claude/hooks/task.mjs` начинается с отказа, если `PLAN.md` нет или он пуст, — команда
  // падала РАНЬШЕ, чем успевала записать, и выглядела невинной. Утверждение было построено
  // верно, недооборудован был стенд.
  //
  // Поэтому здесь лежат ВСЕ формы задачи, а не только те, что нужны сегодняшним ключам
  // (решение человека): следующий добавленный ключ не должен упереться в ту же слепоту.
  // План намеренно объявляет класс НИЖЕ пола по путям: так `cmdClass()` записывает другое
  // значение, и запись видна снимком — то есть проверка меряет то, что обещает.
  await writeFile(path.join(root, '.claude', 'tasks', taskId, 'PLAN.md'), [
    '# PLAN — стенд проверки запуска команд',
    '',
    '## Шаги',
    '',
    '- [ ] **1. Правка исходников** — _Файл:_ `src/index.js` — _Действие:_ ничего не делать —'
      + ' _Проверка:_ ничего не проверять',
    '',
    '## Класс риска',
    '',
    '`cosmetic`',
    '',
  ].join(NL));
  await writeFile(path.join(root, '.claude', 'tasks', taskId, 'REVIEW.md'), [
    '---',
    'verdict: approved',
    'critical: 0',
    'important: 0',
    'minor: 0',
    '---',
    '',
    '# REVIEW — стенд проверки',
    '',
  ].join(NL));
  await writeFile(path.join(root, '.claude', 'tasks', taskId, 'DONE.md'), [
    '# DONE — стенд проверки',
    '',
    '## Что сделано',
    '',
    '- ничего: это стенд',
    '',
  ].join(NL));
  return root;
}

/** Прямой запуск той же команды — эталон дословности. */
function direct(root, hook, args) {
  const res = spawnSync(process.execPath, [path.join(root, '.claude', 'hooks', hook), ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  });
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

// --- прогон -------------------------------------------------------------------

function parseArgs(argv) {
  const args = { dir: null, negative: null, help: false, bad: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { args.help = true; continue; }
    if (a === '--negative') { args.negative = argv[i + 1] || ''; i += 1; continue; }
    if (a.startsWith('--negative=')) { args.negative = a.slice('--negative='.length); continue; }
    if (a.startsWith('-')) { args.bad = a; return args; }
    args.dir = a;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    out('Постоянные машинные проверки запуска команд набора:');
    out(`  node pult/tools/kitrun-check.mjs [каталог для стендов] [--negative ${Object.keys(PROBES).join('|')}]`);
    out('Отрицательные пробы правят ТОЛЬКО копию пульта в стенде:');
    for (const [name, p] of Object.entries(PROBES)) out(`  ${name.padEnd(13)} ${p.what}`);
    return 0;
  }
  if (args.bad) { err(`неизвестный ключ: ${args.bad}`); return 3; }
  if (args.negative !== null && !PROBES[args.negative]) {
    err(`проба бывает только: ${Object.keys(PROBES).join(', ')}`);
    return 3;
  }

  const base = args.dir ? path.resolve(args.dir) : os.tmpdir();
  if (base === REPO || base.startsWith(`${REPO}${path.sep}`)) {
    err('каталог стендов обязан быть ВНЕ этого репозитория');
    return 3;
  }

  const parent = await realpath(await mkdtemp(path.join(base, 'pult-kitrun-')));
  const cfg = await realpath(await mkdtemp(path.join(base, 'pult-cfg-')));
  const copyDir = path.join(parent, 'pult');

  const notes = [];
  try {
    const copied = await mirror(copyDir);
    const root = await makeStand(parent);
    out(`стенд: ${parent}`);
    out(`копия модулей: ${copied} · реестр прогона: ${cfg} (боевой не трогается)`);

    if (args.negative) {
      const probe = PROBES[args.negative];
      for (const edit of probe.edits) {
        const r = await patchText(path.join(copyDir, ...edit.file.split('/')), edit.from, edit.to);
        if (!r.ok) {
          err(`проба «${args.negative}» не наложилась на ${edit.file} (вхождений ${r.hits}) — код изменился`);
          return 3;
        }
      }
      out(`ОТРИЦАТЕЛЬНАЯ ПРОБА «${args.negative}»: ${probe.what}`);
    }
    out('');

    // Реестр прогона — свой. Демон и оболочка здесь не поднимаются вовсе.
    process.env.APPDATA = cfg;
    process.env.XDG_CONFIG_HOME = cfg;
    const registry = await import(pathToFileURL(path.join(copyDir, 'lib', 'registry.mjs')).href);
    const added = await registry.addProject(root, 'стенд');
    if (!added.ok) { err(`стенд не завёлся в реестр прогона: ${added.code}`); return 3; }
    const id = added.entry.id;

    // ЗАПИСЬ С ОТВЕРГНУТЫМ КОРНЕМ кладётся в файл реестра НАПРЯМУЮ: `addProject()` такую
    // не примет — она и не должна её принимать, а проверить поведение запуска надо.
    const regFile = registry.registryFile();
    const regData = JSON.parse(await readFile(regFile, 'utf8'));
    const rejectedId = 'ffffffff';
    regData.projects.push({ id: rejectedId, name: 'дом', path: os.homedir(), seen: null });
    await writeFile(regFile, `${JSON.stringify(regData, null, 2)}${NL}`, 'utf8');

    // 1. СЛОВАРЬ И ТАБЛИЦА.
    out('1. словарь и замороженная таблица:');
    let kit = null;
    try {
      kit = await import(pathToFileURL(path.join(copyDir, 'shell', 'kit-commands.mjs')).href);
    } catch (e) {
      out(`  модуль команд не загрузился: ${(e && e.message) || 'ошибка'}  <-- РАСХОЖДЕНИЕ`);
      notes.push('таблица команд разошлась со словарями констант — модуль не загружается');
    }
    if (kit) {
      const config = await import(pathToFileURL(path.join(copyDir, 'config.mjs')).href);
      const keys = Object.keys(kit.KIT_COMMANDS);
      const read = keys.filter((k) => !kit.KIT_COMMANDS[k].changes);
      const write = keys.filter((k) => kit.KIT_COMMANDS[k].changes);
      const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
      const listsOk = sameSet(read, [...config.KIT_READ_KEYS]) && sameSet(write, [...config.KIT_WRITE_KEYS]);
      const frozen = keys.every((k) => Object.isFrozen(kit.KIT_COMMANDS[k].args));
      const plain = keys.every((k) => kit.KIT_COMMANDS[k].args.every((a) => /^[-A-Za-z0-9_.]+$/.test(a)));
      const noFreeText = keys.every((k) => !kit.KIT_COMMANDS[k].args.includes('new') && !kit.KIT_COMMANDS[k].args.includes('log'));
      out(`  ключей ${keys.length} (читающих ${read.length}, меняющих ${write.length}) · списки сходятся ${listsOk ? 'да' : 'НЕТ'}`
        + ` · аргументы заморожены ${frozen ? 'да' : 'НЕТ'} · свободного текста ${plain && noFreeText ? 'нет' : 'ЕСТЬ'}`
        + `${listsOk && frozen && plain && noFreeText ? '' : '  <-- РАСХОЖДЕНИЕ'}`);
      if (!listsOk) notes.push('таблица команд разошлась со списками ключей в константах');
      if (!frozen) notes.push('массив аргументов команды не заморожен — его можно подменить на месте');
      if (!plain || !noFreeText) notes.push('в аргументах команды появился свободный текст');
    }
    out('');

    if (kit) {
      // 2. ДОСЛОВНОСТЬ ЧИТАЮЩЕЙ КОМАНДЫ.
      out('2. вывод читающей команды — дословно:');
      const mine = await kit.runKitCommand(id, 'task_list');
      const theirs = direct(root, 'task.mjs', ['list']);
      // НЕПУСТОТА ПРОВЕРЯЕТСЯ ОТДЕЛЬНО: совпадение двух пустых строк — не дословность,
      // а отсутствие предмета, и проба на «улучшение» вывода на нём не покраснела бы.
      const same = mine.ok === true && mine.stdout === theirs.stdout
        && mine.stderr === theirs.stderr && mine.code === theirs.code
        && theirs.stdout.length > 0;
      out(`  через модуль: код ${mine.code}, символов ${(mine.stdout || '').length}`
        + ` · в терминале: код ${theirs.code}, символов ${theirs.stdout.length}`
        + `${same ? '' : '  <-- РАСХОЖДЕНИЕ'}`);
      if (!same && theirs.stdout.length === 0) notes.push('читающая команда ничего не напечатала — сравнивать нечего');
      else if (!same) notes.push('вывод команды через модуль не совпал с прямым запуском посимвольно');
      out('');

      // 3. ОТКАЗ — ТОЖЕ ДОСЛОВНО.
      out('3. отказ команды — дословно и с кодом:');
      const refusalMine = await kit.runKitCommand(id, 'verify_dry');
      const refusalTheirs = direct(root, 'verify.mjs', ['--dry']);
      const refusalText = refusalTheirs.stdout.length + refusalTheirs.stderr.length;
      const refusalSame = refusalMine.ok === true
        && refusalMine.code === refusalTheirs.code
        && refusalMine.stdout === refusalTheirs.stdout
        && refusalMine.stderr === refusalTheirs.stderr
        && refusalText > 0;
      out(`  код возврата ${refusalMine.code} против ${refusalTheirs.code}`
        + ` · текст совпал ${refusalMine.stdout === refusalTheirs.stdout && refusalMine.stderr === refusalTheirs.stderr ? 'да' : 'НЕТ'}`
        + `${refusalSame ? '' : '  <-- РАСХОЖДЕНИЕ'}`);
      if (!refusalSame && refusalText === 0) notes.push('отказ команды ничего не напечатал — сравнивать нечего');
      else if (!refusalSame) notes.push('отказ команды показан не дословно или с другим кодом возврата');
      out('');

      // 4. МЕНЯЮЩИЙ КЛЮЧ БЕЗ ПОДТВЕРЖДЕНИЯ.
      out('4. меняющий состояние ключ без подтверждения:');
      const before = await snapshot(path.join(root, '.claude'));
      const denied = await kit.runKitCommand(id, 'status_done');
      const after = await snapshot(path.join(root, '.claude'));
      const changes = diff(before, after);
      const deniedOk = denied.ok === false && denied.code === 'not_confirmed';
      out(`  ответ: ${denied.ok === false ? `отказ ${denied.code}` : 'ЗАПУЩЕНО'}`
        + ` · папка набора изменилась: ${changes.length ? changes.join(', ') : 'нет'}`
        + `${deniedOk && !changes.length ? '' : '  <-- РАСХОЖДЕНИЕ'}`);
      if (!deniedOk) notes.push(`меняющий ключ без подтверждения не отбит: ${denied.code || 'запущен'}`);
      if (changes.length) notes.push(`меняющий ключ без подтверждения изменил стенд: ${changes.join(', ')}`);
      out('');

      // 5. ЧИТАЮЩИЙ КЛЮЧ НЕ МЕНЯЕТ НИ БАЙТА — ПО ВСЕМ ЧИТАЮЩИМ КЛЮЧАМ.
      //
      // Утверждение заведено по 🔴 ревью 03.09.2026, и вторая его половина важнее первой.
      // Первая: ключ `task.mjs class` выглядел читающим, а `cmdClass()` правит `STATE.md`
      // и молча ПОНИЖАЕТ класс риска, если план объявляет меньший, — при `cosmetic` аудит
      // безопасности пропускается целиком. Вторая: аппаратура этого не поймала, потому что
      // снимок снимался только вокруг МЕНЯЮЩЕГО ключа, а про читающие не утверждалось
      // ничего. Прогон идёт по ВСЕМ читающим ключам, а не по одному: смысл в том, чтобы
      // следующий добавленный ключ не повторил ту же ошибку незамеченным.
      out('5. читающий ключ не меняет ни байта:');
      const readKeys = Object.keys(kit.KIT_COMMANDS).filter((k) => !kit.KIT_COMMANDS[k].changes);
      let dirty = 0;
      for (const key of readKeys) {
        // Снимок берётся ПО ВСЕМУ СТЕНДУ, а не по папке набора: команда, пишущая рядом
        // с ней, — такое же нарушение утверждения.
        const was = await snapshot(root);
        await kit.runKitCommand(id, key);
        const now = await snapshot(root);
        const touched = diff(was, now);
        if (touched.length) {
          dirty += 1;
          notes.push(`читающий ключ «${key}» изменил проект: ${touched.join(', ')}`);
        }
        out(`  ${key.padEnd(18)}: ${touched.length ? `ИЗМЕНИЛ (${touched.join(', ')})` : 'не тронул'}`
          + `${touched.length ? '  <-- РАСХОЖДЕНИЕ' : ''}`);
      }
      out(`  прогнано читающих ключей: ${readKeys.length}, изменивших проект: ${dirty}`);
      out('');

      // 6. САНИТАРИЯ ВХОДА.
      out('6. санитария входа:');
      const cases = [
        ['неизвестный ключ', await kit.runKitCommand(id, 'нет-такого'), 'unknown_key'],
        ['чужой идентификатор', await kit.runKitCommand('00000000', 'task_list'), 'unknown_project'],
        ['идентификатор не той формы', await kit.runKitCommand('НЕ-ФОРМА', 'task_list'), 'bad_project'],
        ['отвергнутый корень', await kit.runKitCommand(rejectedId, 'task_list'), 'root_rejected'],
      ];
      for (const [name, res, want] of cases) {
        const hit = res.ok === false && res.code === want;
        out(`  ${name.padEnd(28)}: ${res.ok === false ? res.code : 'ЗАПУЩЕНО'} (ожидание ${want})${hit ? '' : '  <-- РАСХОЖДЕНИЕ'}`);
        if (!hit) notes.push(`«${name}»: получено ${res.ok === false ? res.code : 'запуск'}, ожидалось ${want}`);
      }
      out('');
    }
  } finally {
    for (const dir of [parent, cfg]) {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch (e) {
        out(`стенд занят, удалить вручную: ${dir} (${(e && e.code) || 'ошибка'})`);
      }
    }
  }

  if (notes.length) {
    out('расхождения:');
    for (const n of notes) out(`  • ${n}`);
  } else {
    out('расхождений нет: таблица заморожена и сходится со словарями, вывод и отказ дословны,');
    out('меняющий ключ без подтверждения не исполняется, читающие не пишут ни байта,');
    out('чужой вход отбит своим кодом');
  }

  const code = notes.length ? 1 : 0;
  if (args.negative) {
    out('');
    if (code === 1) {
      out(`проба «${args.negative}» покраснела — проверка стережёт то, что обещает`);
      return 1;
    }
    err(`ПРОБА «${args.negative}» НЕ ПОКРАСНЕЛА — проверка ничего не стережёт`);
    return 2;
  }
  return code;
}

main().then((c) => process.exit(c)).catch((e) => {
  err(`не отработал: ${(e && e.stack) || 'ошибка'}`);
  process.exit(3);
});
