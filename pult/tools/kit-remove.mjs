#!/usr/bin/env node
/**
 * Снять набор, разложенный пультом.
 *
 *   node pult/tools/kit-remove.mjs --from <путь> [--dry] [--json]
 *
 * ПРАВИЛО ФАЗЫ, ИЗ КОТОРОГО СЛЕДУЕТ ВСЁ ОСТАЛЬНОЕ: УДАЛЯЕТ ТОЛЬКО ТОТ, КТО КЛАЛ, И ТОЛЬКО
 * ПО СОБСТВЕННОЙ ЗАПИСИ. Наша запись — `.claude/.cckit-deploy.json`, её пишет
 * `pult/deploy/deploy.mjs`. Записи нет или она не разобралась — ОТКАЗ ЦЕЛИКОМ: доказать,
 * что клали мы, нечем, а догадка здесь стоит чужих файлов.
 *
 * ЧЕГО ЭТОТ ИНСТРУМЕНТ НЕ ЧИТАЕТ И ПОЧЕМУ (находка 1 круга 1 аудита фазы 4). Реестр
 * установленных файлов набора — тот, что пишет `.claude/hooks/write-manifest.mjs` для команды
 * `/cckit_uninstall`, — здесь НЕ ЧИТАЕТСЯ ВОВСЕ. Он считает нашим ВСЁ, чьё ИМЯ есть
 * в мастер-копии (`owned()` там же), а при недоступной мастер-копии — весь каталог набора;
 * пути в нём отсчитываются от корня проекта, а не от папки набора. По нему снос удалил бы
 * чужой хук, который additive-копия НАМЕРЕННО не тронула. Это два разных предмета, а не два
 * источника правды: тот файл остаётся предметом команды снятия самого набора.
 *
 * ТРИ ЗАЩИТЫ, КОТОРЫЕ РАБОТАЮТ НЕЗАВИСИМО ДРУГ ОТ ДРУГА:
 *   1. каждый путь проходит `deployTarget()` в режиме удаления — то есть ТОЛЬКО внутрь папки
 *      набора; каталог резервной копии и файл игнорирования шлюз в этом режиме не пропускает
 *      никогда: копия — единственный откат;
 *   2. память проекта (`MEMORY_PATHS` в `pult/config.mjs`) не удаляется НЕЗАВИСИМО от того,
 *      что лежит в записи: журнал событий не восстанавливается ничем;
 *   3. удаляются только пути из списка ПОЛОЖЕННОГО. Ни пропущенное, ни пропущенное ядро
 *      не удаляются никогда — это файлы человека, мы их не клали.
 *
 * ЗАПИСЬ О РАСКЛАДКЕ — НЕДОВЕРЕННЫЙ ВХОД, хотя писали её мы: её правят руками, она приезжает
 * вместе с копией чужой папки и переживает порчу диска. Поэтому она читается по форме,
 * с потолками, и всё непонятное отбрасывается со строкой.
 *
 * Коды возврата: 0 — снято (или показано), 3 — отказ.
 */

import path from 'node:path';
import process from 'node:process';

import { statSafe, capText } from '../lib/fs-safe.mjs';
import { FAULT, DEPLOY_RECORD, MAX_PLACED, MAX_DEVIATIONS, MAX_TEXT_FILE } from '../config.mjs';
import { checkRoot } from '../deploy/deploy.mjs';
import { readBytes, writeWholeFile, removePath, removeDirIfEmpty, writeContext } from '../deploy/fs.mjs';
import { KIT_DIR_NAME, DEPLOY_MODE, deployTarget } from '../deploy/gate.mjs';
import { OWNS_KEY, SETTINGS_NAME, readOwns, settingsPath, settingsRel } from '../deploy/settings.mjs';

const TAG = '[pult]';
const out = (s = '') => process.stdout.write(`${s}\n`);
const err = (s = '') => process.stderr.write(`${TAG} ${s}\n`);
const say = (s) => capText(s).text;

/** Путь состава: относительный, со слэшами, без двух точек. Иначе — не удаляем. */
function saneRel(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 200) return null;
  if (rel.includes(String.fromCharCode(0)) || rel.includes(String.fromCharCode(92))) return null;
  if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return null;
  if (rel.split('/').includes('..')) return null;
  return rel;
}

/**
 * Разобрать нашу запись о раскладке. Форма, потолки, отброшенное — поимённо.
 *
 * Читатель здесь СВОЙ, и это не дубль: демон получит своего (`pult/read/deploy-record.mjs`,
 * шаг 11 плана) — у того другой предмет (показать человеку на карточке) и другие правила
 * очистки текста. Этот читатель управляет УДАЛЕНИЕМ, поэтому он строже: всё, что не прошло
 * форму, не удаляется вовсе.
 */
