#!/usr/bin/env node
/**
 * СЕРДЦЕ РАСКЛАДКИ: `inspect()` смотрит, `deploy()` кладёт.
 *
 * ПОРЯДОК ЖЁСТКИЙ, и каждый его пункт объяснён на месте. Перечислен он здесь целиком, потому
 * что порядок и есть главная гарантия: перестановка пунктов 5 и 6 отменяет откат, перестановка
 * 2 и 5 переписывает файл настроек этого самого репозитория.
 *
 *   1. санитария и корень (та же дверь, что у инструмента реестра: `rootRejection()`);
 *   2. МАРКЕРНЫЙ ОТКАЗ на репозиторий самого набора;
 *   3. источник — мастер-копия, версия читается и сравнивается ПО ЧИСЛАМ;
 *   4. состав — `ship.list` мастер-копии, пересечённый с профилем;
 *   5. РЕЗЕРВНАЯ КОПИЯ; не сверилась или есть пропущенное — раскладка НЕ НАЧИНАЕТСЯ;
 *   6. additive-копия состава, поимённые списки положенного и пропущенного;
 *   7. слияние с чужим файлом настроек;
 *   8. ДОПОЛНЕНИЕ блока игнорирования — байт в байт, теми же окончаниями строк;
 *   9. запись о раскладке ТРЕМЯ списками;
 *  10. запуск ТОЛЬКО СВОИХ хуков — по списку положенного этого прогона и по совпавшему хешу;
 *  11. заведение проекта в реестр пульта.
 *
 * ГРАНИЦА УТВЕРЖДЕНИЯ ПРО ЗАПУСК ХУКОВ — НАЗЫВАЕТСЯ ЗДЕСЬ, В ШАПКЕ. Между сверкой хеша
 * и запуском файл можно подменить: запуск идёт ПО ПУТИ, а не по открытому дескриптору. Окно
 * не закрывается и закрыто быть не может. Остаток мал: чтобы в него попасть, нужен процесс
 * с правом записи в каталог хуков проекта, а такой процесс и так получает исполнение через
 * обычную регистрацию хуков в `settings.json`.
 *
 * КАКОЕ ИЗ ДВУХ УСЛОВИЙ ЗАПУСКА НЕСЁТ БЕЗОПАСНОСТЬ (заметка Q аудита). Условий два: «мы его
 * положили этим прогоном» и «его хеш равен файлу мастер-копии». Безопасность несёт СВЕРКА
 * ХЕША: исполнение файла, байт в байт равного эталону, и есть исполнение нашего файла;
 * членство в списке положенного делает утверждение точным, но само по себе подмену не ловит.
 * ПРАВКАМИ И ПРОБАМИ СНИМАТЬ МОЖНО ЛЮБОЕ ИЗ ДВУХ, КРОМЕ СВЕРКИ ХЕША.
 *
 * ФОРМА ЗАПИСИ О РАСКЛАДКЕ (`.claude/.cckit-deploy.json`) — её читает `pult/tools/kit-remove.mjs`
 * и будет читать `pult/read/deploy-record.mjs`, поэтому она описана здесь дословно:
 *
 *   {
 *     "schema": 1,
 *     "profile": "full" | "no-docs" | "checks-only",
 *     "date": "<ISO-8601 UTC>",
 *     "kit_version": "1.18.0",             версия мастер-копии, из которой раскладывали
 *     "placed":       ["hooks/gate.mjs", …],            что ЗАПИСАЛ этот прогон
 *     "skipped":      [{"path":"agents/x.md","why":"…"}],   пропущено в agents/ и commands/
 *     "skipped_core": [{"path":"hooks/gate.mjs","why":"…"}], пропущенное ЯДРО
 *     "settings":     {"created_file":false,"allow":N,"deny":N,"hooks":["SessionStart",…]},
 *     "gitignore":    {"added":N,"mode":"block"|"group"|"none"},
 *     "hooks":        [{"path":"hooks/stubs.mjs","ran":true,"why":null}]
 *   }
 *
 * Пути в `placed` — ОТ ПАПКИ НАБОРА (`hooks/gate.mjs`), а не от корня проекта: это форма
 * состава, та же, что в `ship.list`. Реестр установленных файлов набора
 * (`.cckit-manifest.json`) пишет пути ОТ КОРНЯ ПРОЕКТА — не перепутайте, это разные файлы
 * с разными предметами.
 *
 * ФАЙЛ НАСТРОЕК ИДЁТ НЕ КОПИРОВАНИЕМ, А СЛИЯНИЕМ, и это несущее решение (🔴 ревью 03.09.2026).
 * `settings.json` есть в `ship.list`, поэтому additive-копия клала бы его как обычный файл —
 * и на проекте, где файла настроек не было, он попадал бы в список положенного, а снос удалял
 * бы его ЦЕЛИКОМ вместе с правилами, которые человек дописал после установки. Заодно ломалась
 * вся конструкция владения §4.4: `mergeSettings()` видел файл уже существующим, признак
 * «создан нами» всегда был ложью, владение по правам — пустым, а ветка «создан нами и чужого
 * не осталось» — мёртвым кодом. Поэтому файл настроек исключён из состава копирования
 * (`MERGED_FILES`) и целиком принадлежит каналу слияния; в проект он попадает — его создаёт
 * `mergeSettings()`, помечая `created_file`.
 *
 * ГРАНИЦА КЛЮЧА ПОДМЕНЫ ИСТОЧНИКА. Замок `--from` («принимается только для целей внутри
 * временного каталога») живёт в `pult/tools/kit-deploy.mjs`, а не здесь: `deploy()` принимает
 * ЛЮБОЙ источник. Для консольного пути этого достаточно — другого входа у раскладки сейчас нет,
 * — но часть E позовёт `deploy()` из главного процесса оболочки, и замок туда НЕ ПОЕДЕТ.
 * Тому, кто заводит второй вход, придётся повторить проверку здесь либо у себя.
 *
 * ТРЕТИЙ СПИСОК (`skipped_core`) ЗАВЕДЁН ПО НАХОДКЕ N КРУГА 3 АУДИТА и НИЧЕГО ИЗ СВЕРКИ
 * НЕ ВЫНОСИТ. Он существует затем, чтобы состояние «ядро не наше» умело назвать причину:
 * на главном сценарии §4.2 — раскладка туда, где набор уже стоит, — все файлы ядра пропускаются
 * additive-копией, и без этого списка карточка проекта показывала бы отказ без объяснения.
 * Разделяет списки `coreViolation()` из `pult/lib/profiles.mjs`, и её канал — ИСКЛЮЧЕНИЯ:
 * путь ядра исключением стать не может, но записан быть обязан.
 */

