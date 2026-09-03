#!/usr/bin/env node
/**
 * ПОСТОЯННЫЕ МАШИННЫЕ ПРОВЕРКИ РАСКЛАДКИ: состав, граница записи, резервная копия, слияние
 * и снос, чужой хук.
 *
 *   node pult/tools/deploy-check.mjs [каталог для стендов] [--negative <имя пробы>]
 *
 * ЗАЧЕМ. Урок фазы 3, записанный в договоре с фазой 4 (§3.4, пункт 6): проверяется то,
 * на что смотрят проверки, а не то, что написано в плане. Здесь пульт впервые ПИШЕТ в чужие
 * проекты и УДАЛЯЕТ из них файлы, и цена пропуска — не «окно не закрылось», а «файлы разложены
 * не туда» либо «чужое удалено».
 *
 * ГРАНИЦА УТВЕРЖДЕНИЯ, И ОНА ПЕРВАЯ НЕ СЛУЧАЙНО: инструмент меряет раскладку НА СВОИХ СТЕНДАХ
 * и о боевых проектах человека не говорит НИЧЕГО. Стенды разворачиваются во временном каталоге
 * системы, реестр прогона свой (каталог настроек подменяется через `APPDATA`/`XDG_CONFIG_HOME`),
 * мастер-копия СИНТЕТИЧЕСКАЯ — свой список состава, свои файлы и реальные копии двух хуков
 * набора. Поэтому прогон не зависит от того, переустановил ли человек мастер-копию, и боевой
 * реестр с боевой мастер-копией он не трогает.
 *
 * ПОЧЕМУ РАСКЛАДКА ЗАПУСКАЕТСЯ ИЗ КОПИИ ПУЛЬТА. Отрицательная проба обязана править ТОЛЬКО
 * копию — иначе «сломай, покажи, верни» превращается в правку рабочего кода, о которой легко
 * забыть. Копия лежит в стенде, запускается подпроцессом (`process.execPath`), а ожидания
 * считаются НАСТОЯЩИМИ модулями репозитория. Расхождение копии с оригиналом и есть красное.
 *
 * ЧТО МЕРИТСЯ:
 *
 *   1. СОСТАВ, ФОРМУЛА И ПАМЯТЬ. Раскладка в пустой стенд по трём профилям: разложенное
 *      совпадает с составом профиля пофайлово; каждый исключённый путь существует
 *      в синтетической мастер-копии и лежит внутри `agents/` или `commands/`; значение
 *      по полной карте, посчитанное `valueFromMap()`, равно значению `scan()`. Плюс машинная
 *      опора под защитой памяти: ни один путь памяти проекта не появляется в списке
 *      положенного — сегодня это верно ПО ПОСТРОЕНИЮ (состав приходит из списка состава),
 *      и утверждение стережёт БУДУЩУЮ правку, которая туда что-нибудь допишет.
 *      Пробы: `composition`, `formula`, `memoryplaced`.
 *
 *   2. ГРАНИЦА ЗАПИСИ. Снимок берётся ПО РОДИТЕЛЮ стендов — выход по ссылке происходит
 *      за стендом. Изменения допустимы только внутри папки набора, каталога копии и файла
 *      игнорирования. Здесь же транзитивный обход импортов от точки входа демона: в графе
 *      не должно быть ни одного модуля каталога `pult/deploy`, а `pult/lib/profiles.mjs`
 *      не должен обращаться к диску. ГРАНИЦА УТВЕРЖДЕНИЯ РЯДОМ С ПРОВЕРКОЙ: обход видит
 *      СТАТИЧЕСКУЮ форму импорта; динамическая форма и построенный требователь идут мимо него.
 *      Пробы: `scope`, `symlink`, `symlinkdir`, `import`, `tmpname`.
 *
 *      ПРАВИЛО ПРО ССЫЛКИ НА WINDOWS: для каталога берётся ТОЧКА СОЕДИНЕНИЯ, которой
 *      привилегия не нужна; ФАЙЛОВУЮ ссылку создать не удалось — прогон возвращает 3 и строку
 *      «ничего не доказано», а не зелёный результат.
 *
 *   3. РЕЗЕРВНАЯ КОПИЯ. Копия до первого изменения, снимки сошлись, путь напечатан; имя
 *      занято — суффикс; несошедшаяся сверка и непустой список пропущенного ОСТАНАВЛИВАЮТ
 *      раскладку, и стенд после отказа неизменен. Пробы: `backup`, `symlinkskip`.
 *
 *   4. СЛИЯНИЕ, БЛОК ИГНОРИРОВАНИЯ И СНОС. Стенд с чужими правами, чужой группой хуков и одной
 *      строкой, совпадающей с нашей; второй стенд — со СТАРЫМ блоком игнорирования от промта
 *      установки; третий — с блоком, правленным человеком. После сноса: чужое цело, наше
 *      исчезло; стенд с подложенной записью — ничего лишнего не удалено; стенд с подложенным
 *      реестром установленных файлов — он не читается.
 *      СТЕНДОВ ДЛЯ ФАЙЛА НАСТРОЕК ДВА, И ВТОРОЙ ЗАВЕДЁН ПО 🔴 РЕВЬЮ 03.09.2026: первый
 *      заводит `settings.json` заранее (лёгкий путь — файл человека), второй его НЕ заводит
 *      (главный сценарий новой раскладки — файл создаём мы). Прежняя редакция мерила только
 *      первый, и потому не видела, что на втором файл попадал в список положенного, а снос
 *      удалял его целиком вместе с правилами человека. Меряются все три ветки владения.
 *
 *      Пробы: `hookorder`, `owns`, `gitignore`, `memory`, `manifest`, `settingsplaced`,
 *      `settingswhole`, `dryrun`, `placedunion`.
 *
 *   5. ЧУЖОЙ ХУК НЕ ИСПОЛНЯЕТСЯ. В стенде лежит чужой `hooks/stubs.mjs`, который при запуске
 *      ПИШЕТ ФАЙЛ-МАРКЕР; после раскладки маркера быть не должно, а в отчёте и в записи обязана
 *      быть строка «хук не наш, не запускался».
 *
 *      ПРОБА `foreignhook` СНИМАЕТ ОБА УСЛОВИЯ ЗАПУСКА СРАЗУ, И ЭТО ЗАПИСАНО СЛОВАМИ: условий
 *      два («мы его положили этим прогоном» и «его хеш равен мастер-копии»), чужой хук
 *      не попадает в список положенного ПО ПОСТРОЕНИЮ, поэтому проба, снимающая только одно
 *      из двух, хук не запустит и покраснеть не сможет. Вторая проба `hookreport` стережёт
 *      другую половину утверждения — строку отчёта.
 *
 *      И рядом строка из `pult/deploy/deploy.mjs`: безопасность несёт СВЕРКА ХЕША. В рабочем
 *      коде снимать можно любое из двух условий, КРОМЕ неё; в пробе снимаются оба, потому что
 *      проба правит только копию и обязана уметь покраснеть.
 *
 *   6. ЭТАЛОН СЧИТАЕТСЯ ПО СОСТАВУ ПРОФИЛЯ. Три стенда, три профиля: вердикт `match_preset`
 *      при законно различающихся ПОЛНЫХ значениях. Плюс стенд «набор уже стоял», где ядро
 *      целиком пропущено additive-копией: вердикт обязан быть сверкой по составу, а не
 *      «ядро не наше», и список пропущенного ядра обязан быть непуст — состояние обязано
 *      уметь назвать причину. Подмена файла ядра даёт расхождение, удаление — «ядро
 *      не наше»; подмена честно пропущенного файла `agents/` вердикта не меняет, и это
 *      названная граница, а не дефект. Пробы: `preset`, `coreanchor`, `presettrunc`.
 *
 *   7. СТАРАЯ МАСТЕР-КОПИЯ НЕ ДАЁТ НЕПОЛНЫХ ПРОФИЛЕЙ. Вторая синтетическая мастер-копия,
 *      отличающаяся одним файлом — версией 1.17.0: неполный профиль обязан быть отбит
 *      и не положить НИ ОДНОГО файла, полный — пройти. Случай заведён по находке ревью
 *      части E: сквозная раскладка неполным профилем и отказ по версии не мерились ничем.
 *      Проба: `oldmaster`.
 *
 * КОДЫ ВОЗВРАТА: 0 — всё зелено; 1 — проверка провалилась (для отрицательной пробы это
 * ожидаемый исход); 2 — проба НЕ покраснела, то есть проверка ничего не стережёт; 3 — прогон
 * ничего не доказывает (стенд не собрался, нет привилегии на файловую ссылку, каталог стендов
 * вне временного).
 *
 * ПОРЯДОК ИСХОДОВ: КРАСНОЕ СИЛЬНЕЕ «НЕ ДОКАЗАНО». Если хоть одна проверка нашла расхождение —
 * это 1, даже когда другая часть прогона не выполнялась. Иначе непроведённый случай даёт 3.
 * Ноль означает ровно одно: всё, что обещано, проверено и сошлось.
 */

