#!/usr/bin/env node
/**
 * ПОСТОЯННЫЕ МАШИННЫЕ ПРОВЕРКИ МАСТЕРА УСТАНОВКИ: слот выбранного пути, отказы и путь в отчёте.
 *
 *   node pult/tools/wizard-check.mjs [каталог для стендов] [--negative <имя пробы>]
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ИНСТРУМЕНТ. `pult/tools/deploy-check.mjs` меряет САМУ РАСКЛАДКУ (шлюз, копию,
 * слияние, снос), `pult/tools/kitrun-check.mjs` — запуск команд набора, а здесь предмет третий:
 * СЛОЙ МАСТЕРА в оболочке — `pult/shell/deploy.mjs`. У него своё утверждение, и оно не про
 * файлы, а про ПОРЯДОК: путь берётся из слота, слот живёт ограниченное время, сбрасывается
 * после использования, а профиль приходит только словом из закрытого словаря.
 *
 * ПОЧЕМУ ЭТО ПРОВЕРЯЕТСЯ БЕЗ ELECTRON. Модуль мастера окна не знает: диалог приходит к нему
 * ФУНКЦИЕЙ ВЫБОРА, которую в оболочке даёт главный процесс. Здесь вместо неё подставляется
 * функция, возвращающая путь стенда, — и весь порядок «выбрал → осмотрел → развернул»
 * проверяется обычным Node, то есть всюду, где пульт вообще запускается.
 *
 * ЧЕГО ЭТОТ ИНСТРУМЕНТ НЕ МЕРИТ, И ЭТО НАЗВАНО ЗДЕСЬ: окно подтверждения раскладки и сноса
 * (оно живёт в главном процессе Electron), сверку отправителя канала и сброс слота по событиям
 * окна — «окно скрыто» и «страница перезагружена» без окна не наступают. Эти три держатся
 * разбором кода и ручными пунктами протокола приёмки.
 *
 * СТЕНД СВОЙ, БОЕВОЕ НЕ ТРОГАЕТСЯ: копия модулей пульта во временном каталоге, каталог-цель
 * с пробелом и кириллицей в имени, СВОЙ реестр через `APPDATA`/`XDG_CONFIG_HOME`. Мастер-копия
 * берётся БОЕВАЯ (её путь знает `readReference()`), потому что подмену источника оболочка
 * не передаёт никогда — но и не изменяется: раскладка только читает её.
 *
 * КОДЫ ВОЗВРАТА: 0 — всё зелено; 1 — проверка провалилась (для отрицательной пробы это
 * ожидаемый исход); 2 — проба НЕ покраснела; 3 — прогон ничего не доказывает (нет мастер-копии).
 */

import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile, realpath, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PULT = path.resolve(HERE, '..');
const REPO = path.resolve(PULT, '..');

const NL = String.fromCharCode(10);
const out = (s = '') => process.stdout.write(`${s}${NL}`);
const err = (s = '') => process.stderr.write(`[pult] ${s}${NL}`);

/** Копия: мастеру нужны и его инструменты, и читатели — раскладка зовёт их подпроцессом. */
const MIRROR_DIRS = ['lib', 'read', 'write', 'deploy', 'shell', 'tools'];
const MIRROR_FILES = ['config.mjs', 'server.mjs'];

/** Имя каталога-цели: пробел и кириллица намеренно — путь обязан доехать неискажённым. */
const STAND_NAME = 'мой проект и пробел';

// --- отрицательные пробы ------------------------------------------------------

