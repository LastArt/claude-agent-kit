#!/usr/bin/env node
/**
 * Разложить набор в проект.
 *
 *   node pult/tools/kit-deploy.mjs --into <путь> --profile <ключ> [--from <путь>]
 *                                  [--report] [--dry] [--json]
 *
 * Инструмент по образцу `pult/tools/registry-add.mjs`: его запускает человек из консоли,
 * а с части E фазы 4 — оболочка подпроцессом по нажатию с подтверждением. Отсюда два свойства,
 * которые надо держать:
 *   • отказ обязан ЧИТАТЬСЯ, а не расшифровываться по машинному коду;
 *   • потоки разделены: человеку — поток ошибок, машинный отчёт (`--json`) — стандартный вывод.
 * Коды возврата: 0 — сделано (или показано), 3 — отказ.
 *
 * КЛЮЧИ РАЗБИРАЮТСЯ ПО ЗАКРЫТОМУ СПИСКУ, СВОБОДНОГО ТЕКСТА ИНСТРУМЕНТ НЕ ПРИНИМАЕТ. Значения
 * бывают ровно у трёх ключей, и все три — пути или ключ профиля из словаря.
 *
 * КЛЮЧ `--from` ЗАПЕРТ, И ЭТО ЛЕЧЕНИЕ НАХОДКИ C КРУГА 2 АУДИТА, А НЕ ОГОВОРКА.
 *
 * Он принимается ТОЛЬКО тогда, когда разрешённая цель `--into` лежит внутри временного каталога
 * системы (сверка канонизированных путей). Причина: сверка хеша хуков идёт ПРОТИВ ТОЙ ЖЕ
 * подменённой копии — значит без запрета ключ раскладывал бы произвольное дерево в живой проект
 * и ИСПОЛНЯЛ ЕГО ХУКИ КАК СВОИ. Довод «оболочка его не передаёт» здесь не работает: это
 * утверждение про оболочку, а не про того, кто может позвать оболочку машины.
 *
 * Там и только там разворачивает свои стенды `pult/tools/deploy-check.mjs`.
 *
 * САНИТАРИЯ `--from` ОПИСАНА СВОИМ СПИСКОМ, А НЕ ССЫЛКОЙ НА САНИТАРИЮ ЦЕЛИ. Буквально «та же»
 * невозможна: настоящая мастер-копия запрещена как КОРЕНЬ (`ROOT_KIND.KIT_MASTER`
 * в `pult/config.mjs`), то есть проверка корня отвергла бы законный источник. Здесь проверяется:
 * форма пути, не сетевой, `realpath`, обязан быть каталогом, внутри обязан лежать список
 * состава, и он не может лежать внутри целевого проекта.
 */

import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

import { statSafe, realPath, isUncPath, sanePath, inside } from '../lib/fs-safe.mjs';
import { PRESET_KEYS, presetKey, presetTitle } from '../lib/profiles.mjs';
import { FAULT, MAX_PATH, ROOT_KIND } from '../config.mjs';
import { deploy, inspect } from '../deploy/deploy.mjs';

const TAG = '[pult]';
const out = (s = '') => process.stdout.write(`${s}\n`);
const err = (s = '') => process.stderr.write(`${TAG} ${s}\n`);

/** Вид запрещённого корня — человеку. Ключи из закрытого словаря `ROOT_KIND`. */
const ROOT_REASON = Object.freeze({
  [ROOT_KIND.DRIVE_ROOT]: 'это корень диска (или корень файловой системы)',
  [ROOT_KIND.HOME]: 'это домашний каталог сам по себе — его ПОДКАТАЛОГИ развернуть можно',
  [ROOT_KIND.HOME_PARENT]: 'это каталог, в котором лежат домашние каталоги',
  [ROOT_KIND.KIT_MASTER]: 'это мастер-копия набора в домашнем каталоге',
  [ROOT_KIND.APP_DATA]: 'это сам каталог данных приложений — его ПОДКАТАЛОГИ развернуть можно',
  [ROOT_KIND.SYSTEM]: 'это системный каталог',
  [ROOT_KIND.REGISTRY]: 'это каталог реестра самого пульта',
});