function parseRecord(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, code: FAULT.DEPLOY_RECORD_INVALID };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, code: FAULT.DEPLOY_RECORD_INVALID };
  }
  const placed = [];
  const dropped = [];
  const raw = Array.isArray(data.placed) ? data.placed : null;
  if (!raw) return { ok: false, code: FAULT.DEPLOY_RECORD_INVALID };
  for (const item of raw) {
    if (placed.length >= MAX_PLACED) { dropped.push('положенное: сверх потолка'); break; }
    const rel = saneRel(item);
    if (!rel) { dropped.push(`положенное: негодный путь ${say(String(item)).slice(0, 60)}`); continue; }
    if (!placed.includes(rel)) placed.push(rel);
  }
  const list = (value, name) => {
    const res = [];
    const src = Array.isArray(value) ? value : [];
    for (const item of src) {
      if (res.length >= MAX_DEVIATIONS) { dropped.push(`${name}: сверх потолка`); break; }
      const rel = saneRel(item && typeof item === 'object' ? item.path : item);
      if (!rel) { dropped.push(`${name}: негодный путь`); continue; }
      res.push(rel);
    }
    return res;
  };
  return {
    ok: true,
    placed,
    skipped: list(data.skipped, 'пропущенное'),
    skippedCore: list(data.skipped_core, 'пропущенное ядро'),
    profile: typeof data.profile === 'string' ? say(data.profile).slice(0, 32) : null,
    version: typeof data.kit_version === 'string' ? say(data.kit_version).slice(0, 16) : null,
    dropped,
  };
}

/** Одинаковы ли две группы хуков — по значению, а не по номеру в массиве. */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Вычистить наши строки из файла настроек СТРОГО ПО СЛУЖЕБНОМУ КЛЮЧУ ВЛАДЕНИЯ.
 *
 * Группы хуков снимаются ТОЛЬКО при дословном совпадении: не совпало — строка «изменено
 * человеком, не трогаю». Файл удаляется целиком, только если он создан нами И кроме нашего
 * в нём ничего не осталось.
 */
async function cleanSettings(ctx, root, dry, report) {
  const file = settingsPath(root);
  const res = await readBytes(file, MAX_TEXT_FILE);
  if (!res.ok) {
    report.settings = { touched: false, why: 'файла настроек нет' };
    return;
  }
  let data;
  try {
    data = JSON.parse(res.buf.toString('utf8'));
  } catch {
    report.settings = { touched: false, why: 'файл настроек не разбирается — не трогаю' };
    report.notes.push('файл настроек не разбирается как JSON — он не тронут');
    return;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    report.settings = { touched: false, why: 'файл настроек — не объект, не трогаю' };
    return;
  }
  const mark = data[OWNS_KEY];
  if (!mark || typeof mark !== 'object') {
    report.settings = { touched: false, why: 'во владении пульта ничего не числится' };
    return;
  }
  const { owns } = readOwns(mark.owns);
  const createdFile = mark.created_file === true;

  let removedRules = 0;
  const perms = data.permissions && typeof data.permissions === 'object' && !Array.isArray(data.permissions)
    ? data.permissions : null;
  if (perms) {
    for (const key of ['allow', 'deny']) {
      if (!Array.isArray(perms[key])) continue;
      const before = perms[key].length;
      perms[key] = perms[key].filter((line) => !owns[key].includes(line));
      removedRules += before - perms[key].length;
    }
  }

  let removedGroups = 0;
  const kept = [];
  const hooks = data.hooks && typeof data.hooks === 'object' && !Array.isArray(data.hooks) ? data.hooks : null;
  if (hooks) {
    for (const event of Object.keys(owns.hooks)) {
      if (!Array.isArray(hooks[event])) continue;
      for (const mine of owns.hooks[event]) {
        const idx = hooks[event].findIndex((g) => same(g, mine));
        if (idx < 0) { kept.push(event); continue; }
        hooks[event].splice(idx, 1);
        removedGroups += 1;
      }
      if (!hooks[event].length) delete hooks[event];
    }
    if (!Object.keys(hooks).length) delete data.hooks;
  }
  for (const event of new Set(kept)) {
    report.notes.push(`группа хуков ${event} изменена человеком — не трогаю`);
  }

  delete data[OWNS_KEY];
  const leftovers = Object.keys(data).filter((k) => {
    if (k !== 'permissions') return true;
    const p = data.permissions;
    return Boolean(p && ((Array.isArray(p.allow) && p.allow.length) || (Array.isArray(p.deny) && p.deny.length)
      || Object.keys(p).some((x) => x !== 'allow' && x !== 'deny')));
  });

  if (createdFile && !leftovers.length) {
    if (!dry) {
      const done = await removePath(root, settingsRel(), {});
      report.settings = { touched: true, removedFile: done.ok, rules: removedRules, groups: removedGroups };
      if (!done.ok) report.notes.push(`файл настроек не удалился: ${done.code}`);
      return;
    }
    report.settings = { touched: true, removedFile: true, rules: removedRules, groups: removedGroups };
    return;
  }

  if (!dry) {
    const body = Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
    const put = await writeWholeFile(ctx, settingsRel(), body);
    if (!put.ok) report.notes.push(`файл настроек не переписался: ${put.code}`);
  }
  report.settings = { touched: true, removedFile: false, rules: removedRules, groups: removedGroups };
}