import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { statSafe, capText, sanePath, isUncPath, realPath, sessionEnv, inside } from '../lib/fs-safe.mjs';
import { rootRejection, rootRejectionKind, addProject } from '../lib/registry.mjs';
import { coreViolation, allows, presetKey, presetTitle, PRESET_DEFAULT } from '../lib/profiles.mjs';
import { referenceDir } from '../read/reference.mjs';
import {
  FAULT, VERSION_RE, MAX_SHIP_ENTRIES, MAX_SHIP_ENTRY, MAX_PLACED, MAX_DEVIATIONS, DEPLOY_RECORD,
  MAX_TEXT_FILE,
} from '../config.mjs';
import {
  snapshot, copyIfAbsent, ensureDir, readBytes, writeWholeFile, writeContext, fileLines,
  spliceLines, pathBudgetExceeded, SKIP_REASON,
} from './fs.mjs';
import { backupKit } from './backup.mjs';
import { mergeSettings, settingsPath } from './settings.mjs';
import { KIT_DIR_NAME, GITIGNORE_NAME } from './gate.mjs';

/**
 * Мастер-копия ниже этой версии не умеет неполных профилей: правило про отсутствующего агента
 * появляется в промте оркестратора шагом 14 плана фазы 4, и без него профиль `no-docs`
 * разложил бы набор, в котором таблица промта называет агентов, которых в проекте нет.
 * Полный профиль допустим из любой мастер-копии — он ничего не убирает.
 */
export const MIN_PRESET_VERSION = '1.18.0';

/**
 * ХУКИ, КОТОРЫЕ РАСКЛАДЧИК ЗАПУСКАЕТ ПОСЛЕ КОПИРОВАНИЯ, — закрытый список из двух, в этом
 * порядке. Те же два зовут промты установки: `stubs.mjs` материализует рабочие места
 * (`tasks/ACTIVE`, `explores/INDEX.md`, `artifacts/FAQ_TEMPLATE.md`), `write-manifest.mjs`
 * пишет реестр установленных файлов для команды снятия набора.
 */
export const HOOKS_TO_RUN = Object.freeze(['hooks/stubs.mjs', 'hooks/write-manifest.mjs']);

/**
 * ФАЙЛЫ СОСТАВА, КОТОРЫЕ РАСКЛАДКА НЕ КЛАДЁТ КОПИРОВАНИЕМ: у них свой канал — слияние.
 *
 * Сегодня он один — `settings.json`. Довод целиком записан в шапке модуля; коротко: файл общий
 * с проектом (§4.4 контракта), его нельзя ни перезаписать, ни удалить целиком, а additive-копия
 * не умеет ни того ни другого — она умеет только «положить, если нет», и именно это делало
 * файл человека НАШИМ по списку положенного.
 *
 * Сверка отпечатка от этого не страдает: `settings.json` стоит в списке `SKIP` самого алгоритма
 * (`pult/lib/fingerprint.mjs`), то есть в отпечаток он не входит ни у эталона, ни у проекта.
 */
export const MERGED_FILES = Object.freeze(['settings.json']);

/** Сколько ждём один хук. Больше минуты — это не «медленно», это «повис». */
const HOOK_TIMEOUT_MS = 60000;

/**
 * ЗАМОРОЖЕННЫЙ СПИСОК СТРОК БЛОКА ИГНОРИРОВАНИЯ. Дословно тот же, что диктуют промты установки
 * (`.claude/commands/cckit_install.md`), плюс строка каталога резервной копии — её промтам
 * добавляет шаг 15 плана фазы 4.
 *
 * Список ЗАМОРОЖЕН намеренно: по нему решается и «чего не хватает», и «наш ли это блок».
 * Добавите строку — она поедет в проекты при следующей раскладке, и это осознанное действие,
 * а не побочный эффект правки текста.
 */
export const IGNORE_BLOCK = Object.freeze([
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
  '# Резервные копии папки набора: их кладёт пульт перед раскладкой, внутри — всё то же самое.',
  '.claude.backup-*/',
]);