/** Человеческий перевод машинных кодов отказа. Код без строки — общий хвост. */
const REASON = Object.freeze({
  [FAULT.ROOT_REJECTED]: 'выбранный каталог отвергнут как КОРЕНЬ ПРОЕКТА',
  [FAULT.ROOT_IS_KIT_SOURCE]: 'это папка с исходниками самого набора, а не проект',
  [FAULT.REFERENCE_MISSING]: 'мастер-копии набора нет или её версия не читается',
  [FAULT.VERSION_UNREADABLE]: 'мастер-копия старше требуемой для неполных профилей',
  [FAULT.BACKUP_MISMATCH]: 'резервная копия не сошлась с оригиналом — раскладка не начиналась',
  [FAULT.BACKUP_SKIPPED]: 'в папке набора есть то, что копия не переносит — раскладка не начиналась',
  [FAULT.SETTINGS_UNPARSED]: 'файл настроек проекта не разобрался — он не тронут',
  [FAULT.HOOK_NOT_OURS]: 'хук в проекте не наш — он не запускался',
  [FAULT.SOURCE_OUTSIDE_TMP]: 'подмена источника разрешена только для целей во временном каталоге',
  [FAULT.PATH_UNREACHABLE]: 'путь недоступен, слишком длинный или это не каталог',
  [FAULT.ENUM_UNRECOGNISED]: 'профиль бывает только из закрытого словаря',
  [FAULT.SHIP_LIST_MISSING]: 'в источнике нет списка состава (ship.list)',
  [FAULT.BUDGET_EXHAUSTED]: 'состав не влез в потолки раскладки',
});

function usage() {
  out('Разложить набор в проект:');
  out('  node pult/tools/kit-deploy.mjs --into <путь> --profile <ключ> [--from <путь>] [--report] [--dry] [--json]');
  out('');
  out('Профили:');
  for (const key of PRESET_KEYS) out(`  ${key.padEnd(12)} ${presetTitle(key)}`);
  out('');
  out('  --report  только посмотреть, что есть в проекте и что будет добавлено');
  out('  --dry     пройти весь порядок, не записав ни байта');
  out('  --json    машинный отчёт в стандартный вывод');
  out('  --from    подменить источник; принимается ТОЛЬКО для целей внутри временного каталога');
}

/** Разбор ключей по закрытому списку. Неизвестный ключ — отказ, а не «пропустим». */
function parseArgs(argv) {
  const args = { into: null, profile: null, from: null, report: false, dry: false, json: false, help: false, bad: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { args.help = true; continue; }
    if (a === '--report') { args.report = true; continue; }
    if (a === '--dry') { args.dry = true; continue; }
    if (a === '--json') { args.json = true; continue; }
    if (a === '--into' || a === '--profile' || a === '--from') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) { args.bad = `${a} без значения`; return args; }
      args[a.slice(2)] = value;
      i += 1;
      continue;
    }
    args.bad = a;
    return args;
  }
  return args;
}

/** Общая санитария пути аргумента: форма, длина, сетевая форма, канонизация, каталог. */
async function acceptDir(raw, what) {
  if (!sanePath(raw) || raw.length > MAX_PATH) {
    return { ok: false, message: `${what}: путь пуст, длиннее потолка или содержит управляющие символы` };
  }
  if (isUncPath(raw)) {
    return { ok: false, message: `${what}: сетевой (UNC) путь не поддерживается намеренно —`
      + ' обращение к нему уходит в сеть к чужому хосту с попыткой аутентификации' };
  }
  const real = await realPath(path.resolve(raw));
  if (!real.ok) return { ok: false, message: `${what}: путь недоступен (${real.code})` };
  if (isUncPath(real.path)) return { ok: false, message: `${what}: после разрешения ссылок путь оказался сетевым` };
  const st = await statSafe(real.path);
  if (!st.ok || !st.stat.isDirectory()) return { ok: false, message: `${what}: это не каталог` };
  return { ok: true, path: real.path };
}

/**
 * ЗАМОК КЛЮЧА `--from`: цель обязана лежать ВНУТРИ временного каталога системы.
 *
 * Сравнение канонизированное с обеих сторон — на Windows временный каталог приходит коротким
 * именем (`MANUKY~1`), и строковая сверка длинной формы с короткой не совпала бы ни разу,
 * то есть замок отказывал бы даже собственным стендам проверки.
 */
async function tempAllows(targetReal) {
  const tmp = await realPath(os.tmpdir());
  if (!tmp.ok) return false;
  return inside(tmp.path, targetReal) && path.resolve(tmp.path) !== path.resolve(targetReal);
}

