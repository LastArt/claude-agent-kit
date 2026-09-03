#!/usr/bin/env node
/**
 * Примитивы пишущей раскладки: снимок дерева, копирование дерева, additive-копия, перезапись
 * файла целиком и удаление одного пути.
 *
 * ЭТО ЕДИНСТВЕННОЕ МЕСТО, ГДЕ ПУЛЬТ КОПИРУЕТ ДЕРЕВО. Прецедента этому в пульте нет ни одного,
 * поэтому правила выписаны здесь, а не подразумеваются:
 *
 *   • ВСЕ пути назначения проходят `deployTarget()` (`pult/deploy/gate.mjs`) — включая имя
 *     временного файла: своё имя мы строим сами, но проверять его дешевле, чем доказывать,
 *     что построили правильно;
 *   • ЗАПИСЬ «НА МЕСТЕ» ЗАПРЕЩЕНА. Пишем временный файл рядом и переименовываем. Это не
 *     украшение и не забота об атомарности: жёсткая ссылка внутри папки набора на файл СНАРУЖИ
 *     от обычного файла неотличима (`lstat` показывает обычный файл, родитель честно внутри
 *     корня), и отбивает её не проверка, а стратегия записи — переименование заменяет запись
 *     в каталоге и исходный inode не трогает. Тот же довод записан у `writeProjectFile()`
 *     в `pult/lib/fs-safe.mjs`;
 *   • ДОПИСЫВАНИЯ В КОНЕЦ НЕТ НИ ОДНОГО. Оно идёт СКВОЗЬ ссылку и теряет ровно ту страховку,
 *     ради которой запрещена запись «на месте». Свойство проверяемое: имя функции дозаписи
 *     из `node:fs/promises` и флаг открытия на дозапись не встречаются в этом файле НИ РАЗУ —
 *     в том числе и в этой шапке, чтобы поиск давал ноль, а не одну строку про самого себя
 *     (⚪ 4 ревью 03.09.2026);
 *   • СИМВОЛИЧЕСКИЕ ССЫЛКИ НЕ КОПИРУЮТСЯ ВОВСЕ и попадают в список пропущенного ОТДЕЛЬНЫМ
 *     счётчиком. От этого зависит смысл сверки резервной копии: копия без ссылок исходного
 *     дерева откатом не является, и «сошлось по числу файлов» без отдельного счётчика значило
 *     бы «сошлось по тому, что мы согласились считать».
 *
 * ЧУЖОЙ ФАЙЛ ПЕРЕПИСЫВАЕТСЯ БАЙТ В БАЙТ, И ОКОНЧАНИЯ СТРОК НЕ «ЧИНЯТСЯ» НИ В КАКУЮ СТОРОНУ
 * (заметка O аудита). Обычная реализация «разобрать по `/\r?\n/`, склеить `\n`» молча переводит
 * весь файл в другие окончания строк — на Windows это полный диф в чужом репозитории, и
 * обещание «чужой текст не трогается никогда» перестаёт быть правдой. Поэтому вставка сделана
 * НЕ пересборкой текста из строк, а склейкой БАЙТОВ: `fileLines()` возвращает границы строк
 * в байтах и преобладающий вид перевода строки, а `spliceLines()` вставляет новый кусок
 * по байтовому смещению. Всё, чего мы не добавляли, возвращается на диск тем же байтом,
 * включая кодировку, отметку порядка байтов и отсутствие завершающего перевода строки.
 *
 * Разбор по байту `0x0A` безопасен для UTF-8: в многобайтных последовательностях он
 * не встречается.
 */