import {
  mkdtemp, mkdir, writeFile, readFile, readdir, lstat, rm, copyFile, symlink, realpath,
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

import { PRESET_KEYS, presetExcludes, coreViolation, allows } from '../lib/profiles.mjs';
import { scan } from '../lib/fingerprint.mjs';
import { MEMORY_PATHS, DEPLOY_RECORD } from '../config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PULT = path.resolve(HERE, '..');
const REPO = path.resolve(PULT, '..');
const KIT_HOOKS = path.join(REPO, '.claude', 'hooks');

const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const out = (s = '') => process.stdout.write(`${s}${NL}`);
const err = (s = '') => process.stderr.write(`[pult] ${s}${NL}`);

/** Копируются только модули: страница, оболочка и зависимости стенду не нужны. */
const MIRROR_DIRS = ['lib', 'read', 'write', 'deploy', 'tools'];
const MIRROR_FILES = ['config.mjs', 'server.mjs'];

// --- отрицательные пробы ------------------------------------------------------

/**
 * ПРОБЫ ПРАВЯТ ТОЛЬКО КОПИЮ. У пробы бывает несколько правок, и это не украшение: там, где
 * утверждение держат две-три страховки подряд, проба, снимающая одну, не может покраснеть —
 * а непокрасневшая проба хуже отсутствующей, потому что создаёт видимость покрытия.
 */
const PROBES = Object.freeze({
  composition: {
    what: 'профиль перестаёт исключать что-либо — разложенное расходится с составом профиля',
    edits: [{
      file: 'lib/profiles.mjs',
      from: '  for (const raw of presetExcludes(preset)) {',
      to: '  for (const raw of []) {',
    }],
  },
  formula: {
    what: 'формула отпечатка перестаёт сортировать строки — копия алгоритма расходится с оригиналом',
    edits: [{ file: 'lib/profiles.mjs', from: '  lines.sort();', to: '  lines.reverse();' }],
  },
  memoryplaced: {
    what: 'в список положенного дописывается путь памяти проекта — снос по нему унёс бы папку задачи',
    edits: [{
      file: 'deploy/deploy.mjs',
      from: '    if (res.placed) { report.placed.push(item.dst); continue; }',
      to: '    if (res.placed) { report.placed.push(item.dst); if (report.placed.length === 1) report.placed.push(\'tasks/2026-01-01-x/PLAN.md\'); continue; }',
    }],
  },
  scope: {
    what: 'запись уходит в корень проекта мимо трёх разрешённых мест',
    edits: [{
      file: 'deploy/fs.mjs',
      from: 'export async function writeWholeFile(ctx, rel, data) {',
      to: 'export async function writeWholeFile(ctx, rel, data) { await writeFile(path.join(ctx.root, \'СТОРОННИЙ-СЛЕД.txt\'), \'проба\');',
    }],
  },
  symlink: {
    what: 'снимаются ТРИ страховки сразу (вид цели в шлюзе, вид якоря и запись через временный файл) — иначе выхода по ссылке не случается',
    edits: [
      { file: 'deploy/gate.mjs', from: '    if (st.stat.isSymbolicLink()) return { ok: false, code: FAULT.NOT_PLAIN_FILE };', to: '    if (false) return { ok: false, code: FAULT.NOT_PLAIN_FILE };' },
      { file: 'deploy/gate.mjs', from: '    if (st.stat.isSymbolicLink()) {', to: '    if (false) {' },
      // Запись «на месте» включается ТОЛЬКО для цели-ссылки: проба обязана краснеть
      // от выхода по ссылке, а не от того, что все прочие записи перестали быть
      // атомарными. Проба, краснеющая по чужой причине, — тот же дефект, что и проба,
      // не краснеющая вовсе: она докладывает не о том, что проверяет.
      {
        file: 'deploy/fs.mjs',
        from: '    await rename(tmpTarget.path, resolved);',
        to: '    const stLink = await statSafe(resolved); if (stLink.ok && stLink.stat.isSymbolicLink()) { await writeFile(resolved, data); await rm(tmpTarget.path, { force: true }); } else { await rename(tmpTarget.path, resolved); }',
      },
    ],
  },
  symlinkdir: {
    what: 'шлюз перестаёт канонизировать родителя — точка соединения уводит запись за корень',
    edits: [{
      file: 'deploy/gate.mjs',
      from: '  const parentReal = await realPath(path.dirname(target));',
      to: '  const parentReal = { ok: true, path: path.dirname(target) };',
    }],
  },
  import: {
    what: 'читатель демона начинает импортировать каталог пишущей раскладки',
    edits: [{
      file: 'read/kit.mjs',
      from: "import { scan } from '../lib/fingerprint.mjs';",
      to: "import { scan } from '../lib/fingerprint.mjs'; import '../deploy/deploy.mjs';",
    }],
  },
  backup: {
    what: 'резервная копия не копирует ничего, а сверка снимков объявляется успешной',
    edits: [
      { file: 'deploy/backup.mjs', from: '  const copied = await copyTree(ctx, kitDir, dir, TREE_CAPS);', to: '  const copied = { ok: true, code: null, files: 0, bytes: 0, skipped: [] };' },
      { file: 'deploy/backup.mjs', from: '  const same = copy.files.size === source.files.size', to: '  const same = true; const ignored = copy.files.size === source.files.size' },
    ],
  },
  symlinkskip: {
    what: 'снимаются ОБА сторожа пропущенного (у снимка источника и у копии дерева) — иначе раскладка всё равно отбивается вторым, и половина утверждения остаётся без пробы',
    edits: [
      { file: 'deploy/backup.mjs', from: '  if (source.skipped.length) {', to: '  if (false) {' },
      { file: 'deploy/backup.mjs', from: '  if (copied.skipped.length) {', to: '  if (false) {' },
    ],
  },
  settingsplaced: {
    what: 'файл настроек возвращается в состав копирования — он попадает в положенное, признак «создан нами» становится ложью, а владение по правам пустым',
    edits: [{
      file: 'deploy/deploy.mjs',
      from: "export const MERGED_FILES = Object.freeze(['settings.json']);",
      to: 'export const MERGED_FILES = Object.freeze([]);',
    }],
  },
  settingswhole: {
    what: 'снос удаляет созданный нами файл настроек целиком, не глядя, дописал ли туда человек своё',
    edits: [{
      file: 'tools/kit-remove.mjs',
      from: '  if (createdFile && !leftovers.length) {',
      to: '  if (createdFile) {',
    }],
  },
  tmpname: {
    what: 'правило временного файла снова сверяет только каталог — шлюз открывает весь верхний уровень проекта, включая .env',
    edits: [{
      file: 'deploy/gate.mjs',
      from: '        if (isTempNameOf(path.basename(path.resolve(p)), path.basename(owner))) return null;',
      to: '        return null;',
    }],
  },
  dryrun: {
    what: 'сухой снос перестаёт спрашивать шлюз и обещает удалить память проекта, которую боевой отбивает',
    edits: [{
      file: 'tools/kit-remove.mjs',
      from: '    const allowed = await deployTarget(root, target, DEPLOY_MODE.REMOVE, { tally });',
      to: '    const allowed = args.dry ? { ok: true } : await deployTarget(root, target, DEPLOY_MODE.REMOVE, { tally });',
    }],
  },
  placedunion: {
    what: 'запись перестаёт помнить прежнее положенное — повторная раскладка лишает человека отката первой',
    edits: [{
      file: 'deploy/deploy.mjs',
      from: '  const placed = [...previous];',
      to: '  const placed = [];',
    }],
  },
  preset: {
    what: 'вердикт снова считается по ПОЛНЫМ значениям — проект с неполным профилем показывает расхождение навсегда',
    edits: [{
      file: 'read/kit.mjs',
      from: '  if (mineValue === refPresetValue) {',
      to: '  if (sc.value === refValue) {',
    }],
  },
  presettrunc: {
    what: 'усечение обхода снова гасит сверку у любого проекта — профиль без каталога агентов получает «неизвестно» навсегда',
    edits: [{
      file: 'read/kit.mjs',
      from: '  if (sc.truncated && !explained) {',
      to: '  if (sc.truncated) {',
    }],
  },
  oldmaster: {
    what: 'проверка версии мастер-копии снимается — неполный профиль раскладывается из копии, где нет правила про отсутствующего агента',
    edits: [{
      file: 'deploy/deploy.mjs',
      from: '  if (key !== PRESET_DEFAULT && !versionAtLeast(version, MIN_PRESET_VERSION)) {',
      to: '  if (false) {',
    }],
  },
  coreanchor: {
    what: 'ядро снова требуют в списке положенного — проект, где набор уже стоял, получает «ядро не наше» навсегда',
    edits: [{
      file: 'read/kit.mjs',
      from: '    if (sc.files[rel] === undefined) coreMissing.push(rel);',
      to: '    if (sc.files[rel] === undefined || !placedSet.has(rel)) coreMissing.push(rel);',
    }],
  },
  hookorder: {
    what: 'в нашей группе хуков баннер встаёт перед началом сессии — граница сессии гибнет молча',
    edits: [{
      file: 'deploy/settings.mjs',
      from: "const HOOK_ORDER = Object.freeze(['session.mjs --start', 'banner.mjs']);",
      to: "const HOOK_ORDER = Object.freeze(['banner.mjs', 'session.mjs --start']);",
    }],
  },
  owns: {
    what: 'владение перестаёт быть объединением прежнего и добавленного — повторная раскладка его сужает',
    edits: [{ file: 'deploy/settings.mjs', from: '    allow: [...prev.owns.allow],', to: '    allow: [],' }],
  },
  gitignore: {
    what: 'прежнее правило «блок уже есть — не дублируй»: строка каталога копии не доезжает',
    edits: [{
      file: 'deploy/deploy.mjs',
      from: '  const missing = IGNORE_BLOCK.filter((line) => !present.has(line));',
      to: '  const missing = present.has(IGNORE_BLOCK[0]) ? [] : IGNORE_BLOCK.filter((line) => !present.has(line));',
    }],
  },
  memory: {
    what: 'шлюз перестаёт защищать память проекта — журнал событий удаляется по подложенной записи',
    edits: [{
      file: 'deploy/gate.mjs',
      from: '    return isProjectMemory(kitRelative(kitDir, p)) ? FAULT.REMOVE_PROJECT_MEMORY : null;',
      to: '    return null;',
    }],
  },
  manifest: {
    what: 'снос начинает читать реестр установленных файлов набора и удаляет чужое по нему',
    edits: [{
      file: 'tools/kit-remove.mjs',
      from: "  const record = parseRecord(raw.buf.toString('utf8'));",
      to: "  const record = parseRecord(raw.buf.toString('utf8')); { const m = await readBytes(path.join(root, KIT_DIR_NAME, '.cckit-manifest.json'), MAX_TEXT_FILE); if (m.ok) { for (const e of (JSON.parse(m.buf.toString('utf8')).files || [])) { const p2 = String(e.path || '').split('.claude/').join(''); if (p2) record.placed.push(p2); } } }",
    }],
  },
  foreignhook: {
    what: 'снимаются ОБА условия запуска хука сразу — только так чужой хук вообще запустится',
    edits: [
      { file: 'deploy/deploy.mjs', from: '    if (!placedSet.has(rel)) {', to: '    if (false) {' },
      { file: 'deploy/deploy.mjs', from: '        if (!mine || !theirs || mine !== theirs) {', to: '        if (false) {' },
    ],
  },
  hookreport: {
    what: 'из отчёта пропадает строка «хук не наш» — человек не узнаёт, что хук не запускался',
    edits: [{
      file: 'deploy/deploy.mjs',
      from: "      record.why = 'хук не наш, не запускался: его не клал этот прогон';",
      to: '      record.why = null;',
    }],
  },
});

// --- служебное ----------------------------------------------------------------

/** Замена куска текста в КОПИИ через `split/join`: спецпоследовательностей она не знает. */
async function patchText(file, from, to) {
  const text = await readFile(file, 'utf8');
  const parts = text.split(from);
  if (parts.length !== 2) return { ok: false, hits: parts.length - 1 };
  await writeFile(file, parts.join(to), 'utf8');
  return { ok: true, hits: 1 };
}

/** Копия модулей пульта под стенд. Копируются только `.mjs`: страница и оболочка не нужны. */
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

/** Точка соединения на каталог: привилегии не требует, `realpath` её разворачивает. */
async function junction(target, link) {
  try {
    await symlink(target, link, 'junction');
    return true;
  } catch {
    try {
      await symlink(target, link, 'dir');
      return true;
    } catch {
      return false;
    }
  }
}

/** Снимок дерева: относительный путь → хеш, размер, метка. Ссылки помечаются отдельно. */
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
      if (st.isSymbolicLink()) { map.set(relPath, { link: true }); continue; }
      if (st.isDirectory()) { await walk(abs, relPath); continue; }
      if (!st.isFile()) continue;
      let hash = '';
      try {
        hash = createHash('sha256').update(await readFile(abs)).digest('hex');
      } catch {
        hash = 'не прочитан';
      }
      map.set(relPath, { size: st.size, hash });
    }
  };
  await walk(root, '');
  return map;
}

