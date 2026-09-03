#!/usr/bin/env node
/**
 * РЕЗЕРВНАЯ КОПИЯ ПАПКИ НАБОРА — до первого изменённого байта, со сверкой и без ссылок.
 *
 * §4.2 контракта, правило 1: копия делается МОЛЧА и ДО первого изменения, а не просьбой
 * к человеку «сделайте бэкап» — человек кивнёт и не сделает. Откат обязан работать всегда,
 * а не когда человек оказался предусмотрительным.
 *
 * ПЯТЬ ПРАВИЛ, КАЖДОЕ ОПЛАЧЕНО ЧУЖИМ ОПЫТОМ:
 *
 *   (а) ЗАНЯТОСТЬ ИМЕНИ ПРОВЕРЯЕТСЯ `lstat`, А НЕ `stat`. Висячая ссылка для `stat`
 *       «не существует» — и мы записали бы копию СКВОЗЬ неё, то есть в чужой каталог.
 *       Занято — берём суффикс до двадцати; в существующий каталог не дописываем НИКОГДА:
 *       смешение двух состояний убивает откат вернее, чем его отсутствие.
 *   (б) ПОРЯДОК: снимок источника → предел длины пути → копия → снимок копии → сверка числа
 *       обычных файлов, объёма и числа пропущенного.
 *   (в) НЕПУСТОЙ СПИСОК ПРОПУЩЕННОГО ОСТАНАВЛИВАЕТ РАСКЛАДКУ. Это правило, а не
 *       предупреждение: копия без символических ссылок исходного дерева откатом не является,
 *       и «сошлось» означало бы «сошлось по тому, что мы согласились считать».
 *   (г) ТРИ СЛУЧАЯ WINDOWS НАЗЫВАЮТСЯ ПОИМЁННО, человеческими словами: файл открыт другим
 *       процессом, предел длины пути, обрыв на середине.
 *   (д) НЕПОЛНУЮ КОПИЮ МОДУЛЬ НЕ УДАЛЯЕТ САМ. Путь называется, уборка на человеке: удалять
 *       то, что могло оказаться единственным следом чужих файлов, мы не будем.
 *
 * (е) Папки набора нет вовсе — это НЕ отказ, а «копировать нечего»: раскладка в проект без
 * набора (§4.2) — штатный и самый частый случай.
 *
 * Все записи идут через `pult/deploy/fs.mjs`, то есть через шлюз раскладки: каталог копии —
 * одно из трёх разрешённых мест записи и передаётся шлюзу КОНКРЕТНЫМ значением.
 */

import path from 'node:path';

import { statSafe } from '../lib/fs-safe.mjs';
import { FAULT } from '../config.mjs';
import {
  snapshot, copyTree, ensureDir, pathBudgetExceeded, writeContext, relFromRoot, TREE_CAPS,
} from './fs.mjs';
import { KIT_DIR_NAME } from './gate.mjs';

/** Сколько раз пробуем занятое имя. Двадцать копий за день — это уже не «повторил случайно». */
const MAX_SUFFIX = 20;

/** Дата в имени каталога — местная: имя читает человек, а не машина. */
function stamp(now = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
}

/**
 * Человеческая причина по коду отказа — три случая Windows поимённо (правило «г»).
 * Слова выбираются здесь, а не у вызывающего: это единственное место, где известно,
 * на чём именно копия сорвалась.
 */
export function backupReason(code) {
  if (code === FAULT.FILE_UNREADABLE) {
    return 'файл открыт другим процессом — закройте редактор или Claude Code и повторите';
  }
  if (code === FAULT.PATH_UNREACHABLE) {
    return 'путь недоступен или слишком длинный — перенесите проект ближе к корню диска';
  }
  if (code === FAULT.BUDGET_EXHAUSTED) {
    return 'папка набора не влезла в потолки копирования (число файлов, объём или глубина)';
  }
  if (code === FAULT.FILE_TOO_BIG) return 'файл сверх потолка размера';
  return 'копия не удалась';
}

/**
 * Свободное имя каталога копии. Возвращает абсолютный путь либо `null`, если все двадцать
 * заняты. Занятость меряется `lstat`: висячая ссылка занимает имя так же, как каталог.
 */
async function freeName(root, now) {
  const base = `${KIT_DIR_NAME}.backup-${stamp(now)}`;
  for (let i = 0; i <= MAX_SUFFIX; i += 1) {
    const name = i === 0 ? base : `${base}-${i + 1}`;
    const abs = path.join(root, name);
    const st = await statSafe(abs);
    if (!st.ok && st.code === FAULT.PATH_UNREACHABLE) return abs;
  }
  return null;
}

/**
 * Скопировать папку набора проекта в соседний каталог `.claude.backup-<дата>`.
 *
 * @param {string} root  КАНОНИЗИРОВАННЫЙ корень проекта
 * @returns {object} `{ok, copied, dir, code, message, source, copy, skipped}`; `dir` дальше
 *                   передаётся шлюзу КОНКРЕТНЫМ значением, а не образцом `.claude.backup-*`.
 */