/** Пометка отдельной группы: ставится, только если наш блок в файле есть, но человеком правлен. */
const IGNORE_GROUP_NOTE = '# Claude Agent Kit — добавлено пультом (блок выше правлен человеком).';

/** Версия числами. Не разобралась — `null`, и вызывающий обязан отказать, а не догадываться. */
export function versionTriple(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(VERSION_RE);
  if (!m) return null;
  return m[0].split('.').map((n) => Number(n));
}

/**
 * Сравнение версий ПО ЧИСЛАМ, а не по строке. Строковое сравнение делает `1.9.0` больше
 * `1.18.0` — то есть ровно на переходе через десяток даёт обратный ответ.
 */
export function versionAtLeast(have, min) {
  const a = versionTriple(have);
  const b = versionTriple(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

/** Короткая строка человеку: очищенная и обрезанная. Свободный текст наружу иначе не идёт. */
const say = (s) => capText(s).text;

// --- состав -------------------------------------------------------------------

/**
 * Записи `ship.list` мастер-копии — с той же обёрткой, что у копии алгоритма отпечатка
 * (`state.entries()` в `pult/lib/fingerprint.mjs`): абсолютные, с двумя точками, с обратным
 * слэшем, с нулевым байтом, длиннее потолка и всё сверх потолка числа — отбрасываются.
 *
 * Список читается ЗДЕСЬ, а не берётся у `shipEntries()`: та функция работает только внутри
 * обхода `scan()` (ей нужен его контекст) и вдобавок пропускает изменяемые файлы (`SKIP`),
 * среди которых `settings.json` и шаблон профиля — а их раскладка обязана положить.
 */
export async function readShipList(masterDir) {
  const res = await readBytes(path.join(masterDir, 'ship.list'), MAX_TEXT_FILE);
  if (!res.ok) return { ok: false, entries: [], code: res.code };
  const NUL = String.fromCharCode(0);
  const BACKSLASH = String.fromCharCode(92);
  const out = [];
  const rejected = [];
  for (const raw of res.buf.toString('utf8').split(/\r?\n/)) {
    const entry = raw.split('#')[0].trim();
    if (!entry) continue;
    if (out.length >= MAX_SHIP_ENTRIES) { rejected.push('сверх потолка числа записей'); break; }
    if (entry.length > MAX_SHIP_ENTRY || entry.includes(NUL) || entry.includes(BACKSLASH)
      || path.isAbsolute(entry) || /^[A-Za-z]:/.test(entry) || entry.split('/').includes('..')) {
      rejected.push(entry.slice(0, 40));
      continue;
    }
    out.push(entry.replace(/\/$/, ''));
  }
  return { ok: true, entries: out, rejected, code: null };
}

/**
 * Состав раскладки: пары «путь в мастер-копии → путь в проекте», уже суженные профилем.
 *
 * ОДНА ПОДМЕНА ИМЕНИ, И ОНА ЖЕ ЕСТЬ В ПРОМТАХ УСТАНОВКИ: `PROJECT_PROFILE.template.md`
 * ложится в проект под именем `PROJECT_PROFILE.md`. В мастер-копии этот файл уже переименован
 * установщиком, поэтому источник ищется в двух местах: сначала шаблон, потом профиль
 * мастер-копии. Заполненный профиль САМОГО набора в проект не едет ни в одном варианте —
 * в мастер-копии его нет.
 */
export async function composition(masterDir, preset) {
  const list = await readShipList(masterDir);
  if (!list.ok) return { ok: false, files: [], code: FAULT.SHIP_LIST_MISSING };

  const files = [];
  const missing = [];
  let truncated = false;

  const push = (src, dst) => {
    if (files.length >= MAX_PLACED) { truncated = true; return; }
    files.push({ src, dst });
  };

  for (const entry of list.entries) {
    if (truncated) break;
    let src = entry;
    let dst = entry;
    if (entry === 'PROJECT_PROFILE.template.md') dst = 'PROJECT_PROFILE.md';

    let st = await statSafe(path.join(masterDir, src));
    if ((!st.ok || !st.stat.isFile()) && entry === 'PROJECT_PROFILE.template.md') {
      // Мастер-копия: шаблон уже переименован установщиком.
      src = 'PROJECT_PROFILE.md';
      st = await statSafe(path.join(masterDir, src));
    }
    if (!st.ok) { missing.push(entry); continue; }
    if (st.stat.isSymbolicLink()) { missing.push(entry); continue; }

    if (st.stat.isDirectory()) {
      const shot = await snapshot(path.join(masterDir, entry));
      if (!shot.ok) { missing.push(entry); continue; }
      for (const rel of [...shot.files.keys()].sort()) {
        const full = `${entry}/${rel}`;
        if (!allows(preset, full)) continue;
        push(full, full);
      }
      continue;
    }
    // Файл канала слияния копированием не кладётся — см. `MERGED_FILES`.
    if (MERGED_FILES.includes(dst)) continue;
    if (!allows(preset, dst)) continue;
    push(src, dst);
  }

  return { ok: !truncated, files, missing, rejected: list.rejected, truncated, code: truncated ? FAULT.BUDGET_EXHAUSTED : null };
}

// --- маркерный отказ ----------------------------------------------------------

/**
 * Признак «это репозиторий самого набора». Два признака, как в промтах установки и в хуке
 * обновления: в корне одновременно `install.ps1` и `install.sh`, либо первые строки
 * `.claude/CLAUDE.md` называют Claude Agent Kit.
 *
 * БЕЗ ЭТОЙ ПРОВЕРКИ инструмент переписал бы здесь `.claude/settings.json`, закрытый правилами
 * `deny` НАМЕРЕННО, — а правами это не ловится: раскладчик обычная команда вне модели прав
 * агента.
 */
export async function kitSourceMarker(root) {
  const ps = await statSafe(path.join(root, 'install.ps1'));
  const sh = await statSafe(path.join(root, 'install.sh'));
  if (ps.ok && sh.ok) return 'в корне лежат install.ps1 и install.sh';
  const md = await readBytes(path.join(root, KIT_DIR_NAME, 'CLAUDE.md'), MAX_TEXT_FILE);
  if (md.ok) {
    const head = md.buf.toString('utf8').split(/\r?\n/).slice(0, 3).join(' ');
    if (head.includes('Claude Agent Kit')) return 'первые строки .claude/CLAUDE.md называют Claude Agent Kit';
  }
  return null;
}

// --- блок игнорирования -------------------------------------------------------

/**
 * ДОПОЛНЕНИЕ БЛОКА ИГНОРИРОВАНИЯ, а не пропуск (лечение находки B круга 2 аудита: в проекте,
 * куда набор ставили промтом, блок УЖЕ ЕСТЬ — без строки про резервную копию).
 *
 * Правило идемпотентно по построению: строка добавляется, только если её точного вхождения
 * в файле ещё нет. Сравнение — по строке без хвостовых пробелов и без учёта вида перевода
 * строки; вставка идёт БАЙТАМИ по смещению, поэтому чужой текст возвращается на диск как был.
 *
 * Место вставки — конец НАШЕГО блока, если он найден по своей первой строке и человеком
 * не правлен (все строки подряд принадлежат замороженному списку). Блок правлен или не найден —
 * недостающее уходит отдельной группой в конец файла. Чужой текст не трогается никогда.
 */
export function planIgnore(buf) {
  const shape = fileLines(buf);
  const rows = shape.lines.map((l) => shape.text(l).replace(/\s+$/, ''));
  const present = new Set(rows);
  const missing = IGNORE_BLOCK.filter((line) => !present.has(line));
  if (!missing.length) return { mode: 'none', missing: [], at: buf.length, rows: [] };

  const head = rows.indexOf(IGNORE_BLOCK[0]);
  const known = new Set(IGNORE_BLOCK);
  if (head >= 0) {
    let end = head;
    let intact = true;
    while (end < rows.length && rows[end] !== '') {
      if (!known.has(rows[end])) { intact = false; break; }
      end += 1;
    }
    if (intact) {
      return { mode: 'block', missing, at: shape.lines[end - 1].next, rows: missing, eol: shape.eol };
    }
    const note = present.has(IGNORE_GROUP_NOTE) ? [] : [IGNORE_GROUP_NOTE];
    return { mode: 'group', missing, at: buf.length, rows: [...note, ...missing], eol: shape.eol };
  }
  return { mode: 'group', missing, at: buf.length, rows: missing, eol: shape.eol };
}

// --- запуск своих хуков -------------------------------------------------------

/** sha256 файла. Нечитаемый файл — `null`, и это значит «не сошлось», а не «сошлось». */
async function fileHash(file) {
  const res = await readBytes(file, MAX_TEXT_FILE * 8);
  if (!res.ok) return null;
  return createHash('sha256').update(res.buf).digest('hex');
}

/**
 * Запустить хуки набора — ТОЛЬКО СВОИ.
 *
 * Условий два (см. шапку): хук обязан быть в списке положенного ЭТОГО прогона и его хеш обязан
 * совпасть с файлом мастер-копии. Не сошлось — НЕ ЗАПУСКАЕМ, строка в отчёт и в запись.
 *
 * ЗАПУСК: `process.execPath` с абсолютным путём хука и `shell: false`.
 *
 * ЧЕМ ЭТОТ СЛУЧАЙ ОТЛИЧАЕТСЯ ОТ ФАЗЫ 3. В оболочке тот же приём ЗАПРЕЩЁН: там `process.execPath`
 * — двоичный файл Electron с чужим ABI, под которым нативный псевдотерминал не грузится, ради
 * чего заведён `findNode()` (`pult/shell/daemon.mjs`). Здесь это системный Node, под которым
 * уже идёт сама раскладка, — то есть ровно тот рантайм, которым набор и запускают. «Унифицировать»
 * эти два места нельзя ни в одну сторону.
 *
 * Подстановки по знаку процента здесь не бывает, потому что интерпретатора в цепочке нет:
 * рантайм обязан быть обычным исполняемым файлом, а не командным (`.cmd`/`.bat`), и это
 * проверяется.
 */
async function runOwnHooks(root, masterDir, placedSet, report) {
  const out = [];
  const runtimeExt = path.extname(process.execPath).toLowerCase();
  const runtimeOk = runtimeExt !== '.cmd' && runtimeExt !== '.bat';
  const hooksDir = path.join(root, KIT_DIR_NAME, 'hooks');

  for (const rel of HOOKS_TO_RUN) {
    const target = path.join(root, KIT_DIR_NAME, rel);
    const record = { path: rel, ran: false, why: null };

    if (!placedSet.has(rel)) {
      record.why = 'хук не наш, не запускался: его не клал этот прогон';
    } else if (!runtimeOk) {
      record.why = 'хук не запускался: рантайм — командный файл, а не обычный исполняемый';
    } else {
      const st = await statSafe(target);
      const inHooks = inside(hooksDir, target);
      if (!st.ok || st.stat.isSymbolicLink() || !st.stat.isFile() || !inHooks) {
        record.why = 'хук не наш, не запускался: путь не прошёл шлюз (ссылка, не файл или вне каталога хуков)';
      } else {
        const mine = await fileHash(path.join(masterDir, rel));
        const theirs = await fileHash(target);
        if (!mine || !theirs || mine !== theirs) {
          record.why = 'хук не наш, не запускался: хеш не совпал с мастер-копией';
        } else {
          const res = spawnSync(process.execPath, [target], {
            cwd: root,
            env: sessionEnv(),
            shell: false,
            windowsHide: true,
            timeout: HOOK_TIMEOUT_MS,
            encoding: 'utf8',
            maxBuffer: 1024 * 1024,
          });
          record.ran = res.status === 0 && !res.error;
          record.why = record.ran ? null
            : `хук отработал с ошибкой: ${say((res.error && (res.error.code || res.error.name)) || `код ${res.status}`)}`;
        }
      }
    }
    if (record.why) report.notes.push(`${rel}: ${record.why}`);
    out.push(record);
  }
  return out;
}

// --- запись о раскладке -------------------------------------------------------

/**
 * ПРЕЖНЕЕ ПОЛОЖЕННОЕ — из нашей же записи, но читается КАК НЕДОВЕРЕННЫЙ ВХОД: файл правят
 * руками, он приезжает вместе с копией чужой папки и переживает порчу диска.
 *
 * Зачем оно вообще. Повторная раскладка кладёт ноль файлов, и запись, переписанная пустым
 * списком, лишала бы человека отката ПЕРВОЙ раскладки — безобидное второе нажатие «разложить»
 * делало бы набор несносимым (🟡 5 ревью 03.09.2026). Объединение прежнего и нового находке 1
 * круга 1 аудита не противоречит: прежнее клали тоже мы и тем же инструментом, а не «неизвестно
 * кто», — в список удаления по-прежнему не попадает ничего, чего не клала раскладка.
 */
async function readPreviousPlaced(root) {
  const res = await readBytes(path.join(root, KIT_DIR_NAME, DEPLOY_RECORD), MAX_TEXT_FILE);
  if (!res.ok) return [];
  let data;
  try {
    data = JSON.parse(res.buf.toString('utf8'));
  } catch {
    return [];
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.placed)) return [];
  const NUL = String.fromCharCode(0);
  const BACKSLASH = String.fromCharCode(92);
  const out = [];
  for (const raw of data.placed) {
    if (out.length >= MAX_PLACED) break;
    if (typeof raw !== 'string' || !raw || raw.length > MAX_SHIP_ENTRY) continue;
    if (raw.includes(NUL) || raw.includes(BACKSLASH)) continue;
    if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) continue;
    if (raw.split('/').includes('..')) continue;
    if (!out.includes(raw)) out.push(raw);
  }
  return out;
}