function compare(before, after) {
  const changed = [];
  const appeared = [];
  const vanished = [];
  for (const [rel, a] of before.entries()) {
    const b = after.get(rel);
    if (!b) { vanished.push(rel); continue; }
    if (JSON.stringify(a) !== JSON.stringify(b)) changed.push(rel);
  }
  for (const rel of after.keys()) if (!before.has(rel)) appeared.push(rel);
  return { changed, appeared, vanished };
}

/** Есть ли файл. */
async function exists(file) {
  try {
    await lstat(file);
    return true;
  } catch {
    return false;
  }
}

// --- синтетическая мастер-копия -----------------------------------------------

/**
 * Своя мастер-копия: свой список состава, свои файлы и РЕАЛЬНЫЕ копии двух хуков набора.
 *
 * Файлы `agents/` и `commands/` заводятся по СПИСКАМ ИСКЛЮЧЕНИЙ настоящих профилей — иначе
 * проверка «каждый исключённый путь существует в мастер-копии» проверяла бы саму себя.
 */
async function buildMaster(dir) {
  const excluded = new Set();
  for (const key of PRESET_KEYS) for (const rel of presetExcludes(key)) excluded.add(rel);

  const files = [
    'VERSION', 'ship.list', 'settings.json', 'ORCHESTRATOR_PROMPT.md', 'PROJECT_PROFILE.template.md',
    'agents/implementer.md', 'commands/cckit_help.md', 'commands/cckit_research.md',
    'hooks/stubs.mjs', 'hooks/write-manifest.mjs',
    'assets/stubs/FAQ_TEMPLATE.md', 'assets/stubs/tasks-ACTIVE', 'assets/stubs/explores-INDEX.md',
  ];
  for (const rel of excluded) {
    if (rel.endsWith('/')) continue;                 // каталог целиком — он и так появится
    if (!files.includes(rel)) files.push(rel);
  }

  await mkdir(path.join(dir, 'agents'), { recursive: true });
  await mkdir(path.join(dir, 'commands'), { recursive: true });
  await mkdir(path.join(dir, 'hooks'), { recursive: true });
  await mkdir(path.join(dir, 'assets', 'stubs'), { recursive: true });

  const settings = {
    permissions: {
      allow: ['Bash(node .claude/hooks/verify.mjs)', 'Bash(node .claude/hooks/task.mjs list)'],
      deny: ['Read(.env)', 'Write(.claude/settings.json)'],
    },
    hooks: {
      SessionStart: [{
        matcher: '',
        hooks: [
          { type: 'command', command: 'node .claude/hooks/session.mjs --start', timeout: 10 },
          { type: 'command', command: 'node .claude/hooks/banner.mjs --compact', timeout: 10 },
        ],
      }],
      PostToolUse: [{
        matcher: 'Edit|Write',
        hooks: [{ type: 'command', command: 'node .claude/hooks/check-syntax.mjs', timeout: 30 }],
      }],
    },
  };

  for (const rel of files) {
    const abs = path.join(dir, ...rel.split('/'));
    await mkdir(path.dirname(abs), { recursive: true });
    if (rel === 'VERSION') { await writeFile(abs, `1.18.0${NL}`); continue; }
    if (rel === 'settings.json') { await writeFile(abs, `${JSON.stringify(settings, null, 2)}${NL}`); continue; }
    if (rel === 'hooks/stubs.mjs' || rel === 'hooks/write-manifest.mjs') {
      await copyFile(path.join(KIT_HOOKS, path.basename(rel)), abs);
      continue;
    }
    await writeFile(abs, `синтетический файл стенда: ${rel}${NL}`);
  }

  const list = [
    '# синтетический список состава прогона проверок',
    'VERSION',
    'ship.list',
    'settings.json',
    'ORCHESTRATOR_PROMPT.md',
    'PROJECT_PROFILE.template.md',
    'agents/',
    'commands/',
    'hooks/',
    'assets/',
  ];
  await writeFile(path.join(dir, 'ship.list'), `${list.join(NL)}${NL}`);

  // Ожидаемый состав: те же файлы, что мы создали, с единственной подменой имени.
  const expected = files.map((rel) => (rel === 'PROJECT_PROFILE.template.md' ? 'PROJECT_PROFILE.md' : rel));
  return { files, expected };
}

// --- разговор с инструментами копии -------------------------------------------

function makeRunner(copyDir, masterDir, cfg) {
  const env = { ...process.env, APPDATA: cfg, XDG_CONFIG_HOME: cfg };
  const call = (tool, args) => {
    const res = spawnSync(process.execPath, [path.join(copyDir, 'tools', tool), ...args, '--json'], {
      encoding: 'utf8', env, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    });
    let json = null;
    try { json = JSON.parse(res.stdout); } catch { json = null; }
    return { code: res.status, json, out: res.stdout, err: res.stderr };
  };
  return {
    deploy: (root, preset, extra = []) => call('kit-deploy.mjs', ['--into', root, '--profile', preset, '--from', masterDir, ...extra]),
    // Тот же запуск, но с ДРУГИМ источником: нужен проверке 7, где мастер-копия своя,
    // старая. Ключ `--from` в обоих случаях законен: цели лежат во временном каталоге.
    deployFrom: (from, root, preset) => call('kit-deploy.mjs', ['--into', root, '--profile', preset, '--from', from]),
    remove: (root, extra = []) => call('kit-remove.mjs', ['--from', root, ...extra]),
  };
}

// --- проверка 1: состав, формула и память -------------------------------------

async function checkComposition(parent, run, master, notes) {
  const stands = {};
  for (const preset of PRESET_KEYS) {
    const root = path.join(parent, `состав-${preset}`);
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'index.js'), `код${NL}`);
    const res = run.deploy(root, preset);
    stands[preset] = { root, res };
    if (!res.json || res.json.ok !== true) {
      notes.push(`раскладка профилем «${preset}» не прошла: код ${res.code} ${(res.json && res.json.code) || res.err.slice(0, 120)}`);
      continue;
    }
    // ФАЙЛ НАСТРОЕК ИЗ ОЖИДАНИЯ ИСКЛЮЧЁН, И ЭТО НЕ ПОДГОНКА ПОД КОД. Он есть в списке состава,
    // но кладёт его не additive-копия, а слияние (`MERGED_FILES` в `pult/deploy/deploy.mjs`):
    // иначе он попадал бы в список положенного, и снос удалял бы файл человека целиком
    // (🔴 ревью 03.09.2026). Ожидание записано здесь ЯВНО, чтобы возврат файла в копирование
    // красил эту проверку, а не проходил молча; стенд «без файла настроек» ниже мерит
    // и обратную сторону — что файл в проект всё-таки попадает.
    const expected = master.expected
      .filter((rel) => rel !== 'settings.json')
      .filter((rel) => allows(preset, rel === 'PROJECT_PROFILE.md' ? 'PROJECT_PROFILE.template.md' : rel))
      .sort();
    const placed = [...res.json.placed].sort();
    const missing = expected.filter((r) => !placed.includes(r));
    const extra = placed.filter((r) => !expected.includes(r));
    out(`  профиль ${preset.padEnd(12)}: положено ${placed.length}, ожидалось ${expected.length}`
      + `${missing.length || extra.length ? '  <-- РАСХОЖДЕНИЕ' : ''}`);
    if (missing.length) notes.push(`профиль «${preset}»: не положено ${missing.slice(0, 5).join(', ')}`);
    if (extra.length) notes.push(`профиль «${preset}»: положено лишнее ${extra.slice(0, 5).join(', ')}`);

    // Машинная опора под защитой памяти.
    const memory = placed.filter((rel) => MEMORY_PATHS.some((m) => (m.endsWith('/') ? rel.startsWith(m) : rel === m)));
    if (memory.length) notes.push(`в списке положенного путь памяти проекта: ${memory.join(', ')}`);
  }

  // Каждое исключение существует в мастер-копии и лежит внутри agents/ или commands/.
  let bad = 0;
  for (const preset of PRESET_KEYS) {
    for (const rel of presetExcludes(preset)) {
      const abs = path.join(master.dir, ...rel.replace(/\/$/, '').split('/'));
      if (!await exists(abs)) { notes.push(`исключение «${rel}» профиля «${preset}» не существует в мастер-копии`); bad += 1; }
      if (coreViolation(rel)) { notes.push(`исключение «${rel}» профиля «${preset}» метит в ЯДРО`); bad += 1; }
    }
  }
  out(`  исключений проверено: ${PRESET_KEYS.reduce((n, k) => n + presetExcludes(k).length, 0)}, негодных ${bad}`);

  // Формула: копия обязана давать то же, что оригинал, на ПОЛНОЙ карте.
  const full = stands.full;
  if (full && full.res.json && full.res.json.ok) {
    const kitDir = path.join(full.root, '.claude');
    const sc = scan(kitDir);
    const copyProfiles = await import(pathToFileURL(path.join(run.copyDir, 'lib', 'profiles.mjs')).href);
    const mine = copyProfiles.valueFromMap(sc.files);
    const hit = Boolean(sc.value) && mine === sc.value;
    out(`  формула: scan() = ${sc.value}, valueFromMap() = ${mine}${hit ? '' : '  <-- РАСХОЖДЕНИЕ'}`);
    if (!hit) notes.push(`формула отпечатка разошлась: scan() = ${sc.value}, valueFromMap() = ${mine}`);
  }
  return stands;
}