/** Печать отчёта человеку — одинаковая у осмотра и у раскладки. */
function printHuman(kind, r) {
  out(`${kind}: ${r.root}`);
  out(`профиль: ${r.preset} (${r.presetTitle})`);
  if (r.masterVersion) out(`мастер-копия: ${r.master} (версия ${r.masterVersion})`);
  if (r.marker) out(`ПРИЗНАК ИСХОДНИКОВ НАБОРА: ${r.marker}`);
  if (r.backup && r.backup.dir) out(`резервная копия: ${r.backup.dir}`);
  if (Array.isArray(r.willPlace)) {
    out(`будет положено: ${r.willPlace.length}`);
    out(`уже есть (пропустим): ${r.willSkip.length} в agents/ и commands/, ${r.willSkipCore.length} в ядре`);
    if (r.hooksPresent.length) out(`хуки, уже лежащие в проекте: ${r.hooksPresent.join(', ')}`);
    if (r.claudeMd.length) {
      out('строки вашего CLAUDE.md, способные спорить с контрольными точками:');
      for (const line of r.claudeMd) out(`  ${line}`);
    }
  } else {
    out(`положено: ${r.placed.length}`);
    out(`пропущено: ${r.skipped.length} в agents/ и commands/, ${r.skippedCore.length} в ядре`);
    if (r.settings && r.settings.ok) {
      out(`настройки: прав ${(r.settings.allow || 0) + (r.settings.deny || 0)}, групп хуков ${(r.settings.hooks || []).length}`);
    } else if (r.settings) {
      out(`настройки: не тронуты (${r.settings.code})`);
    }
    if (r.gitignore) out(`файл игнорирования: ${r.gitignore.mode} (+${r.gitignore.added})`);
    for (const h of r.hooks || []) out(`хук ${h.path}: ${h.ran ? 'запущен' : h.why}`);
    if (r.registry) out(`реестр пульта: ${r.registry.ok ? (r.registry.added ? `добавлен ${r.registry.id}` : `уже был ${r.registry.id}`) : `не записан (${r.registry.code})`}`);
  }
  for (const n of r.notes || []) out(`  · ${n}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return 0; }
  if (args.bad) { err(`неизвестный ключ: ${args.bad}`); usage(); return 3; }
  if (!args.into) { err('не сказано, куда раскладывать: --into <путь>'); return 3; }

  const target = await acceptDir(args.into, 'цель');
  if (!target.ok) { err(target.message); return 3; }

  const preset = args.report ? (presetKey(args.profile) || 'full') : presetKey(args.profile);
  if (!preset) {
    err(`профиль бывает только из закрытого словаря: ${PRESET_KEYS.join(', ')}`);
    return 3;
  }

  // ЗАМОК `--from` — до любого обращения к источнику.
  let from = null;
  if (args.from !== null) {
    if (!await tempAllows(target.path)) {
      err('ключ --from принимается ТОЛЬКО когда цель лежит внутри временного каталога системы.');
      err('причина: сверка хеша хуков идёт против той же подменённой копии, то есть в живой');
      err('проект можно было бы разложить произвольное дерево и исполнить его хуки как свои.');
      return 3;
    }
    const src = await acceptDir(args.from, 'источник');
    if (!src.ok) { err(src.message); return 3; }
    const list = await statSafe(path.join(src.path, 'ship.list'));
    if (!list.ok || !list.stat.isFile()) { err('источник: внутри нет списка состава ship.list'); return 3; }
    if (inside(target.path, src.path)) { err('источник: он лежит внутри целевого проекта'); return 3; }
    from = src.path;
  }

  const result = args.report
    ? await inspect(target.path, { preset, from })
    : await deploy(target.path, preset, { from, dry: args.dry });

  if (args.json) out(JSON.stringify(result, null, 2));
  else printHuman(args.report ? 'осмотр' : (args.dry ? 'сухой прогон' : 'раскладка'), result);

  if (!result.ok) {
    const reason = REASON[result.code] || `отказ: ${result.code || 'неизвестно'}`;
    err(reason);
    if (result.code === FAULT.ROOT_REJECTED && result.rootKind) {
      err(`  ${ROOT_REASON[result.rootKind] || 'запрещённый корень'}`);
      err('корень служит границей всем проверкам пути: что назначено корнем, то раскладчик');
      err('и готов трогать. Поэтому корнем бывает только сама папка проекта.');
    }
    for (const n of result.notes || []) err(`  · ${n}`);
    return 3;
  }
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  err(`не отработал: ${(e && (e.code || e.name)) || 'ошибка'}`);
  process.exit(3);
});