/**
 * Собрать и записать `.claude/.cckit-deploy.json`.
 *
 * ПИШЕТСЯ ОНА И НА ОТКАЗЕ ТОЖЕ (🟡 4 ревью 03.09.2026). К этому месту состав уже лежит на диске,
 * и без записи снять его нечем: `kit-remove` отвечает «снимать нечего», потому что удаляет
 * только по нашей записи. Отказ на чужом файле настроек оставлял человека с наполовину
 * разложенным набором и без единого способа его убрать.
 *
 * ОБРЕЗКА СПИСКОВ НАЗЫВАЕТСЯ ПРИЗНАКОМ, А НЕ МОЛЧИТ (⚪ 2 ревью): читателю записи (шаг 11 плана)
 * обрезка вменена в обязанность как отдельное состояние, и молчаливый `slice()` дал бы ему
 * укороченный список под видом полного.
 */
async function writeRecord(ctx, root, report, meta) {
  const previous = await readPreviousPlaced(root);
  const placed = [...previous];
  for (const rel of report.placed) if (!placed.includes(rel)) placed.push(rel);

  const truncated = [];
  if (placed.length > MAX_PLACED) truncated.push('placed');
  if (report.skipped.length > MAX_DEVIATIONS) truncated.push('skipped');
  if (report.skippedCore.length > MAX_DEVIATIONS) truncated.push('skipped_core');

  const record = {
    schema: 1,
    profile: meta.preset,
    date: new Date().toISOString(),
    kit_version: meta.version,
    placed: placed.slice(0, MAX_PLACED),
    skipped: report.skipped.slice(0, MAX_DEVIATIONS),
    skipped_core: report.skippedCore.slice(0, MAX_DEVIATIONS),
    settings: report.settings
      ? {
        created_file: Boolean(report.settings.createdFile),
        allow: report.settings.allow || 0,
        deny: report.settings.deny || 0,
        hooks: report.settings.hooks || [],
      }
      : null,
    gitignore: report.gitignore,
    hooks: meta.hooks || [],
    truncated,
  };
  if (truncated.length) {
    report.notes.push(`списки записи обрезаны потолком: ${truncated.join(', ')} —`
      + ' снос по ней уберёт не всё');
  }
  if (previous.length && !report.placed.length) {
    report.notes.push(`положено ноль файлов: набор в проекте уже стоял. В записи сохранено`
      + ` положенное прежними прогонами — ${previous.length} путей, и снос по ней работает`);
  } else if (!report.placed.length) {
    report.notes.push('положено ноль файлов и прежней записи нет: снос по этой записи ничего'
      + ' не удалит — файлы набора в этом проекте не наши');
  }

  const put = await writeWholeFile(ctx, `${KIT_DIR_NAME}/${DEPLOY_RECORD}`,
    Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8'));
  return { ok: put.ok, code: put.code, placed: record.placed.length, previous: previous.length };
}

// --- осмотр -------------------------------------------------------------------

/**
 * ТОЛЬКО ЧТЕНИЕ: что в проекте уже есть, что будет добавлено, чего не хватает. Ни одной записи
 * на диск — это экран «в проекте уже есть вот это» (§4.2, правило 2).
 */
export async function inspect(root, options = {}) {
  const preset = presetKey(options.preset) || PRESET_DEFAULT;
  const report = {
    ok: false, code: null, root, preset, presetTitle: presetTitle(preset),
    marker: null, master: null, masterVersion: null, kitPresent: false,
    settingsPresent: false, claudeMdPresent: false,
    willPlace: [], willSkip: [], willSkipCore: [], hooksPresent: [], claudeMd: [], notes: [],
  };

  const rootReal = await checkRoot(root, report);
  if (!rootReal) return report;
  const canonRoot = rootReal;
  report.root = canonRoot;
  report.marker = await kitSourceMarker(canonRoot);

  const masterDir = options.from || referenceDir();
  report.master = masterDir;
  const version = await readMasterVersion(masterDir);
  report.masterVersion = version;
  if (!version) {
    report.code = FAULT.REFERENCE_MISSING;
    report.notes.push('мастер-копия набора не найдена или её версия не читается');
    return report;
  }

  const comp = await composition(masterDir, preset);
  if (!comp.ok && comp.code) {
    report.code = comp.code;
    report.notes.push('состав мастер-копии не прочитался целиком');
    return report;
  }

  const kitStat = await statSafe(path.join(canonRoot, KIT_DIR_NAME));
  report.kitPresent = kitStat.ok && kitStat.stat.isDirectory();

  // ФАЙЛ НАСТРОЕК И ПОЛЬЗОВАТЕЛЬСКИЙ `CLAUDE.md` — ОТДЕЛЬНЫМИ ПРИЗНАКАМИ. Первый в состав
  // копирования не входит (он идёт каналом слияния), второй в состав не входит вовсе,
  // поэтому в списках выше их нет ни в одном — а экран мастера (§4.2) обязан назвать оба
  // ДО раскладки: человек должен знать, что у него уже есть.
  const settingsStat = await statSafe(settingsPath(canonRoot));
  report.settingsPresent = settingsStat.ok && settingsStat.stat.isFile();
  const claudeStat = await statSafe(path.join(canonRoot, 'CLAUDE.md'));
  report.claudeMdPresent = claudeStat.ok && claudeStat.stat.isFile();

  for (const item of comp.files) {
    const st = await statSafe(path.join(canonRoot, KIT_DIR_NAME, item.dst));
    if (st.ok) {
      const row = { path: item.dst, why: SKIP_REASON.EXISTS };
      if (coreViolation(item.dst)) report.willSkipCore.push(row); else report.willSkip.push(row);
      if (item.dst.startsWith('hooks/')) report.hooksPresent.push(item.dst);
    } else {
      report.willPlace.push(item.dst);
    }
  }

  // Чужой `CLAUDE.md` — единственное настоящее столкновение (§4.2). Пульт его не чинит,
  // но показывает строки, способные спорить с контрольными точками.
  const md = await readBytes(path.join(canonRoot, 'CLAUDE.md'), MAX_TEXT_FILE);
  if (md.ok) {
    const marks = ['коммить', 'commit', 'не задавай', 'push', 'без вопросов', 'auto'];
    for (const line of md.buf.toString('utf8').split(/\r?\n/)) {
      if (report.claudeMd.length >= MAX_DEVIATIONS) break;
      const low = line.toLowerCase();
      if (marks.some((m) => low.includes(m))) report.claudeMd.push(say(line.trim()).slice(0, 160));
    }
  }

  report.ok = true;
  return report;
}

/** Версия мастер-копии — первая строка файла версии и только как совпадение регулярки. */
async function readMasterVersion(masterDir) {
  const res = await readBytes(path.join(masterDir, 'VERSION'), MAX_TEXT_FILE);
  if (!res.ok) return null;
  const first = res.buf.toString('utf8').split(/\r?\n/)[0];
  const m = typeof first === 'string' ? first.trim().match(VERSION_RE) : null;
  return m ? m[0] : null;
}

/**
 * Санитария и корень — ОДНА ДВЕРЬ на осмотр, раскладку и снос (`pult/tools/kit-remove.mjs`
 * зовёт её же). Вернёт канонизированный путь либо `null`, положив причину в отчёт.
 *
 * Дверь общая намеренно: две проверки корня разошлись бы, и один и тот же каталог оказался бы
 * законным для сноса и незаконным для раскладки — или наоборот.
 */
export async function checkRoot(root, report) {
  if (!sanePath(root) || isUncPath(root) || !path.isAbsolute(root)) {
    report.code = FAULT.PATH_UNREACHABLE;
    report.notes.push('путь пуст, сетевой, не абсолютный или содержит управляющие символы');
    return null;
  }
  const real = await realPath(path.resolve(root));
  if (!real.ok) {
    report.code = FAULT.PATH_UNREACHABLE;
    report.notes.push('корень проекта недоступен');
    return null;
  }
  const st = await statSafe(real.path);
  if (!st.ok || !st.stat.isDirectory()) {
    report.code = FAULT.PATH_UNREACHABLE;
    report.notes.push('корень проекта — не каталог');
    return null;
  }
  const rejected = rootRejection(real.path);
  if (rejected) {
    report.code = rejected;
    report.rootKind = rootRejectionKind(real.path);
    report.notes.push('каталог отвергнут как КОРЕНЬ ПРОЕКТА');
    return null;
  }
  return real.path;
}

// --- раскладка ----------------------------------------------------------------

/**
 * Разложить набор в проект.
 *
 * @param {string} root     корень проекта (из системного диалога или реестра — не со страницы)
 * @param {string} preset   ключ профиля из закрытого словаря
 * @param {object} options  `from` — подменённый источник (заперт инструментом), `dry` — без
 *                          единой записи, `register` — заводить ли проект в реестр (по умолчанию да)
 */
export async function deploy(root, preset, options = {}) {
  const dry = options.dry === true;
  const key = presetKey(preset);
  const report = {
    ok: false, code: null, dry, root, preset: key, presetTitle: presetTitle(key),
    backup: null, placed: [], skipped: [], skippedCore: [], settings: null,
    gitignore: null, hooks: [], registry: null, notes: [],
  };
  if (!key) {
    report.code = FAULT.ENUM_UNRECOGNISED;
    report.notes.push('профиль бывает только из закрытого словаря');
    return report;
  }

  // 1. Санитария и корень — та же дверь, что у инструмента реестра.
  const canonRoot = await checkRoot(root, report);
  if (!canonRoot) return report;
  report.root = canonRoot;

  // 2. МАРКЕРНЫЙ ОТКАЗ на репозиторий самого набора.
  const marker = await kitSourceMarker(canonRoot);
  if (marker) {
    report.code = FAULT.ROOT_IS_KIT_SOURCE;
    report.notes.push(`это исходники самого набора: ${marker}`);
    return report;
  }

  // 3. Источник и версия ПО ЧИСЛАМ.
  const masterDir = options.from || referenceDir();
  const version = await readMasterVersion(masterDir);
  report.master = masterDir;
  report.masterVersion = version;
  if (!version) {
    report.code = FAULT.REFERENCE_MISSING;
    report.notes.push('мастер-копия набора не найдена или её версия не читается');
    return report;
  }
  if (key !== PRESET_DEFAULT && !versionAtLeast(version, MIN_PRESET_VERSION)) {
    report.code = FAULT.VERSION_UNREADABLE;
    report.notes.push(`мастер-копия ${version} старше ${MIN_PRESET_VERSION}: неполные профили`
      + ' из неё не раскладываются — в ней нет правила про отсутствующего агента');
    return report;
  }

  // 4. Состав.
  const comp = await composition(masterDir, key);
  if (!comp.files.length) {
    report.code = comp.code || FAULT.SHIP_LIST_MISSING;
    report.notes.push('состав мастер-копии пуст или не прочитался');
    return report;
  }
  if (comp.truncated) {
    report.code = FAULT.BUDGET_EXHAUSTED;
    report.notes.push('состав мастер-копии не влез в потолок числа путей');
    return report;
  }
  for (const m of comp.missing || []) report.notes.push(`в мастер-копии нет: ${say(m)}`);

  const over = pathBudgetExceeded(path.join(canonRoot, KIT_DIR_NAME), comp.files.map((f) => f.dst));
  if (over.length) {
    report.code = FAULT.PATH_UNREACHABLE;
    report.notes.push(`${over.length} путей не влезают в предел длины пути — перенесите проект ближе к корню диска`);
    return report;
  }

  if (dry) {
    // Сухой прогон проходит весь порядок, но не пишет НИ ОДНОГО байта: ни копии, ни файлов,
    // ни записи. Показать он обязан то же, что покажет боевой.
    const look = await inspect(canonRoot, { preset: key, from: masterDir });
    report.ok = true;
    report.placed = look.willPlace;
    report.skipped = look.willSkip;
    report.skippedCore = look.willSkipCore;
    report.notes.push('сухой прогон: не записано ничего');
    return report;
  }

  // 5. РЕЗЕРВНАЯ КОПИЯ — до первого байта.
  const backup = await backupKit(canonRoot);
  report.backup = { ok: backup.ok, dir: backup.dir, message: say(backup.message) };
  if (!backup.ok) {
    report.code = backup.code || FAULT.BACKUP_MISMATCH;
    report.notes.push(say(backup.message));
    for (const s of backup.skipped.slice(0, MAX_DEVIATIONS)) {
      report.notes.push(`не переносится: ${say(s.rel)} (${s.why})`);
    }
    return report;
  }
  report.notes.push(say(backup.message));

  const ctx = writeContext(canonRoot, backup.dir);

  // 6. Additive-копия состава. Списки копятся ПОИМЁННО.
  const made = await ensureDir(ctx, KIT_DIR_NAME);
  if (!made.ok) {
    report.code = made.code;
    report.notes.push('папка набора в проекте не создалась');
    return report;
  }
  for (const item of comp.files) {
    const dirRel = path.posix.dirname(item.dst);
    if (dirRel && dirRel !== '.') {
      const dir = await ensureDir(ctx, `${KIT_DIR_NAME}/${dirRel}`);
      if (!dir.ok) {
        report.skipped.push({ path: item.dst, why: SKIP_REASON.REFUSED });
        continue;
      }
    }
    const res = await copyIfAbsent(ctx, path.join(masterDir, item.src), `${KIT_DIR_NAME}/${item.dst}`);
    if (res.placed) { report.placed.push(item.dst); continue; }
    const row = { path: item.dst, why: res.why || SKIP_REASON.REFUSED };
    // РАЗДЕЛЯЕТ СПИСКИ `coreViolation()`, и её канал — исключения: путь ядра исключением стать
    // не может, но записан быть обязан — иначе «ядро не наше» останется без объяснения.
    if (coreViolation(item.dst)) report.skippedCore.push(row); else report.skipped.push(row);
  }

  // 7. Слияние с чужим файлом настроек.
  const sourceSettings = await readBytes(path.join(masterDir, 'settings.json'), MAX_TEXT_FILE);
  let parsedSource = null;
  if (sourceSettings.ok) {
    try { parsedSource = JSON.parse(sourceSettings.buf.toString('utf8')); } catch { parsedSource = null; }
  }
  if (!parsedSource) {
    report.notes.push('настройки мастер-копии не разобрались — свои строки не добавлялись');
    report.settings = { ok: false, code: FAULT.SETTINGS_UNPARSED };
  } else {
    const merged = await mergeSettings(ctx, parsedSource);
    report.settings = {
      ok: merged.ok,
      code: merged.code,
      createdFile: merged.createdFile,
      allow: merged.addedAllow.length,
      deny: merged.addedDeny.length,
      hooks: merged.addedHooks,
      message: say(merged.message),
    };
    if (!merged.ok) {
      report.code = merged.code;
      report.notes.push(say(merged.message));
      // ЗАПИСЬ ПИШЕТСЯ ДАЖЕ ЗДЕСЬ: состав уже на диске, и без записи снять его нечем.
      const rec = await writeRecord(ctx, canonRoot, report, { preset: key, version, hooks: [] });
      report.record = rec.ok ? `${KIT_DIR_NAME}/${DEPLOY_RECORD}` : null;
      report.notes.push(`положено ${report.placed.length} файлов, и они остались на диске.`
        + ` Откат: node pult/tools/kit-remove.mjs --from <проект>`
        + `${backup.dir ? `, либо верните папку набора из копии ${backup.dir}` : ''}`);
      if (!rec.ok) {
        report.notes.push('запись о раскладке не записалась: снимать придётся руками');
      }
      return report;
    }
    report.notes.push(say(merged.message));
  }

  // 8. ДОПОЛНЕНИЕ блока игнорирования — байт в байт.
  const ignoreRel = GITIGNORE_NAME;
  const readIgnore = await readBytes(path.join(canonRoot, ignoreRel), MAX_TEXT_FILE);
  const buf = readIgnore.ok ? readIgnore.buf : Buffer.alloc(0);
  if (!readIgnore.ok && readIgnore.code !== FAULT.PATH_UNREACHABLE) {
    report.gitignore = { mode: 'none', added: 0, note: 'файл игнорирования не читается — не тронут' };
    report.notes.push('файл игнорирования не читается — не тронут');
  } else {
    const plan = planIgnore(buf);
    if (plan.mode === 'none') {
      report.gitignore = { mode: 'none', added: 0 };
    } else {
      const next = spliceLines(buf, plan.at, plan.rows, plan.eol || '\n');
      const put = await writeWholeFile(ctx, ignoreRel, next);
      if (put.ok) {
        report.gitignore = { mode: plan.mode, added: plan.rows.length };
        report.notes.push(`файл игнорирования дополнен: строк ${plan.rows.length}`
          + `${plan.mode === 'group' ? ' (отдельной группой в конец — наш блок правлен или отсутствует)' : ''}`);
      } else {
        report.gitignore = { mode: 'none', added: 0, code: put.code };
        report.notes.push('файл игнорирования не записался');
      }
    }
  }

  // 9 и 10. ХУКИ И ЗАПИСЬ. Хуки запускаются до записи, чтобы их исход в неё попал.
  const placedSet = new Set(report.placed);
  report.hooks = await runOwnHooks(canonRoot, masterDir, placedSet, report);

  const rec = await writeRecord(ctx, canonRoot, report, { preset: key, version, hooks: report.hooks });
  if (!rec.ok) {
    report.code = rec.code;
    report.notes.push('запись о раскладке не записалась: снос по ней работать не будет');
    return report;
  }
  report.record = `${KIT_DIR_NAME}/${DEPLOY_RECORD}`;
  report.recorded = rec.placed;

  // 11. Проект в реестр пульта — ТЕМ ЖЕ инструментом и с той же проверкой корня (договор
  //     с фазой 4, пункт 3).
  if (options.register !== false) {
    const added = await addProject(canonRoot, path.basename(canonRoot));
    report.registry = added.ok
      ? { ok: true, added: added.added, id: added.entry.id }
      : { ok: false, code: added.code };
    if (!added.ok) report.notes.push(`проект не завёлся в реестр: ${added.code}`);
  }

  report.ok = true;
  return report;
}