export async function backupKit(root, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const kitDir = path.join(root, KIT_DIR_NAME);

  // (е) Папки набора нет — копировать нечего, и это успех.
  const kitStat = await statSafe(kitDir);
  if (!kitStat.ok) {
    if (kitStat.code === FAULT.PATH_UNREACHABLE) {
      return { ok: true, copied: false, dir: null, code: null, message: 'копировать нечего: папки набора в проекте нет', skipped: [] };
    }
    return { ok: false, copied: false, dir: null, code: kitStat.code, message: backupReason(kitStat.code), skipped: [] };
  }
  if (kitStat.stat.isSymbolicLink() || !kitStat.stat.isDirectory()) {
    return {
      ok: false, copied: false, dir: null, code: FAULT.NOT_PLAIN_FILE, skipped: [],
      message: 'папка набора — ссылка или не каталог: раскладка в такой проект не начинается',
    };
  }

  // (б) Снимок источника — ДО создания чего бы то ни было.
  const source = await snapshot(kitDir);
  if (!source.ok) {
    return {
      ok: false, copied: false, dir: null, code: source.code || FAULT.BUDGET_EXHAUSTED, skipped: source.skipped,
      message: source.truncated
        ? 'обход папки набора усечён потолком — снимок неполон, копия откатом не была бы'
        : backupReason(source.code),
    };
  }

  // (в) Пропущенное в ИСТОЧНИКЕ останавливает раскладку до первого байта: копировать ссылки
  // мы не умеем и не будем, а копия без них откатом не является.
  if (source.skipped.length) {
    return {
      ok: false, copied: false, dir: null, code: FAULT.BACKUP_SKIPPED, skipped: source.skipped,
      message: 'в папке набора есть то, что копия не переносит (ссылки, файлы сверх потолка,'
        + ' не обычные файлы) — раскладка не начинается',
    };
  }

  // (а) Свободное имя.
  const dir = await freeName(root, now);
  if (!dir) {
    return {
      ok: false, copied: false, dir: null, code: FAULT.PATH_UNREACHABLE, skipped: [],
      message: `все имена копии за сегодня заняты (до ${MAX_SUFFIX + 1}) — уберите старые копии`,
    };
  }

  // (б) Предел длины пути — ДО копирования: половина скопированного дерева хуже отказа.
  const over = pathBudgetExceeded(dir, [...source.files.keys()]);
  if (over.length) {
    return {
      ok: false, copied: false, dir: null, code: FAULT.PATH_UNREACHABLE, skipped: [],
      message: `${over.length} путей не влезают в предел длины пути — перенесите проект ближе к корню диска`,
      over,
    };
  }

  const ctx = writeContext(root, dir);
  const made = await ensureDir(ctx, relFromRoot(root, dir));
  if (!made.ok) {
    return {
      ok: false, copied: false, dir, code: made.code, skipped: [],
      message: `каталог копии не создался: ${backupReason(made.code)}`,
    };
  }

  const copied = await copyTree(ctx, kitDir, dir, TREE_CAPS);
  if (!copied.ok) {
    // (д) Неполную копию НЕ УДАЛЯЕМ: путь называется, уборка на человеке.
    return {
      ok: false, copied: true, dir, code: copied.code, skipped: copied.skipped,
      message: `копия оборвалась на середине: ${backupReason(copied.code)}.`
        + ` Неполная копия осталась и не удалена: ${dir}`,
    };
  }
  if (copied.skipped.length) {
    return {
      ok: false, copied: true, dir, code: FAULT.BACKUP_SKIPPED, skipped: copied.skipped,
      message: `копия перенесла не всё (${copied.skipped.length} путей) — раскладка не начинается.`
        + ` Неполная копия осталась и не удалена: ${dir}`,
    };
  }

  // (б) Снимок копии и сверка ТРЁХ чисел: файлов, объёма и пропущенного.
  const copy = await snapshot(dir);
  if (!copy.ok) {
    return {
      ok: false, copied: true, dir, code: copy.code || FAULT.BACKUP_MISMATCH, skipped: copy.skipped,
      message: `снимок копии не снялся: ${backupReason(copy.code)}. Копия осталась: ${dir}`,
    };
  }
  const same = copy.files.size === source.files.size
    && copy.bytes === source.bytes
    && copy.skipped.length === 0;
  if (!same) {
    return {
      ok: false, copied: true, dir, code: FAULT.BACKUP_MISMATCH, skipped: copy.skipped,
      message: `копия не сошлась с оригиналом: файлов ${copy.files.size} против ${source.files.size},`
        + ` объём ${copy.bytes} против ${source.bytes}, пропущено ${copy.skipped.length}.`
        + ` Копия осталась: ${dir}`,
      source: { files: source.files.size, bytes: source.bytes },
      copy: { files: copy.files.size, bytes: copy.bytes },
    };
  }

  return {
    ok: true,
    copied: true,
    dir,
    code: null,
    skipped: [],
    message: `резервная копия папки набора: ${dir}`,
    source: { files: source.files.size, bytes: source.bytes },
    copy: { files: copy.files.size, bytes: copy.bytes },
  };
}