function usage() {
  out('Снять набор, разложенный пультом:');
  out('  node pult/tools/kit-remove.mjs --from <путь> [--dry] [--json]');
  out('');
  out('  --dry   показать поимённо, что было бы удалено, и ничего не менять');
  out('  --json  машинный отчёт в стандартный вывод');
}

function parseArgs(argv) {
  const args = { from: null, dry: false, json: false, help: false, bad: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { args.help = true; continue; }
    if (a === '--dry') { args.dry = true; continue; }
    if (a === '--json') { args.json = true; continue; }
    if (a === '--from') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) { args.bad = '--from без значения'; return args; }
      args.from = value;
      i += 1;
      continue;
    }
    args.bad = a;
    return args;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return 0; }
  if (args.bad) { err(`неизвестный ключ: ${args.bad}`); usage(); return 3; }
  if (!args.from) { err('не сказано, откуда снимать: --from <путь>'); return 3; }

  const report = {
    ok: false, code: null, dry: args.dry, root: args.from,
    removed: [], keptSkipped: [], refused: [], dirs: 0, settings: null, notes: [],
  };

  // 1. Санитария и корень — ТОЙ ЖЕ ДВЕРЬЮ, что у раскладки.
  const root = await checkRoot(args.from, report);
  if (!root) {
    if (args.json) out(JSON.stringify(report, null, 2));
    for (const n of report.notes) err(n);
    err(`отказ: ${report.code}`);
    return 3;
  }
  report.root = root;

  // 2. НАША ЗАПИСЬ. Нет или не разобралась — отказ целиком.
  const recordRel = `${KIT_DIR_NAME}/${DEPLOY_RECORD}`;
  const file = path.join(root, KIT_DIR_NAME, DEPLOY_RECORD);
  const raw = await readBytes(file, MAX_TEXT_FILE);
  if (!raw.ok) {
    report.code = raw.code === FAULT.PATH_UNREACHABLE ? FAULT.DEPLOY_RECORD_MISSING : raw.code;
    if (args.json) out(JSON.stringify(report, null, 2));
    err('записи о раскладке нет — СНИМАТЬ НЕЧЕГО: удаляет только тот, кто клал,');
    err('и только по собственной записи. Набор, поставленный промтом, снимается командой');
    err('/cckit_uninstall — это другой предмет и другой реестр.');
    return 3;
  }
  const record = parseRecord(raw.buf.toString('utf8'));
  if (!record.ok) {
    report.code = record.code;
    if (args.json) out(JSON.stringify(report, null, 2));
    err('запись о раскладке не разобралась — отказ целиком: догадываться, что здесь наше,');
    err('мы не будем. Разберите файл руками либо удалите папку набора сами.');
    return 3;
  }
  for (const d of record.dropped) report.notes.push(`из записи отброшено — ${d}`);
  report.profile = record.profile;
  report.version = record.version;

  const ctx = writeContext(root, null);
  const tally = { n: 0 };

  // 3. ФАЙЛ НАСТРОЕК СНИМАЕТСЯ ТОЛЬКО КАНАЛОМ ВЛАДЕНИЯ — ЧТО БЫ НИ ЛЕЖАЛО В ЗАПИСИ.
  //
  // Это лечение 🔴 ревью 03.09.2026 со стороны сноса. Раскладка больше не кладёт `settings.json`
  // копированием (`MERGED_FILES` в `pult/deploy/deploy.mjs`), но запись — недоверенный вход:
  // её правят руками, она приезжает с копией чужой папки, и запись, сделанная прежней версией
  // раскладчика, этот путь в списке положенного УЖЕ содержит. Удалить файл настроек целиком
  // по списку положенного значит унести правила, которые человек дописал после установки, —
  // самый дорогой отказ фазы. Поэтому путь вычёркивается из удаления ЗДЕСЬ, а файл проходит
  // через `cleanSettings()`, где работает правило плана: целиком — только если создан нами
  // И кроме нашего в нём ничего не осталось.
  const placedPaths = record.placed.filter((rel) => rel !== SETTINGS_NAME);
  if (placedPaths.length !== record.placed.length) {
    report.notes.push(`файл настроек стоит в записи как положенный — целиком не удаляю,`
      + ` снимаю только своё по служебному ключу владения`);
  }
  await cleanSettings(ctx, root, args.dry, report);

  // 4. Удаление ТОЛЬКО положенного и ТОЛЬКО через шлюз в режиме удаления.
  //
  // СУХОЙ ПРОГОН ИДЁТ ЧЕРЕЗ ТУ ЖЕ ДВЕРЬ (🟡 2 ревью 03.09.2026): `deployTarget()` ничего
  // не пишет, а предпросмотр, показывающий не то, что произойдёт, хуже отсутствующего.
  // Прежняя редакция спрашивала только `statSafe()` и обещала удалить память проекта, которую
  // боевой прогон отбивает кодом `remove_project_memory`, — то есть врала в сторону «удалю
  // больше» ровно там, где человек принимает решение.
  for (const rel of placedPaths) {
    const target = `${KIT_DIR_NAME}/${rel}`;
    const allowed = await deployTarget(root, target, DEPLOY_MODE.REMOVE, { tally });
    if (!allowed.ok) { report.refused.push({ path: rel, code: allowed.code }); continue; }
    if (args.dry) { report.removed.push(rel); continue; }
    const done = await removePath(root, target, { tally: { n: 0 } });
    if (done.ok) report.removed.push(rel);
    else report.refused.push({ path: rel, code: done.code });
  }

  // 5. Пропущенное не удаляется НИКОГДА — это файлы человека.
  report.keptSkipped = [...record.skipped, ...record.skippedCore];

  // 6. Пустые каталоги — после файлов и только пустые. Рекурсивного удаления нет: рядом
  //    с нашими файлами законно лежат чужие.
  if (!args.dry) {
    const dirs = new Set();
    for (const rel of record.placed) {
      const parts = rel.split('/');
      for (let i = parts.length - 1; i > 0; i -= 1) dirs.add(parts.slice(0, i).join('/'));
    }
    const ordered = [...dirs].sort((a, b) => b.split('/').length - a.split('/').length);
    for (const dir of ordered) {
      const done = await removeDirIfEmpty(root, `${KIT_DIR_NAME}/${dir}`, {});
      if (done.ok) report.dirs += 1;
    }
    // 7. Сама запись — последней: пока она есть, снос повторяем, если что-то не удалилось.
    const rec = await removePath(root, recordRel, {});
    if (!rec.ok) report.notes.push(`запись о раскладке не удалилась: ${rec.code}`);
    const kit = await removeDirIfEmpty(root, KIT_DIR_NAME, {});
    if (kit.ok) report.dirs += 1;
  }

  // 8. Запись из реестра пульта НЕ УДАЛЯЕТСЯ: список проектов ведёт человек.
  report.notes.push('запись в реестре пульта не тронута: список проектов ведёт человек');
  report.ok = true;

  if (args.json) out(JSON.stringify(report, null, 2));
  else {
    out(`${args.dry ? 'сухой прогон сноса' : 'снос'}: ${report.root}`);
    out(`из записи: профиль ${report.profile || '-'}, версия ${report.version || '-'}`);
    out(`${args.dry ? 'было бы удалено' : 'удалено'}: ${report.removed.length}`);
    for (const rel of report.removed) out(`  − ${rel}`);
    if (report.refused.length) {
      out(`не удалено (шлюз или уже нет): ${report.refused.length}`);
      for (const r of report.refused) out(`  · ${r.path}: ${r.code}`);
    }
    if (report.keptSkipped.length) out(`не наше, оставлено: ${report.keptSkipped.length}`);
    if (report.settings) out(`настройки: ${report.settings.why || `правил снято ${report.settings.rules}, групп хуков ${report.settings.groups}${report.settings.removedFile ? ', файл удалён целиком' : ''}`}`);
    if (!args.dry) out(`пустых каталогов убрано: ${report.dirs}`);
    for (const n of report.notes) out(`  · ${n}`);
  }
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  err(`не отработал: ${(e && (e.code || e.name)) || 'ошибка'}`);
  process.exit(3);
});