import { readdir, mkdir, writeFile, rename, chmod, rm, readFile, rmdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { statSafe, isPlainFileStat, faultFromError } from '../lib/fs-safe.mjs';
import { FAULT, MAX_SCAN_FILE } from '../config.mjs';
import { deployTarget, DEPLOY_MODE } from './gate.mjs';

/**
 * Потолки обхода и копирования. Свои, а не бюджеты демона: там они защищают ЦИКЛ СОБЫТИЙ
 * живого сервера, здесь — разовую консольную операцию, у которой другой предмет («сколько мы
 * скопируем в худшем случае»).
 */
export const TREE_CAPS = Object.freeze({
  files: 5000,                     // файлов в одном дереве
  bytes: 64 * 1024 * 1024,         // объём одного дерева
  depth: 16,                       // глубина обхода
  file: MAX_SCAN_FILE,             // размер ОДНОГО копируемого файла
  entries: 4096,                   // записей в одном каталоге
});

/**
 * Предел длины пути. На Windows он равен 260 знакам, если длинные пути не включены в системе,
 * и упирается в него именно раскладка: `.claude/agents/security-auditor.md` внутри проекта,
 * лежащего глубоко, — обычное дело. Запас в 20 знаков оставлен на имя временного файла,
 * которое длиннее целевого.
 */
const PATH_LIMIT = process.platform === 'win32' ? 240 : 4000;

/** Причины, по которым путь попал в список пропущенного. Слова наши, закрытым списком. */
export const SKIP_REASON = Object.freeze({
  LINK: 'ссылка',
  TOO_BIG: 'файл сверх потолка',
  NOT_PLAIN: 'не обычный файл',
  EXISTS: 'уже есть у человека',
  REFUSED: 'путь не прошёл шлюз',
  TRUNCATED: 'обход усечён потолком',
});

/** Контекст записи: корень проекта и каталог резервной копии ЭТОГО прогона. */
export function writeContext(root, backupDir = null) {
  return { root, backupDir };
}

/** Путь от корня проекта в форме, которую понимает шлюз. */
export function relFromRoot(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

/** Разрешить путь записи через шлюз раскладки. Иного пути к диску в этом модуле нет. */
async function allowWrite(ctx, rel, kind = 'file') {
  return deployTarget(ctx.root, rel, DEPLOY_MODE.WRITE, { backupDir: ctx.backupDir, kind });
}

// --- (а) снимок ---------------------------------------------------------------

/**
 * Снимок дерева: относительный путь → размер, плюс ОТДЕЛЬНЫЙ список пропущенного.
 *
 * Ссылки считаются `lstat`-ом и в число обычных файлов не попадают: они уходят в `skipped`
 * своим счётчиком. Усечение по любому потолку — это признак и код, а не «снимок снят»:
 * сверка по усечённому снимку сказала бы «сошлось» о том, чего не смотрели.
 */
export async function snapshot(dir, caps = TREE_CAPS) {
  const files = new Map();
  const skipped = [];
  let bytes = 0;
  let truncated = false;
  let code = null;

  const walk = async (abs, rel, depth) => {
    if (truncated) return;
    if (depth > caps.depth) { truncated = true; code = FAULT.BUDGET_EXHAUSTED; return; }
    let names;
    try {
      names = await readdir(abs);
    } catch (e) {
      skipped.push({ rel, why: SKIP_REASON.NOT_PLAIN, code: faultFromError(e) });
      return;
    }
    if (names.length > caps.entries) { truncated = true; code = FAULT.BUDGET_EXHAUSTED; return; }
    for (const name of names.sort()) {
      if (truncated) return;
      const childAbs = path.join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      const st = await statSafe(childAbs);
      if (!st.ok) { skipped.push({ rel: childRel, why: SKIP_REASON.NOT_PLAIN, code: st.code }); continue; }
      if (st.stat.isSymbolicLink()) { skipped.push({ rel: childRel, why: SKIP_REASON.LINK, code: null }); continue; }
      if (st.stat.isDirectory()) { await walk(childAbs, childRel, depth + 1); continue; }
      if (!isPlainFileStat(st.stat, childAbs)) {
        skipped.push({ rel: childRel, why: SKIP_REASON.NOT_PLAIN, code: FAULT.NOT_PLAIN_FILE });
        continue;
      }
      if (files.size + 1 > caps.files || bytes + st.stat.size > caps.bytes) {
        truncated = true;
        code = FAULT.BUDGET_EXHAUSTED;
        return;
      }
      files.set(childRel, { size: st.stat.size });
      bytes += st.stat.size;
    }
  };

  const top = await statSafe(dir);
  if (!top.ok) return { ok: false, code: top.code, files, skipped, bytes, truncated };
  if (!top.stat.isDirectory() || top.stat.isSymbolicLink()) {
    return { ok: false, code: FAULT.NOT_PLAIN_FILE, files, skipped, bytes, truncated };
  }
  await walk(dir, '', 1);
  return { ok: !truncated, code, files, skipped, bytes, truncated };
}

// --- запись одного файла ------------------------------------------------------

/** Прочитать файл байтами с потолком размера и без разыменования ссылок. */
export async function readBytes(file, limit = TREE_CAPS.file) {
  const st = await statSafe(file);
  if (!st.ok) return { ok: false, buf: null, code: st.code };
  if (st.stat.isSymbolicLink() || !isPlainFileStat(st.stat, file)) {
    return { ok: false, buf: null, code: FAULT.NOT_PLAIN_FILE };
  }
  if (st.stat.size > limit) return { ok: false, buf: null, code: FAULT.FILE_TOO_BIG };
  try {
    return { ok: true, buf: await readFile(file), code: null, mode: st.stat.mode & 0o777 };
  } catch (e) {
    return { ok: false, buf: null, code: faultFromError(e) };
  }
}

/**
 * Записать байты по УЖЕ РАЗРЕШЁННОМУ пути: временный файл рядом, режим, переименование.
 *
 * Имя временного файла тоже проходит шлюз — см. шапку. Не прошло, не записалось или
 * не переименовалось — временный файл убирается, наружу уходит код.
 */
async function putBytes(ctx, rel, resolved, data, mode = null) {
  const dirRel = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
  const tmpName = `.${path.basename(resolved)}.${process.pid}.${Date.now()}.tmp`;
  const tmpRel = dirRel ? `${dirRel}/${tmpName}` : tmpName;
  // Временный файл проходит шлюз ВМЕСТЕ С НАЗВАННОЙ ЦЕЛЬЮ (`tmpFor`): цель уже разрешена,
  // а временный сосед обязан лежать в её каталоге. Так у файла `<root>/.gitignore`, чей
  // каталог — корень проекта, атомарная замена остаётся возможной, и при этом ни один путь
  // не идёт мимо двери.
  const tmpTarget = await deployTarget(ctx.root, tmpRel, DEPLOY_MODE.WRITE, {
    backupDir: ctx.backupDir, tmpFor: resolved,
  });
  if (!tmpTarget.ok) return { ok: false, code: tmpTarget.code };
  try {
    await writeFile(tmpTarget.path, data);
    if (mode !== null) { try { await chmod(tmpTarget.path, mode); } catch { /* Windows */ } }
    await rename(tmpTarget.path, resolved);
    return { ok: true, code: null };
  } catch (e) {
    try { await rm(tmpTarget.path, { force: true }); } catch { /* уже убран */ }
    return { ok: false, code: faultFromError(e) };
  }
}

/**
 * (г) ПЕРЕЗАПИСЬ ФАЙЛА ЦЕЛИКОМ. Принимает БАЙТЫ, а не строку: всё, что касается кодировки
 * и окончаний строк, решено до вызова — здесь только запись.
 */
export async function writeWholeFile(ctx, rel, data) {
  const target = await allowWrite(ctx, rel);
  if (!target.ok) return { ok: false, code: target.code };
  const st = await statSafe(target.path);
  const mode = st.ok && st.stat.isFile() ? (st.stat.mode & 0o777) : null;
  return putBytes(ctx, rel, target.path, data, mode);
}

/** Создать каталог (и всех его предков) — каждый уровень через шлюз, сверху вниз. */
export async function ensureDir(ctx, rel) {
  const parts = rel.split('/').filter(Boolean);
  let acc = '';
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    const target = await allowWrite(ctx, acc, 'dir');
    if (!target.ok) return { ok: false, code: target.code, rel: acc };
    const st = await statSafe(target.path);
    if (st.ok) {
      if (!st.stat.isDirectory() || st.stat.isSymbolicLink()) {
        return { ok: false, code: FAULT.NOT_PLAIN_FILE, rel: acc };
      }
      continue;
    }
    if (st.code !== FAULT.PATH_UNREACHABLE) return { ok: false, code: st.code, rel: acc };
    try {
      await mkdir(target.path);
    } catch (e) {
      // Каталог мог появиться между `lstat` и `mkdir` — это не ошибка раскладки.
      if (!e || e.code !== 'EEXIST') return { ok: false, code: faultFromError(e), rel: acc };
    }
  }
  return { ok: true, code: null };
}

// --- (в) additive-копия -------------------------------------------------------

/**
 * ADDITIVE-КОПИЯ: цель существует — НЕ ТРОГАЕМ и возвращаем «пропущено».
 *
 * Существование проверяется `lstat`-ом, БЕЗ разыменования: цель-ссылка тоже «уже есть»,
 * и писать сквозь неё нельзя ни при каких обстоятельствах. Отказ шлюза «цель не обычный файл»
 * означает здесь ровно то же самое и переводится в пропуск, а не в аварию: чужая ссылка
 * на месте нашего файла — это не поломка раскладки, это чужой файл, который мы не трогаем.
 */
export async function copyIfAbsent(ctx, srcAbs, rel) {
  const target = await allowWrite(ctx, rel);
  if (!target.ok) {
    if (target.code === FAULT.TARGET_NOT_PLAIN_FILE) {
      return { ok: true, placed: false, skipped: true, why: SKIP_REASON.NOT_PLAIN, code: null };
    }
    return { ok: false, placed: false, skipped: true, why: SKIP_REASON.REFUSED, code: target.code };
  }
  const st = await statSafe(target.path);
  if (st.ok) return { ok: true, placed: false, skipped: true, why: SKIP_REASON.EXISTS, code: null };
  if (st.code !== FAULT.PATH_UNREACHABLE) {
    return { ok: false, placed: false, skipped: true, why: SKIP_REASON.REFUSED, code: st.code };
  }
  const src = await readBytes(srcAbs);
  if (!src.ok) {
    const why = src.code === FAULT.FILE_TOO_BIG ? SKIP_REASON.TOO_BIG : SKIP_REASON.NOT_PLAIN;
    return { ok: false, placed: false, skipped: true, why, code: src.code };
  }
  const put = await putBytes(ctx, rel, target.path, src.buf, src.mode);
  if (!put.ok) return { ok: false, placed: false, skipped: true, why: SKIP_REASON.REFUSED, code: put.code };
  return { ok: true, placed: true, skipped: false, why: null, code: null };
}

// --- (б) копирование дерева ---------------------------------------------------

/**
 * Копия дерева: обычные файлы и каталоги. Ссылки не копируются вовсе и уходят в список
 * пропущенного; файл сверх потолка — туда же. Каждый файл пишется через временный
 * плюс переименование, режим переносится.
 *
 * Возвращает счётчики и список пропущенного — по ним сверяется резервная копия.
 */
export async function copyTree(ctx, fromDir, toDir, caps = TREE_CAPS) {
  const skipped = [];
  let files = 0;
  let bytes = 0;
  let code = null;

  const walk = async (absFrom, absTo, rel, depth) => {
    if (code) return;
    if (depth > caps.depth) { code = FAULT.BUDGET_EXHAUSTED; return; }
    const made = await ensureDir(ctx, relFromRoot(ctx.root, absTo));
    if (!made.ok) { code = made.code; return; }
    let names;
    try {
      names = await readdir(absFrom);
    } catch (e) {
      skipped.push({ rel, why: SKIP_REASON.NOT_PLAIN, code: faultFromError(e) });
      return;
    }
    if (names.length > caps.entries) { code = FAULT.BUDGET_EXHAUSTED; return; }
    for (const name of names.sort()) {
      if (code) return;
      const childFrom = path.join(absFrom, name);
      const childTo = path.join(absTo, name);
      const childRel = rel ? `${rel}/${name}` : name;
      const st = await statSafe(childFrom);
      if (!st.ok) { skipped.push({ rel: childRel, why: SKIP_REASON.NOT_PLAIN, code: st.code }); continue; }
      if (st.stat.isSymbolicLink()) { skipped.push({ rel: childRel, why: SKIP_REASON.LINK, code: null }); continue; }
      if (st.stat.isDirectory()) { await walk(childFrom, childTo, childRel, depth + 1); continue; }
      if (!isPlainFileStat(st.stat, childFrom)) {
        skipped.push({ rel: childRel, why: SKIP_REASON.NOT_PLAIN, code: FAULT.NOT_PLAIN_FILE });
        continue;
      }
      if (st.stat.size > caps.file) {
        skipped.push({ rel: childRel, why: SKIP_REASON.TOO_BIG, code: FAULT.FILE_TOO_BIG });
        continue;
      }
      if (files + 1 > caps.files || bytes + st.stat.size > caps.bytes) { code = FAULT.BUDGET_EXHAUSTED; return; }
      const src = await readBytes(childFrom, caps.file);
      if (!src.ok) { skipped.push({ rel: childRel, why: SKIP_REASON.NOT_PLAIN, code: src.code }); continue; }
      const relTo = relFromRoot(ctx.root, childTo);
      const target = await allowWrite(ctx, relTo);
      if (!target.ok) { skipped.push({ rel: childRel, why: SKIP_REASON.REFUSED, code: target.code }); continue; }
      const put = await putBytes(ctx, relTo, target.path, src.buf, src.mode);
      if (!put.ok) { skipped.push({ rel: childRel, why: SKIP_REASON.REFUSED, code: put.code }); continue; }
      files += 1;
      bytes += st.stat.size;
    }
  };

  await walk(fromDir, toDir, '', 1);
  return { ok: code === null, code, files, bytes, skipped };
}

// --- (д) предел длины пути ----------------------------------------------------

/**
 * Пути, которые не влезут в предел длины. Проверяется ДО копирования: половина скопированного
 * дерева хуже, чем внятный отказ до первого байта.
 */
export function pathBudgetExceeded(base, rels) {
  const over = [];
  for (const rel of rels) {
    if (path.join(base, ...String(rel).split('/')).length > PATH_LIMIT) over.push(rel);
  }
  return over;
}

// --- (е) удаление одного пути -------------------------------------------------

/** Удалить файл — ТОЛЬКО через шлюз в режиме удаления. */
export async function removePath(root, rel, ctx = {}) {
  const target = await deployTarget(root, rel, DEPLOY_MODE.REMOVE, ctx);
  if (!target.ok) return { ok: false, code: target.code };
  try {
    await rm(target.path, { force: true });
    return { ok: true, code: null };
  } catch (e) {
    return { ok: false, code: faultFromError(e) };
  }
}

/**
 * Удалить каталог, ЕСЛИ он пуст. Каталоги снимаются только после файлов и только пустыми:
 * рекурсивное удаление каталога унесло бы чужие файлы, лежащие в нём рядом с нашими.
 */
export async function removeDirIfEmpty(root, rel, ctx = {}) {
  const target = await deployTarget(root, rel, DEPLOY_MODE.REMOVE, { ...ctx, kind: 'dir' });
  if (!target.ok) return { ok: false, code: target.code };
  let names;
  try {
    names = await readdir(target.path);
  } catch (e) {
    return { ok: false, code: faultFromError(e) };
  }
  if (names.length) return { ok: false, code: FAULT.NOT_PLAIN_FILE, kept: true };
  try {
    await rmdir(target.path);
    return { ok: true, code: null };
  } catch (e) {
    return { ok: false, code: faultFromError(e) };
  }
}

// --- текст чужого файла: границы строк в БАЙТАХ --------------------------------

const LF = 0x0A;
const CR = 0x0D;

/**
 * Границы строк в байтах, преобладающий вид перевода строки и наличие завершающего перевода.
 *
 * Строка описывается тройкой: начало, конец содержимого (без перевода строки) и конец вместе
 * с переводом. Текст строки декодируется как UTF-8 ТОЛЬКО для сравнения — обратно в файл
 * он не едет никогда, поэтому файл в чужой однобайтной кодировке от нашей правки не портится:
 * мы вставим свои байты и вернём чужие как были.
 */
export function fileLines(buf) {
  const lines = [];
  let start = 0;
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] !== LF) continue;
    const hasCr = i > start && buf[i - 1] === CR;
    if (hasCr) crlf += 1; else lf += 1;
    lines.push({ start, end: hasCr ? i - 1 : i, next: i + 1 });
    start = i + 1;
  }
  const trailingNewline = buf.length === 0 ? true : buf[buf.length - 1] === LF;
  if (start < buf.length) lines.push({ start, end: buf.length, next: buf.length });
  return {
    lines,
    eol: crlf > lf ? '\r\n' : '\n',
    trailingNewline,
    text: (line) => buf.slice(line.start, line.end).toString('utf8'),
  };
}

/**
 * Вставить строки в файл ПО БАЙТОВОМУ СМЕЩЕНИЮ, ничего не переписывая вокруг.
 *
 * `at` — смещение в байтах (конец нашего блока либо длина файла). Если файл не кончается
 * переводом строки, а вставка идёт в конец, перевод добавляется ПЕРЕД нашим куском — иначе
 * наша первая строка слиплась бы с чужой последней.
 */
export function spliceLines(buf, at, rows, eol) {
  if (!rows.length) return buf;
  const body = `${rows.join(eol)}${eol}`;
  const needsLead = at === buf.length && buf.length > 0 && buf[buf.length - 1] !== LF;
  const chunk = Buffer.from(needsLead ? `${eol}${body}` : body, 'utf8');
  return Buffer.concat([buf.slice(0, at), chunk, buf.slice(at)]);
}