const PROBES = Object.freeze({
  slotlife: {
    what: 'слот перестаёт протухать — выбор часовой давности всё ещё разворачивается',
    edits: [{
      file: 'shell/deploy.mjs',
      from: '  if (Date.now() - slot.at > DEPLOY_SLOT_MS) {',
      to: '  if (false) {',
    }],
  },
  slotreset: {
    what: 'слот не сбрасывается после использования — повторное нажатие разворачивает второй раз молча',
    edits: [{
      file: 'shell/deploy.mjs',
      from: "  dropSlot('раскладка выполнена');",
      to: '  // проба: сброса нет',
    }],
  },
  presetword: {
    what: 'профиль принимается любым словом, а не только из закрытого словаря',
    edits: [{
      file: 'shell/deploy.mjs',
      from: '  const key = presetKey(preset);',
      to: '  const key = preset;',
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

/** Снимок дерева: относительный путь → размер и хеш. */
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
    out('Постоянные машинные проверки мастера установки:');
    out(`  node pult/tools/wizard-check.mjs [каталог для стендов] [--negative ${Object.keys(PROBES).join('|')}]`);
    out('Отрицательные пробы правят ТОЛЬКО копию пульта в стенде:');
    for (const [name, p] of Object.entries(PROBES)) out(`  ${name.padEnd(11)} ${p.what}`);
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

  const parent = await realpath(await mkdtemp(path.join(base, 'pult-wizard-')));
  const cfg = await realpath(await mkdtemp(path.join(base, 'pult-cfg-')));
  const copyDir = path.join(parent, 'pult');
  const notes = [];

  try {
    const copied = await mirror(copyDir);
    const stand = path.join(parent, STAND_NAME);
    await mkdir(path.join(stand, 'src'), { recursive: true });
    await writeFile(path.join(stand, 'src', 'index.js'), `код${NL}`);
    out(`стенд: ${parent}`);
    out(`копия модулей: ${copied} · каталог-цель: «${STAND_NAME}» (пробел и кириллица намеренно)`);
    out(`реестр прогона: ${cfg} (боевой не трогается)`);

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

    process.env.APPDATA = cfg;
    process.env.XDG_CONFIG_HOME = cfg;
    const wizard = await import(pathToFileURL(path.join(copyDir, 'shell', 'deploy.mjs')).href);

    // 1. ПУСТОЙ СЛОТ: раскладка без осмотра не начинается и ничего не создаёт.
    out('1. раскладка без осмотра:');
    const beforeEmpty = await snapshot(stand);
    const noSlot = await wizard.deployFromSlot('full');
    const afterEmpty = await snapshot(stand);
    const touchedEmpty = diff(beforeEmpty, afterEmpty);
    const emptyOk = noSlot.ok === false && noSlot.code === 'slot_empty' && !touchedEmpty.length;
    out(`  ответ: ${noSlot.ok === false ? noSlot.code : 'ЗАПУЩЕНО'} · стенд изменился: ${touchedEmpty.length ? touchedEmpty.join(', ') : 'нет'}`
      + `${emptyOk ? '' : '  <-- РАСХОЖДЕНИЕ'}`);
    if (!emptyOk) notes.push(`раскладка без осмотра: ${noSlot.code || 'запущена'}, изменений ${touchedEmpty.length}`);
    out('');

    // 2. ОСМОТР: путь доезжает неискажённым, слот заводится.
    out('2. осмотр каталога с пробелом и кириллицей:');
    const inspect = await wizard.inspectChosen(async () => stand);
    if (inspect.ok !== true) {
      err(`осмотр не прошёл: ${inspect.code || 'без кода'} ${inspect.message || ''}`);
      err('без мастер-копии набора этот прогон ничего не доказывает');
      return 3;
    }
    const samePath = inspect.inspect.root === stand;
    out(`  путь в отчёте: ${inspect.inspect.root}`);
    out(`  совпадает с выбранным посимвольно: ${samePath ? 'да' : 'НЕТ'}${samePath ? '' : '  <-- РАСХОЖДЕНИЕ'}`);
    out(`  мастер-копия: версия ${inspect.inspect.masterVersion || '—'} · будет положено ${inspect.inspect.willPlace.length}`);
    if (!samePath) notes.push('путь в отчёте осмотра отличается от выбранного');
    const slotAfterInspect = wizard.slotView();
    out(`  слот после осмотра: ${slotAfterInspect.chosen ? 'жив' : 'ПУСТ'}${slotAfterInspect.chosen ? '' : '  <-- РАСХОЖДЕНИЕ'}`);
    if (!slotAfterInspect.chosen) notes.push('слот не завёлся после удавшегося осмотра');
    out('');

    // 3. ПРОФИЛЬ — ТОЛЬКО СЛОВО ИЗ СЛОВАРЯ.
    out('3. профиль не из словаря:');
    const beforeWord = await snapshot(stand);
    const badPreset = await wizard.deployFromSlot('всё-подряд');
    const afterWord = await snapshot(stand);
    const touchedWord = diff(beforeWord, afterWord);
    const wordOk = badPreset.ok === false && badPreset.code === 'bad_preset' && !touchedWord.length;
    out(`  ответ: ${badPreset.ok === false ? badPreset.code : 'ЗАПУЩЕНО'} · стенд изменился: ${touchedWord.length ? touchedWord.join(', ') : 'нет'}`
      + `${wordOk ? '' : '  <-- РАСХОЖДЕНИЕ'}`);
    if (!wordOk) notes.push(`чужое слово профиля: ${badPreset.code || 'запущено'}, изменений ${touchedWord.length}`);
    out('');

    // 4. РАСКЛАДКА И СБРОС СЛОТА ПОСЛЕ ИСПОЛЬЗОВАНИЯ.
    out('4. раскладка и сброс слота:');
    // Слот мог быть съеден предыдущей проверкой (отказ тоже расходует его — так задумано),
    // поэтому осмотр повторяется. Иначе проверка 4 краснела бы КАСКАДОМ от проверки 3,
    // то есть докладывала бы не о том, что меряет.
    if (!wizard.slotView().chosen) await wizard.inspectChosen(async () => stand);
    const done = await wizard.deployFromSlot('full');
    const placed = done.ok === true && done.deploy && done.deploy.ok === true ? done.deploy.placed : 0;
    out(`  раскладка: ${done.ok === true && done.deploy && done.deploy.ok ? `положено ${placed}` : `ОТКАЗ ${(done.deploy && done.deploy.code) || done.code}`}`);
    if (!(done.ok === true && done.deploy && done.deploy.ok === true)) {
      notes.push('раскладка из слота не прошла — дальше мерить нечего');
    }
    const slotAfterDeploy = wizard.slotView();
    const again = await wizard.deployFromSlot('full');
    const resetOk = !slotAfterDeploy.chosen && again.ok === false && again.code === 'slot_empty';
    out(`  слот после раскладки: ${slotAfterDeploy.chosen ? 'ЖИВ' : 'сброшен'} · повторная раскладка: ${again.ok === false ? again.code : 'ЗАПУЩЕНА'}`
      + `${resetOk ? '' : '  <-- РАСХОЖДЕНИЕ'}`);
    if (!resetOk) notes.push('слот пережил раскладку — повторное нажатие развернуло бы второй раз молча');
    out('');

    // 5. СРОК ЖИЗНИ СЛОТА.
    out('5. срок жизни слота:');
    await wizard.inspectChosen(async () => stand);
    const config = await import(pathToFileURL(path.join(copyDir, 'config.mjs')).href);
    // Время подделывается ЧАСАМИ, а не правкой модуля: проверяется поведение, а не реализация.
    const realNow = Date.now;
    Date.now = () => realNow() + config.DEPLOY_SLOT_MS + 60000;
    const stale = wizard.slotPath();
    const staleDeploy = await wizard.deployFromSlot('full');
    Date.now = realNow;
    const staleOk = stale.ok === false && stale.code === 'slot_expired'
      && staleDeploy.ok === false && (staleDeploy.code === 'slot_expired' || staleDeploy.code === 'slot_empty');
    out(`  слот через ${Math.round(config.DEPLOY_SLOT_MS / 1000) + 60} с: ${stale.ok === false ? stale.code : 'ЖИВ'}`
      + ` · раскладка по нему: ${staleDeploy.ok === false ? staleDeploy.code : 'ЗАПУЩЕНА'}`
      + `${staleOk ? '' : '  <-- РАСХОЖДЕНИЕ'}`);
    if (!staleOk) notes.push('истёкший слот всё ещё разворачивается');
    out('');

    // 6. СНОС ПО ИДЕНТИФИКАТОРУ: чужой и отвергнутый корень.
    out('6. снос по идентификатору:');
    const cases = [
      ['неизвестный проект', await wizard.removeByProject('00000000'), 'unknown_project'],
      ['идентификатор не той формы', await wizard.removeByProject('НЕ-ФОРМА'), 'bad_project'],
    ];
    for (const [name, res, want] of cases) {
      const hit = res.ok === false && res.code === want;
      out(`  ${name.padEnd(28)}: ${res.ok === false ? res.code : 'ЗАПУЩЕНО'} (ожидание ${want})${hit ? '' : '  <-- РАСХОЖДЕНИЕ'}`);
      if (!hit) notes.push(`«${name}»: получено ${res.ok === false ? res.code : 'запуск'}, ожидалось ${want}`);
    }
    out('');
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
    out('расхождений нет: без осмотра не разворачивается, путь доезжает неискажённым,');
    out('профиль — только слово из словаря, слот сбрасывается и протухает, снос спрашивает реестр');
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