// --- проверка 2: граница записи и граф импортов -------------------------------

const IMPORT_RE = /(?:^|[\s;])(?:import|export)\s+(?:[^'"();]*?from\s*)?['"]([^'"]+)['"]/g;

/** Транзитивный обход СТАТИЧЕСКИХ импортов от точки входа. Границу см. в шапке. */
async function importGraph(entry) {
  const seen = new Set();
  const queue = [path.resolve(entry)];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    IMPORT_RE.lastIndex = 0;
    let m = IMPORT_RE.exec(text);
    while (m) {
      const spec = m[1];
      if (spec.startsWith('.')) queue.push(path.resolve(path.dirname(file), spec));
      m = IMPORT_RE.exec(text);
    }
  }
  return seen;
}

async function checkScope(parent, copyDir, run, notes, undecided) {
  // 2а. Граф импортов демона.
  const graph = await importGraph(path.join(copyDir, 'server.mjs'));
  const deployDir = path.join(copyDir, 'deploy');
  const leaked = [...graph].filter((f) => f.startsWith(`${deployDir}${path.sep}`));
  out(`  граф импортов демона: модулей ${graph.size}, из каталога раскладки ${leaked.length}`
    + `${leaked.length ? '  <-- РАСХОЖДЕНИЕ' : ''}`);
  if (leaked.length) notes.push(`демон импортирует раскладку: ${leaked.map((f) => path.basename(f)).join(', ')}`);

  const profiles = await readFile(path.join(copyDir, 'lib', 'profiles.mjs'), 'utf8');
  IMPORT_RE.lastIndex = 0;
  const specs = [];
  let m = IMPORT_RE.exec(profiles);
  while (m) { specs.push(m[1]); m = IMPORT_RE.exec(profiles); }
  const dirty = specs.filter((s) => s.startsWith('node:fs') || s.startsWith('node:child_process') || s.includes('/deploy/'));
  out(`  profiles.mjs: импортов ${specs.length}, обращений к диску ${dirty.length}`
    + `${dirty.length ? '  <-- РАСХОЖДЕНИЕ' : ''}`);
  if (dirty.length) notes.push(`pult/lib/profiles.mjs обращается к диску: ${dirty.join(', ')}`);

  // 2б. Снимок ПО РОДИТЕЛЮ: выход по ссылке происходит за стендом.
  const root = path.join(parent, 'граница');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'index.js'), `код${NL}`);
  const before = await snapshot(parent);
  const res = run.deploy(root, 'full');
  const after = await snapshot(parent);
  const diff = compare(before, after);
  const allowed = (rel) => {
    const parts = rel.split('/');
    if (parts[0] !== 'граница') return false;
    if (parts[1] === '.claude' || parts[1] === '.gitignore') return true;
    return parts[1].startsWith('.claude.backup-');
  };
  const stray = [...diff.changed, ...diff.appeared, ...diff.vanished].filter((rel) => !allowed(rel));
  out(`  запись мимо трёх мест: ${stray.length}${stray.length ? '  <-- РАСХОЖДЕНИЕ' : ''}`);
  for (const rel of stray.slice(0, 8)) out(`    ${rel}`);
  if (stray.length) notes.push(`раскладка изменила ${stray.length} путей вне разрешённых мест: ${stray.slice(0, 3).join(', ')}`);
  if (!res.json || res.json.ok !== true) notes.push('раскладка на стенде границы не прошла — мерить нечего');

  // 2б-бис. ПРАВИЛО ВРЕМЕННОГО ФАЙЛА — прямыми вопросами шлюзу.
  //
  // Заведено по 🟡 1 ревью 03.09.2026: прежняя редакция сверяла только КАТАЛОГ владельца,
  // а каталог `<root>/.gitignore` — это корень проекта, поэтому шлюз разрешал любой файл
  // в корне, включая `.env`. Сквозной раскладкой такое не поймать: `ctx` строит `putBytes()`
  // сам, снаружи он не приходит, — поэтому спрашиваем дверь напрямую.
  const tmpRoot = path.join(parent, 'временный-файл');
  await mkdir(path.join(tmpRoot, '.claude'), { recursive: true });
  await writeFile(path.join(tmpRoot, '.gitignore'), `node_modules/${NL}`);
  const gateMod = await import(pathToFileURL(path.join(copyDir, 'deploy', 'gate.mjs')).href);
  const owner = path.join(tmpRoot, '.gitignore');
  const asks = [
    ['.env', false],
    ['package.json', false],
    ['README.md', false],
    ['..gitignore.1234.5678.tmp', true],
  ];
  const wrong = [];
  for (const [rel, want] of asks) {
    const r = await gateMod.deployTarget(tmpRoot, rel, 'write', { tmpFor: owner });
    if (Boolean(r.ok) !== want) wrong.push(`${rel}: ${r.ok ? 'разрешено' : `отбито (${r.code})`}`);
  }
  out(`  правило временного файла: спрошено ${asks.length}, отвечено не так ${wrong.length}`
    + `${wrong.length ? '  <-- РАСХОЖДЕНИЕ' : ''}`);
  for (const w of wrong) out(`    ${w}`);
  if (wrong.length) notes.push(`шлюз отвечает не так на правиле временного файла: ${wrong.join('; ')}`);

  // 2в. ФАЙЛОВАЯ ССЫЛКА: без привилегии случай не заводится, и это код 3.
  const linkRoot = path.join(parent, 'ссылка-файл');
  const outsideDir = path.join(parent, 'снаружи');
  await mkdir(path.join(linkRoot, 'src'), { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  const outsideFile = path.join(outsideDir, 'чужой.txt');
  await writeFile(outsideFile, `чужое содержимое${NL}`);
  let fileLink = true;
  try {
    await symlink(outsideFile, path.join(linkRoot, '.gitignore'), 'file');
  } catch {
    fileLink = false;
  }
  if (!fileLink) {
    out('  выход по ФАЙЛОВОЙ ссылке: СЛУЧАЙ НЕ ЗАВЁЛСЯ — нет привилегии создания ссылки');
    undecided.push('файловую ссылку создать не удалось: про выход по ссылке этот прогон'
      + ' НИЧЕГО НЕ ДОКАЗЫВАЕТ (нужна привилегия или режим разработчика Windows)');
  } else {
    const outBefore = await readFile(outsideFile, 'utf8');
    run.deploy(linkRoot, 'full');
    const outAfter = await readFile(outsideFile, 'utf8');
    const hit = outBefore === outAfter;
    out(`  выход по ФАЙЛОВОЙ ссылке: чужой файл ${hit ? 'цел' : 'ИЗМЕНЁН'}${hit ? '' : '  <-- РАСХОЖДЕНИЕ'}`);
    if (!hit) notes.push('запись прошла СКВОЗЬ файловую ссылку — изменён файл за пределами стенда');
  }

  // 2г. ТОЧКА СОЕДИНЕНИЯ: шлюз спрашивается напрямую — до записи дело доходить не должно.
  const jRoot = path.join(parent, 'ссылка-каталог');
  await mkdir(path.join(jRoot, '.claude'), { recursive: true });
  const outsideHooks = path.join(parent, 'снаружи-хуки');
  await mkdir(outsideHooks, { recursive: true });
  const made = await junction(outsideHooks, path.join(jRoot, '.claude', 'hooks'));
  if (!made) {
    out('  выход по ТОЧКЕ СОЕДИНЕНИЯ: случай не завёлся');
    undecided.push('точку соединения создать не удалось — выход по каталожной ссылке не проверен');
  } else {
    const gate = await import(pathToFileURL(path.join(copyDir, 'deploy', 'gate.mjs')).href);
    const r = await gate.deployTarget(jRoot, '.claude/hooks/чужой.mjs', 'write', {});
    out(`  выход по ТОЧКЕ СОЕДИНЕНИЯ: шлюз ${r.ok ? 'РАЗРЕШИЛ' : `отбил (${r.code})`}${r.ok ? '  <-- РАСХОЖДЕНИЕ' : ''}`);
    if (r.ok) notes.push('шлюз разрешил запись по точке соединения, ведущей за пределы корня');
  }
}

// --- проверка 3: резервная копия ----------------------------------------------

async function checkBackup(parent, run, notes) {
  // 3а. Копия до первого изменения и сверка снимков.
  const root = path.join(parent, 'копия');
  await mkdir(path.join(root, '.claude', 'hooks'), { recursive: true });
  await writeFile(path.join(root, '.claude', 'VERSION'), `1.0.0${NL}`);
  await writeFile(path.join(root, '.claude', 'hooks', 'чужой-хук.mjs'), `чужой хук${NL}`);
  const kitBefore = await snapshot(path.join(root, '.claude'));
  const res = run.deploy(root, 'full');
  const dir = res.json && res.json.backup ? res.json.backup.dir : null;
  const copyShot = dir ? await snapshot(dir) : new Map();
  const hit = Boolean(dir) && copyShot.size === kitBefore.size;
  out(`  копия: путь ${dir ? path.basename(dir) : 'НЕ НАЗВАН'}, файлов ${copyShot.size} против ${kitBefore.size}`
    + `${hit ? '' : '  <-- РАСХОЖДЕНИЕ'}`);
  if (!hit) notes.push(`резервная копия не сошлась с папкой набора: ${copyShot.size} против ${kitBefore.size}`);
  // Содержимое: чужой хук обязан лежать в копии тем же байтом.
  const same = [...kitBefore.keys()].every((rel) => copyShot.has(rel)
    && JSON.stringify(copyShot.get(rel)) === JSON.stringify(kitBefore.get(rel)));
  if (!same) notes.push('содержимое резервной копии отличается от оригинала');

  // 3б. Имя занято — суффикс.
  const res2 = run.deploy(root, 'full');
  const dir2 = res2.json && res2.json.backup ? res2.json.backup.dir : null;
  const suffixed = Boolean(dir2) && dir2 !== dir;
  out(`  занятое имя: вторая копия ${dir2 ? path.basename(dir2) : 'НЕ СОЗДАНА'}${suffixed ? '' : '  <-- РАСХОЖДЕНИЕ'}`);
  if (!suffixed) notes.push('вторая копия за день не получила суффикс');

  // 3в. Непустое пропущенное останавливает раскладку, стенд неизменен.
  const skipRoot = path.join(parent, 'копия-ссылка');
  await mkdir(path.join(skipRoot, '.claude'), { recursive: true });
  await writeFile(path.join(skipRoot, '.claude', 'VERSION'), `1.0.0${NL}`);
  const outsideDir = path.join(parent, 'снаружи-копия');
  await mkdir(outsideDir, { recursive: true });
  if (!await junction(outsideDir, path.join(skipRoot, '.claude', 'чужая-ссылка'))) {
    notes.push('точка соединения для стенда пропущенного не завелась — случай не мерился');
    return;
  }
  const before = await snapshot(skipRoot);
  const res3 = run.deploy(skipRoot, 'full');
  const after = await snapshot(skipRoot);
  const diff = compare(before, after);
  const stopped = res3.json && res3.json.ok === false;
  const clean = !diff.changed.length && !diff.appeared.length && !diff.vanished.length;
  out(`  пропущенное останавливает: раскладка ${stopped ? 'отбита' : 'ПРОШЛА'}, стенд ${clean ? 'неизменен' : 'ИЗМЕНЁН'}`
    + `${stopped && clean ? '' : '  <-- РАСХОЖДЕНИЕ'}`);
  if (!stopped) notes.push('раскладка не остановилась, хотя копия перенесла не всё');
  if (!clean) notes.push(`стенд изменён после отказа копии: ${[...diff.appeared, ...diff.changed].slice(0, 3).join(', ')}`);
}

// --- проверка 4: слияние, блок игнорирования и снос ---------------------------

/** Старый блок игнорирования — ровно тот, что диктуют промты установки, БЕЗ строки копии. */
const OLD_BLOCK = [
  '# Claude Agent Kit — служебные файлы помощников, остаются на этой машине.',
  '# Поделиться набором с командой осознанно: /cckit_push-with-me',
  '.claude/',
  '# Результаты прогона проверок, подтверждение набора команд, состояние гейта и журнал',
  '# событий: остаются на этой машине, даже если строка .claude/ выше будет убрана.',
  '.claude/artifacts/VERIFY.json',
  '.claude/artifacts/VERIFY.lock',
  '.claude/artifacts/GATE_STATE.json',
  '.claude/artifacts/events.jsonl',
  '# Папки задач: планы, аудиты и ревью этого проекта — рабочие черновики, а не часть',
  '# продукта. Тоже остаются на этой машине, даже если строка .claude/ выше будет убрана.',
  '.claude/tasks/',
];

/** Стенд слияния: чужие агент, команда, хук, права, группа хуков и СТАРЫЙ блок игнорирования. */
async function makeMergeStand(root, shared, foreignGroup) {
  await mkdir(path.join(root, '.claude', 'agents'), { recursive: true });
  await mkdir(path.join(root, '.claude', 'commands'), { recursive: true });
  await mkdir(path.join(root, '.claude', 'hooks'), { recursive: true });
  await writeFile(path.join(root, '.claude', 'agents', 'чужой-агент.md'), `чужой агент${NL}`);
  await writeFile(path.join(root, '.claude', 'commands', 'чужая-команда.md'), `чужая команда${NL}`);
  await writeFile(path.join(root, '.claude', 'hooks', 'чужой-хук.mjs'), `чужой хук${NL}`);
  await writeFile(path.join(root, '.claude', 'settings.json'), `${JSON.stringify({
    permissions: { allow: [shared, 'Bash(человек своё:*)'] },
    hooks: { SessionStart: [foreignGroup] },
    model: 'мой',
  }, null, 2)}${NL}`);
  // СТАРЫЙ блок игнорирования от промта установки, окончания строк Windows.
  await writeFile(path.join(root, '.gitignore'), Buffer.from(
    `node_modules/${CR}${NL}${OLD_BLOCK.join(`${CR}${NL}`)}${CR}${NL}`, 'utf8',
  ));
}

async function checkMergeAndRemove(parent, run, notes) {
  // 4а. Чужие права, чужая группа хуков и одна строка, совпадающая с нашей.
  const root = path.join(parent, 'слияние');
  const shared = 'Bash(node .claude/hooks/verify.mjs)';
  const foreignGroup = { matcher: '', hooks: [{ type: 'command', command: 'node чужой.mjs' }] };
  await makeMergeStand(root, shared, foreignGroup);

  const res = run.deploy(root, 'full');
  if (!res.json || res.json.ok !== true) {
    notes.push(`раскладка на стенде слияния не прошла: ${(res.json && res.json.code) || res.err.slice(0, 100)}`);
    return;
  }
  const settings = JSON.parse(await readFile(path.join(root, '.claude', 'settings.json'), 'utf8'));
  const owns = settings._cckit.owns;

  const ownedShared = owns.allow.includes(shared);
  out(`  строка, бывшая у человека, во владении: ${ownedShared ? 'ДА' : 'нет'}${ownedShared ? '  <-- РАСХОЖДЕНИЕ' : ''}`);
  if (ownedShared) notes.push('строка прав, уже бывшая в чужом файле, записана в наше владение');

  const groups = settings.hooks.SessionStart;
  const foreignIntact = JSON.stringify(groups[0]) === JSON.stringify(foreignGroup);
  const ours = groups.find((g) => Array.isArray(g.hooks) && g.hooks.some((h) => String(h.command).includes('session.mjs')));
  const orderOk = Boolean(ours) && String(ours.hooks[0].command).includes('session.mjs --start');
  out(`  чужая группа хуков цела: ${foreignIntact ? 'да' : 'НЕТ'} · порядок в нашей: ${ours ? ours.hooks.map((h) => String(h.command).split('/').pop()).join(' → ') : 'НАШЕЙ ГРУППЫ НЕТ'}`
    + `${foreignIntact && orderOk ? '' : '  <-- РАСХОЖДЕНИЕ'}`);
  if (!foreignIntact) notes.push('чужая группа хуков изменена раскладкой');
  if (!orderOk) notes.push('в нашей группе хуков начало сессии не первое — граница сессии погибнет молча');

  // ПОВТОРНАЯ РАСКЛАДКА МЕРИТСЯ НА ОТДЕЛЬНОМ СТЕНДЕ, и это не аккуратность, а необходимость:
  // второй прогон кладёт ноль файлов и перезаписывает запись пустым списком положенного —
  // после него сносить нечего, и снос на том же стенде мерил бы уже другое утверждение.
  const twice = path.join(parent, 'слияние-повтор');
  await makeMergeStand(twice, shared, foreignGroup);
  run.deploy(twice, 'full');
  const first = JSON.parse(await readFile(path.join(twice, '.claude', 'settings.json'), 'utf8'));
  const ownedBefore = first._cckit.owns.allow.length + first._cckit.owns.deny.length;
  run.deploy(twice, 'full');
  const settings2 = JSON.parse(await readFile(path.join(twice, '.claude', 'settings.json'), 'utf8'));
  const ownedAfter = settings2._cckit.owns.allow.length + settings2._cckit.owns.deny.length;
  out(`  владение после повторной раскладки: ${ownedBefore} → ${ownedAfter}${ownedAfter < ownedBefore ? '  <-- РАСХОЖДЕНИЕ' : ''}`);
  if (ownedAfter < ownedBefore) notes.push(`повторная раскладка сузила владение: ${ownedBefore} → ${ownedAfter}`);

  // ЗАПИСЬ ПОСЛЕ ПОВТОРНОЙ РАСКЛАДКИ ОБЯЗАНА ПОМНИТЬ ПРЕЖНЕЕ ПОЛОЖЕННОЕ (🟡 5 ревью
  // 03.09.2026): второй прогон кладёт ноль файлов, и запись, переписанная пустым списком,
  // лишала бы человека отката ПЕРВОЙ раскладки — безобидное второе нажатие «разложить»
  // делало бы набор несносимым.
  const twiceRecord = await readFile(path.join(twice, '.claude', DEPLOY_RECORD), 'utf8')
    .then((t) => JSON.parse(t)).catch(() => null);
  const remembered = twiceRecord && Array.isArray(twiceRecord.placed) ? twiceRecord.placed.length : 0;
  out(`  запись после повторной раскладки: положенного ${remembered}`
    + `${remembered > 0 ? '' : '  <-- РАСХОЖДЕНИЕ'}`);
  if (!remembered) notes.push('повторная раскладка стёрла список положенного — снос первой раскладки стал невозможен');

  // Блок игнорирования: строка копии доехала, чужое цело, дублей нет, окончания строк те же.
  const ignoreBuf = await readFile(path.join(root, '.gitignore'));
  const text = ignoreBuf.toString('utf8');
  const rows = text.split(/\r?\n/);
  const backupLine = '.claude.backup-*/';
  const count = rows.filter((l) => l.trim() === backupLine).length;
  const foreignLine = rows.includes('node_modules/');
  const crlf = (text.match(new RegExp(`${CR}${NL}`, 'g')) || []).length;
  const loneLf = (text.match(new RegExp(`[^${CR}]${NL}`, 'g')) || []).length;
  const eolOk = crlf > 0 && loneLf === 0;
  out(`  файл игнорирования: строк «${backupLine}» ${count} (ожидание 1), чужая строка ${foreignLine ? 'цела' : 'ПРОПАЛА'},`
    + ` окончания строк ${eolOk ? 'сохранены' : 'ИСПОРЧЕНЫ'}${count === 1 && foreignLine && eolOk ? '' : '  <-- РАСХОЖДЕНИЕ'}`);
  if (count !== 1) notes.push(`строка каталога копии встречается ${count} раз (ожидание 1)`);
  if (!foreignLine) notes.push('чужая строка файла игнорирования пропала');
  if (!eolOk) notes.push(`окончания строк файла игнорирования изменены: CRLF ${crlf}, одиноких LF ${loneLf}`);

  // 4б. Блок ПРАВЛЕН человеком — недостающее уходит отдельной группой, блок не тронут.
  const edited = path.join(parent, 'игнор-правленый');
  await mkdir(path.join(edited, 'src'), { recursive: true });
  const editedRows = [...OLD_BLOCK.slice(0, 3), 'чужая-строка-внутри-блока/', ...OLD_BLOCK.slice(3)];
  await writeFile(path.join(edited, '.gitignore'), `${editedRows.join(NL)}${NL}`);
  const res3 = run.deploy(edited, 'full');
  const editedText = await readFile(path.join(edited, '.gitignore'), 'utf8');
  const editedLines = editedText.split(NL);
  const keptInside = editedLines[3] === 'чужая-строка-внутри-блока/';
  const asGroup = res3.json && res3.json.gitignore && res3.json.gitignore.mode === 'group';
  const hasBackup = editedLines.some((l) => l.trim() === backupLine);
  out(`  правленый блок: не тронут ${keptInside ? 'да' : 'НЕТ'}, недостающее отдельной группой ${asGroup ? 'да' : 'НЕТ'},`
    + ` строка копии ${hasBackup ? 'есть' : 'НЕТ'}${keptInside && asGroup && hasBackup ? '' : '  <-- РАСХОЖДЕНИЕ'}`);
  if (!keptInside) notes.push('правленый человеком блок игнорирования изменён');
  if (!asGroup) notes.push('недостающие строки не ушли отдельной группой при правленом блоке');
  if (!hasBackup) notes.push('строка каталога копии не добавлена при правленом блоке');

  // 4б-бис. ПРОЕКТ БЕЗ ФАЙЛА НАСТРОЕК — стенд, на котором сидела 🔴 ревью 03.09.2026.
  //
  // Прежний стенд заводил `settings.json` заранее и мерил только лёгкий путь: файл уже есть,
  // значит слияние идёт по чужому файлу. Главный сценарий новой раскладки — противоположный:
  // файла нет, создаём его мы, — и именно тогда прежняя редакция клала его additive-копией,
  // записывала в список положенного и сносила ЦЕЛИКОМ вместе с правилами человека.
  //
  // Меряются ВСЕ ТРИ ветки владения: создан нами и чужого нет → удаляем целиком; создан нами,
  // человек дописал → чистим только своё; был у человека → тоже только своё (это 4а выше).
  const bare = path.join(parent, 'без-настроек');
  await mkdir(path.join(bare, 'src'), { recursive: true });
  await writeFile(path.join(bare, 'src', 'index.js'), `код${NL}`);
  const bareRes = run.deploy(bare, 'full');
  const bareFile = path.join(bare, '.claude', 'settings.json');
  const bareSet = await readFile(bareFile, 'utf8').then((t) => JSON.parse(t)).catch(() => null);
  const inPlaced = Boolean(bareRes.json && Array.isArray(bareRes.json.placed)
    && bareRes.json.placed.includes('settings.json'));
  const created = Boolean(bareSet && bareSet._cckit && bareSet._cckit.created_file === true);
  const ownedRules = bareSet && bareSet._cckit && bareSet._cckit.owns
    ? bareSet._cckit.owns.allow.length + bareSet._cckit.owns.deny.length : 0;
  const born = bareSet !== null;
  out(`  проект без настроек: файл создан ${born ? 'да' : 'НЕТ'}, в положенном ${inPlaced ? 'ДА' : 'нет'},`
    + ` created_file ${created ? 'да' : 'НЕТ'}, во владении прав ${ownedRules}`
    + `${born && !inPlaced && created && ownedRules > 0 ? '' : '  <-- РАСХОЖДЕНИЕ'}`);
  if (!born) notes.push('на проекте без файла настроек он не создан вовсе');
  if (inPlaced) notes.push('файл настроек попал в список положенного — снос удалит его целиком вместе с правилами человека');
  if (!created) notes.push('признак «файл настроек создан нами» ложен там, где мы его создали');
  if (!ownedRules) notes.push('владение по правам пусто там, где файл настроек создан нами');

  // Человек дописал своё → снос обязан оставить файл и вычистить только наше.
  if (bareSet) {
    bareSet.permissions.allow.push('Bash(человек своё:*)');
    bareSet.model = 'мой';
    await writeFile(bareFile, `${JSON.stringify(bareSet, null, 2)}${NL}`);
  }
  run.remove(bare);
  const afterBare = await readFile(bareFile, 'utf8').then((t) => JSON.parse(t)).catch(() => null);
  const kept = Boolean(afterBare) && Array.isArray(afterBare.permissions.allow)
    && afterBare.permissions.allow.includes('Bash(человек своё:*)') && afterBare.model === 'мой';
  const ourRulesGone = Boolean(afterBare) && !(afterBare.permissions.allow || []).some((r) => r.startsWith('Bash(node .claude'));
  out(`  снос после правки человека: файл ${afterBare ? 'цел' : 'УДАЛЁН ЦЕЛИКОМ'},`
    + ` правило человека ${kept ? 'цело' : 'ПРОПАЛО'}, наши правила ${ourRulesGone ? 'убраны' : 'ОСТАЛИСЬ'}`
    + `${afterBare && kept && ourRulesGone ? '' : '  <-- РАСХОЖДЕНИЕ'}`);
  if (!afterBare) notes.push('снос удалил файл настроек целиком, хотя человек дописал в него своё');
  else if (!kept) notes.push('снос унёс правило и поле, дописанные человеком в созданный нами файл');
  else if (!ourRulesGone) notes.push('снос не вычистил наши правила из созданного нами файла настроек');

  // Чужого не появилось → файл наш целиком и снимается целиком.
  const bareClean = path.join(parent, 'без-настроек-чистый');
  await mkdir(path.join(bareClean, 'src'), { recursive: true });
  await writeFile(path.join(bareClean, 'src', 'index.js'), `код${NL}`);
  run.deploy(bareClean, 'full');
  run.remove(bareClean);
  const cleanGone = !await exists(path.join(bareClean, '.claude', 'settings.json'));
  out(`  снос без правок человека: файл настроек ${cleanGone ? 'удалён целиком' : 'ОСТАЛСЯ'}`
    + `${cleanGone ? '' : '  <-- РАСХОЖДЕНИЕ'}`);
  if (!cleanGone) notes.push('файл настроек, созданный нами и не тронутый человеком, не удалён целиком');

  // 4в. СНОС: чужое цело, наше исчезло.
  const removed = run.remove(root);
  const foreign = await Promise.all([
    exists(path.join(root, '.claude', 'agents', 'чужой-агент.md')),
    exists(path.join(root, '.claude', 'commands', 'чужая-команда.md')),
    exists(path.join(root, '.claude', 'hooks', 'чужой-хук.mjs')),
  ]);
  const ourGone = !await exists(path.join(root, '.claude', 'ORCHESTRATOR_PROMPT.md'));
  const settingsAfter = JSON.parse(await readFile(path.join(root, '.claude', 'settings.json'), 'utf8'));
  const humanRule = Array.isArray(settingsAfter.permissions.allow)
    && settingsAfter.permissions.allow.includes('Bash(человек своё:*)');
  const humanGroup = settingsAfter.hooks && JSON.stringify(settingsAfter.hooks.SessionStart) === JSON.stringify([foreignGroup]);
  const allForeign = foreign.every(Boolean);
  out(`  снос: чужое цело ${allForeign ? 'да' : 'НЕТ'}, наше убрано ${ourGone ? 'да' : 'НЕТ'},`
    + ` правило человека ${humanRule ? 'цело' : 'ПРОПАЛО'}, чужая группа ${humanGroup ? 'цела' : 'ПРОПАЛА'}`
    + `${allForeign && ourGone && humanRule && humanGroup ? '' : '  <-- РАСХОЖДЕНИЕ'}`);
  if (!allForeign) notes.push('снос унёс чужие файлы');
  if (!ourGone) notes.push('снос не убрал наши файлы');
  if (!humanRule) notes.push('снос унёс правило прав, написанное человеком');
  if (!humanGroup) notes.push('снос унёс чужую группу хуков');
  if (removed.code !== 0) notes.push(`снос вернул код ${removed.code}`);

  // 4г. Подложенная запись: память проекта, каталог копии, путь с двумя точками.
  const planted = path.join(parent, 'подложенная-запись');
  await mkdir(path.join(planted, '.claude', 'artifacts'), { recursive: true });
  await mkdir(path.join(planted, '.claude', 'tasks', '2026-01-01-x'), { recursive: true });
  await mkdir(path.join(planted, '.claude.backup-2026-01-01'), { recursive: true });
  await mkdir(path.join(planted, 'src'), { recursive: true });
  await writeFile(path.join(planted, '.claude', 'artifacts', 'events.jsonl'), `{"событие":1}${NL}`);
  await writeFile(path.join(planted, '.claude', 'tasks', '2026-01-01-x', 'PLAN.md'), `план${NL}`);
  await writeFile(path.join(planted, '.claude.backup-2026-01-01', 'VERSION'), `1.0.0${NL}`);
  await writeFile(path.join(planted, 'src', 'index.js'), `код${NL}`);
  await writeFile(path.join(planted, '.claude', 'чужой-файл.md'), `чужой${NL}`);
  await writeFile(path.join(planted, '.claude', DEPLOY_RECORD), `${JSON.stringify({
    schema: 1,
    profile: 'full',
    kit_version: '1.18.0',
    placed: [
      'artifacts/events.jsonl',
      'tasks/2026-01-01-x/PLAN.md',
      '../.claude.backup-2026-01-01/VERSION',
      '../src/index.js',
    ],
    skipped: [],
    skipped_core: [],
  }, null, 2)}${NL}`);
  // Подложенный реестр установленных файлов: он не должен читаться вовсе.
  await writeFile(path.join(planted, '.claude', '.cckit-manifest.json'), `${JSON.stringify({
    files: [{ path: '.claude/чужой-файл.md', group: 'service' }],
  }, null, 2)}${NL}`);

  // СУХОЙ ПРОГОН ОБЯЗАН ПОКАЗЫВАТЬ ТО ЖЕ, ЧТО СДЕЛАЕТ БОЕВОЙ (🟡 2 ревью 03.09.2026):
  // прежняя редакция спрашивала в сухом режиме только наличие файла и обещала удалить
  // память проекта, которую боевой прогон отбивает кодом `remove_project_memory`.
  const dryRun = run.remove(planted, ['--dry']);
  const realRun = run.remove(planted);
  const dryList = dryRun.json && Array.isArray(dryRun.json.removed) ? [...dryRun.json.removed].sort() : null;
  const realList = realRun.json && Array.isArray(realRun.json.removed) ? [...realRun.json.removed].sort() : null;
  const sameList = dryList !== null && realList !== null
    && JSON.stringify(dryList) === JSON.stringify(realList);
  out(`  сухой прогон против боевого: сухой ${dryList ? dryList.length : '—'},`
    + ` боевой ${realList ? realList.length : '—'}${sameList ? '' : '  <-- РАСХОЖДЕНИЕ'}`);
  if (!sameList) {
    notes.push(`сухой снос обещает не то, что делает боевой: ${JSON.stringify(dryList)}`
      + ` против ${JSON.stringify(realList)}`);
  }

  const survived = await Promise.all([
    exists(path.join(planted, '.claude', 'artifacts', 'events.jsonl')),
    exists(path.join(planted, '.claude', 'tasks', '2026-01-01-x', 'PLAN.md')),
    exists(path.join(planted, '.claude.backup-2026-01-01', 'VERSION')),
    exists(path.join(planted, 'src', 'index.js')),
    exists(path.join(planted, '.claude', 'чужой-файл.md')),
  ]);
  const names = ['память: журнал событий', 'память: папка задачи', 'каталог копии', 'исходники проекта', 'файл из чужого реестра'];
  const allAlive = survived.every(Boolean);
  out(`  подложенная запись: уцелело ${survived.filter(Boolean).length} из ${survived.length}${allAlive ? '' : '  <-- РАСХОЖДЕНИЕ'}`);
  survived.forEach((alive, i) => { if (!alive) notes.push(`снос по подложенной записи удалил ${names[i]}`); });
}

// --- проверка 5: чужой хук не исполняется -------------------------------------

async function checkForeignHook(parent, run, notes) {
  const root = path.join(parent, 'чужой-хук');
  await mkdir(path.join(root, '.claude', 'hooks'), { recursive: true });
  const marker = path.join(root, 'МАРКЕР-ЧУЖОГО-ХУКА.txt');
  const body = [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(marker)}, 'чужой хук исполнился');`,
  ].join(NL);
  await writeFile(path.join(root, '.claude', 'hooks', 'stubs.mjs'), `${body}${NL}`);

  const res = run.deploy(root, 'full');
  const ran = await exists(marker);
  out(`  маркер чужого хука: ${ran ? 'ПОЯВИЛСЯ' : 'нет'}${ran ? '  <-- РАСХОЖДЕНИЕ' : ''}`);
  if (ran) notes.push('чужой хук ИСПОЛНИЛСЯ: в стенде появился его файл-маркер');

  const record = await readFile(path.join(root, '.claude', DEPLOY_RECORD), 'utf8').catch(() => '');
  const said = (res.json && JSON.stringify(res.json).includes('не наш')) || record.includes('не наш');
  out(`  строка «хук не наш» в отчёте и записи: ${said ? 'есть' : 'НЕТ'}${said ? '' : '  <-- РАСХОЖДЕНИЕ'}`);
  if (!said) notes.push('в отчёте и записи нет строки «хук не наш, не запускался»');
}

// --- проверка 6: эталон по профилю ---------------------------------------------

/**
 * ЭТАЛОН СЧИТАЕТСЯ ПО СОСТАВУ ПРОФИЛЯ — решение человека 2, и без этой проверки оно держалось
 * бы на честном слове.
 *
 * Что меряется:
 *   • три стенда, три профиля: вердикт `match_preset`, а ПОЛНЫЕ значения при узком профиле
 *     законно НЕ совпадают с полным значением эталона — ровно то, что раньше давало
 *     «расхождение навсегда»;
 *   • стенд «набор уже стоял»: ядро целиком пропущено additive-копией, и вердикт — сверка
 *     по составу, а НЕ «ядро не наше» (находка N круга 3 аудита), при этом список
 *     пропущенного ядра в ответе непуст — состояние обязано уметь назвать причину;
 *   • подмена файла ядра даёт расхождение с этим путём, удаление файла ядра — «ядро
 *     не наше» с этим путём;
 *   • НАЗВАННАЯ ГРАНИЦА: подмена файла в `agents/`, честно пропущенного при раскладке,
 *     вердикта не меняет. Это цена решения человека 2, а не дефект.
 *
 * Читатель берётся ИЗ КОПИИ (пробы правят только её), эталон считается по СИНТЕТИЧЕСКОЙ
 * мастер-копии — боевая не трогается.
 */
async function checkPresetVerdict(parent, copyDir, run, stands, master, notes) {
  const kitMod = await import(pathToFileURL(path.join(copyDir, 'read', 'kit.mjs')).href);
  const refMod = await import(pathToFileURL(path.join(copyDir, 'read', 'reference.mjs')).href);
  const reference = await refMod.readReference({ dir: master.dir });
  if (!reference || !reference.fingerprint.value) {
    notes.push('эталон по синтетической мастер-копии не посчитался — мерить нечего');
    return;
  }

  for (const preset of PRESET_KEYS) {
    const stand = stands[preset];
    if (!stand || !stand.res.json || stand.res.json.ok !== true) continue;
    const k = await kitMod.readKit(stand.root, { reference });
    const comp = k.fingerprint.composition;
    const verdictOk = k.fingerprint.verdict === 'match_preset';
    const profileOk = Boolean(comp) && comp.profile === preset;
    const fullDiffers = k.fingerprint.value !== reference.fingerprint.value;
    const narrow = preset !== 'full';
    const ok = verdictOk && profileOk && (!narrow || fullDiffers);
    out(`  ${preset.padEnd(12)}: вердикт ${k.fingerprint.verdict}, профиль ${comp ? comp.profile : "—"},`
      + ` полные значения ${fullDiffers ? "различаются" : "совпадают"},`
      + ` исключено ${comp ? comp.excluded.length : "—"}${ok ? "" : "  <-- РАСХОЖДЕНИЕ"}`);
    if (!verdictOk) notes.push(`профиль «${preset}»: вердикт ${k.fingerprint.verdict}, а ожидался match_preset`);
    if (!profileOk) notes.push(`профиль «${preset}»: сверка по составу не сработала (нет объекта состава)`);
    if (narrow && !fullDiffers) notes.push(`профиль «${preset}»: полные значения совпали — стенд не мерит того, ради чего заведён`);
  }

  // СТЕНД «НАБОР УЖЕ СТОЯЛ»: ядро целиком пропущено additive-копией.
  //
  // Строится он так: разложить, убрать запись и ОДИН не-ядровой файл, разложить снова.
  // Второй прогон кладёт ровно этот один файл, а всё ядро уходит в список пропущенного ядра —
  // то есть в списке положенного ядра НЕТ ни одного пути. Именно на этом сценарии условие
  // «путь ядра обязан быть в положенном» давало бы «ядро не наше» навсегда.
  const already = path.join(parent, 'уже-стоял');
  await mkdir(path.join(already, 'src'), { recursive: true });
  run.deploy(already, 'full');
  await rm(path.join(already, '.claude', DEPLOY_RECORD), { force: true });
  await rm(path.join(already, '.claude', 'agents', 'implementer.md'), { force: true });
  const again = run.deploy(already, 'full');
  const placedNow = again.json && Array.isArray(again.json.placed) ? again.json.placed : [];
  const kAlready = await kitMod.readKit(already, { reference });
  const compAlready = kAlready.fingerprint.composition;
  const notForeign = kAlready.fingerprint.verdict === 'match_preset';
  const coreExplained = Boolean(compAlready) && compAlready.skipped_core.length > 0;
  out(`  набор уже стоял: положено ${placedNow.length}, вердикт ${kAlready.fingerprint.verdict},`
    + ` пропущено ядра ${compAlready ? compAlready.skipped_core.length : "—"}`
    + `${notForeign && coreExplained ? "" : "  <-- РАСХОЖДЕНИЕ"}`);
  if (!notForeign) {
    notes.push(`на стенде «набор уже стоял» вердикт ${kAlready.fingerprint.verdict}`
      + ` (${kAlready.fingerprint.reason || 'без причины'}), а ожидалась сверка по составу`);
  }
  if (!coreExplained) notes.push('список пропущенного ядра пуст — состояние «ядро не наше» нечем объяснить');

  // НАЗВАННАЯ ГРАНИЦА: подмена честно пропущенного файла в `agents/` вердикта не меняет.
  await writeFile(path.join(already, '.claude', 'agents', 'documenter.md'), `подменено${NL}`);
  const kAgent = await kitMod.readKit(already, { reference });
  const boundaryOk = kAgent.fingerprint.verdict === kAlready.fingerprint.verdict;
  out(`  подмена пропущенного агента: вердикт ${kAgent.fingerprint.verdict}`
    + ` (граница названа, ожидание — прежний)${boundaryOk ? "" : "  <-- РАСХОЖДЕНИЕ"}`);
  if (!boundaryOk) notes.push(`подмена пропущенного файла agents/ изменила вердикт на ${kAgent.fingerprint.verdict}`);

  // ПОДМЕНА ФАЙЛА ЯДРА — расхождение с этим путём.
  const swapped = path.join(parent, 'ядро-подмена');
  await mkdir(path.join(swapped, 'src'), { recursive: true });
  run.deploy(swapped, 'full');
  await writeFile(path.join(swapped, '.claude', 'hooks', 'stubs.mjs'), `подменённый хук${NL}`);
  const kSwap = await kitMod.readKit(swapped, { reference });
  const swapOk = kSwap.fingerprint.verdict === 'mismatch'
    && kSwap.fingerprint.diverged.includes('hooks/stubs.mjs');
  out(`  подмена файла ядра: вердикт ${kSwap.fingerprint.verdict}, путь в перечне`
    + ` ${kSwap.fingerprint.diverged.includes('hooks/stubs.mjs') ? 'да' : 'НЕТ'}`
    + `${swapOk ? "" : "  <-- РАСХОЖДЕНИЕ"}`);
  if (!swapOk) notes.push(`подмена файла ядра дала ${kSwap.fingerprint.verdict} без пути в перечне`);

  // УДАЛЕНИЕ ФАЙЛА ЯДРА — «ядро не наше» с этим путём.
  const removed = path.join(parent, 'ядро-нет');
  await mkdir(path.join(removed, 'src'), { recursive: true });
  run.deploy(removed, 'full');
  await rm(path.join(removed, '.claude', 'hooks', 'write-manifest.mjs'), { force: true });
  const kGone = await kitMod.readKit(removed, { reference });
  const compGone = kGone.fingerprint.composition;
  const goneOk = kGone.fingerprint.verdict === 'unknown'
    && kGone.fingerprint.reason === 'core_foreign'
    && Boolean(compGone) && compGone.core_missing.includes('hooks/write-manifest.mjs');
  out(`  удаление файла ядра: вердикт ${kGone.fingerprint.verdict}, причина ${kGone.fingerprint.reason},`
    + ` путь в перечне ${compGone && compGone.core_missing.length ? "да" : "НЕТ"}`
    + `${goneOk ? "" : "  <-- РАСХОЖДЕНИЕ"}`);
  if (!goneOk) notes.push(`удаление файла ядра дало ${kGone.fingerprint.verdict}/${kGone.fingerprint.reason}`);
}

// --- проверка 7: старая мастер-копия не даёт неполных профилей -----------------

/**
 * СТАРАЯ МАСТЕР-КОПИЯ И НЕПОЛНЫЙ ПРОФИЛЬ — случай, который не мерил ни один инструмент
 * (находка ревью части E). На боевой мастер-копии он недостижим: там версия ниже порога,
 * и узкие профили отвергаются ещё до раскладки, — а на синтетической 1.18.0 отказ
 * не наступает вовсе. Поэтому здесь заводится ВТОРАЯ синтетическая мастер-копия, отличающаяся
 * от первой ровно одним файлом — версией.
 *
 * Почему порог вообще есть: правило про отсутствующего агента появилось в промте оркестратора
 * только в 1.18.0. Разложить неполный профиль из копии постарше значит оставить конвейер
 * звать агентов, которых в проекте нет, — и отказ будет тем же зависанием.
 *
 * Меряются ОБЕ стороны: неполный профиль отбит и НИЧЕГО не положено, полный — проходит.
 * Одной первой мало: «отказывает всегда» — тоже поломка, просто в другую сторону.
 */
async function checkOldMaster(parent, run, master, notes) {
  const oldDir = path.join(parent, 'мастер-старый');
  await mkdir(oldDir, { recursive: true });
  // Копия синтетической мастер-копии: те же файлы, другая версия.
  const copyTree = async (from, to) => {
    await mkdir(to, { recursive: true });
    for (const name of (await readdir(from)).sort()) {
      const src = path.join(from, name);
      const dst = path.join(to, name);
      const st = await lstat(src);
      if (st.isDirectory()) { await copyTree(src, dst); continue; }
      if (!st.isFile()) continue;
      await copyFile(src, dst);
    }
  };
  await copyTree(master.dir, oldDir);
  await writeFile(path.join(oldDir, 'VERSION'), `1.17.0${NL}`);

  const narrowRoot = path.join(parent, 'старый-узкий');
  const fullRoot = path.join(parent, 'старый-полный');
  await mkdir(path.join(narrowRoot, 'src'), { recursive: true });
  await mkdir(path.join(fullRoot, 'src'), { recursive: true });

  const narrow = run.deployFrom(oldDir, narrowRoot, 'no-docs');
  const narrowFiles = await exists(path.join(narrowRoot, '.claude'));
  const narrowOk = narrow.json && narrow.json.ok === false && !narrowFiles;
  out(`  неполный профиль из 1.17.0: ${narrow.json && narrow.json.ok === false ? `отбит (${narrow.json.code})` : 'РАЗЛОЖЕН'}`
    + ` · папка набора создана: ${narrowFiles ? 'ДА' : 'нет'}${narrowOk ? '' : '  <-- РАСХОЖДЕНИЕ'}`);
  if (!narrowOk) notes.push('неполный профиль разложился из мастер-копии старше 1.18.0');

  const full = run.deployFrom(oldDir, fullRoot, 'full');
  const fullOk = full.json && full.json.ok === true;
  out(`  полный профиль из 1.17.0: ${fullOk ? `положено ${full.json.placed.length}` : `ОТБИТ (${full.json && full.json.code})`}`
    + `${fullOk ? '' : '  <-- РАСХОЖДЕНИЕ'}`);
  if (!fullOk) notes.push('полный профиль из старой мастер-копии не разложился — отказ шире, чем нужно');
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
    out('Постоянные машинные проверки раскладки набора:');
    out(`  node pult/tools/deploy-check.mjs [каталог для стендов] [--negative ${Object.keys(PROBES).join('|')}]`);
    out('Отрицательные пробы правят ТОЛЬКО копию пульта в стенде:');
    for (const [name, p] of Object.entries(PROBES)) out(`  ${name.padEnd(14)} ${p.what}`);
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
  // ЗАМОК `--from` У ИНСТРУМЕНТА РАСКЛАДКИ отказывает ГРОМКО, если стенды лежат не во временном
  // каталоге: подмена источника разрешена только там. Скажем об этом сразу, а не через
  // пятнадцать непрошедших раскладок.
  const tmpReal = await realpath(os.tmpdir());
  const baseReal = await realpath(base).catch(() => base);
  if (!path.resolve(baseReal).toLowerCase().startsWith(path.resolve(tmpReal).toLowerCase())) {
    err('каталог стендов обязан лежать ВНУТРИ временного каталога системы:');
    err('подмена источника (--from) разрешена только для целей во временном каталоге,');
    err('а без неё проверка мерила бы боевую мастер-копию, а не свою синтетическую.');
    return 3;
  }

  const parent = await realpath(await mkdtemp(path.join(base, 'pult-deploy-')));
  const cfg = await realpath(await mkdtemp(path.join(base, 'pult-cfg-')));
  const copyDir = path.join(parent, 'pult');
  const masterDir = path.join(parent, 'мастер');

  const notes = [];
  const undecided = [];
  try {
    const copied = await mirror(copyDir);
    const master = await buildMaster(masterDir);
    master.dir = masterDir;
    out(`стенды: ${parent}`);
    out(`копия пульта: модулей ${copied} · синтетическая мастер-копия: файлов ${master.files.length}`);
    out(`реестр прогона: ${cfg} (боевой реестр не трогается)`);

    if (args.negative) {
      const probe = PROBES[args.negative];
      for (const edit of probe.edits) {
        const r = await patchText(path.join(copyDir, ...edit.file.split('/')), edit.from, edit.to);
        if (!r.ok) {
          err(`проба «${args.negative}» не наложилась на ${edit.file} (вхождений ${r.hits}) — код изменился, доказывать нечего`);
          return 3;
        }
      }
      out(`ОТРИЦАТЕЛЬНАЯ ПРОБА «${args.negative}»: ${probe.what}`);
    }
    out('');

    const run = makeRunner(copyDir, masterDir, cfg);
    run.copyDir = copyDir;

    out('1. состав, формула и память:');
    const standsByPreset = await checkComposition(parent, run, master, notes);
    out('');
    out('2. граница записи и граф импортов:');
    await checkScope(parent, copyDir, run, notes, undecided);
    out('');
    out('3. резервная копия:');
    await checkBackup(parent, run, notes);
    out('');
    out('4. слияние, блок игнорирования и снос:');
    await checkMergeAndRemove(parent, run, notes);
    out('');
    out('5. чужой хук не исполняется:');
    await checkForeignHook(parent, run, notes);
    out('');
    out('6. эталон считается по составу профиля:');
    await checkPresetVerdict(parent, copyDir, run, standsByPreset, master, notes);
    out('');
    out('7. старая мастер-копия не даёт неполных профилей:');
    await checkOldMaster(parent, run, master, notes);
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
    out('расхождений нет: состав сходится с профилем, запись не выходит за три места,');
    out('копия ложится до первого байта, чужое переживает слияние и снос, чужой хук не исполняется');
  }
  if (undecided.length) {
    out('');
    out('НЕ ДОКАЗАНО (случай не выполнялся):');
    for (const u of undecided) out(`  • ${u}`);
  }

  // КРАСНОЕ СИЛЬНЕЕ «НЕ ДОКАЗАНО»: расхождение остаётся расхождением, даже когда часть
  // случаев не выполнялась. Зелёный код требует и того и другого.
  const code = notes.length ? 1 : (undecided.length ? 3 : 0);

  if (args.negative) {
    out('');
    if (code === 1) {
      out(`проба «${args.negative}» покраснела — проверка стережёт то, что обещает`);
      return 1;
    }
    if (code === 3) {
      err(`проба «${args.negative}» НЕ ПОКРАСНЕЛА, но часть случаев не выполнялась — ничего не доказано`);
      return 3;
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
