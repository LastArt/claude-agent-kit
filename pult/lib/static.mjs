#!/usr/bin/env node
/**
 * Отдача страницы — ОТДЕЛЬНЫЙ путь ответа, а не ветка в общем.
 *
 * Причина не в удобстве. `send()` в `pult/server.mjs` жёстко ставит на КАЖДЫЙ ответ тип JSON
 * и политику `default-src 'none'`: для машинного ответа это правильно и трогать это нельзя,
 * а для страницы это значит «ничего не грузить и ничего не выполнять». Странице нужны свой
 * тип, свои скрипты, свои воркеры и схема `blob:` — и одновременно обязаны остаться
 * запрещающие директивы. Поэтому путей ответа два, и они не сливаются.
 *
 * КАТАЛОГ СТРАНИЦЫ СЧИТАЕТСЯ ОТ `import.meta.url`, а не от `process.cwd()`: демон обслуживает
 * много проектов и запускается откуда угодно, в том числе из корня чужого репозитория.
 *
 * ПОРЯДОК ЖЁСТКИЙ:
 *   1. относительный путь берётся из адреса и раскодируется под `try`; нулевой байт
 *      и управляющие символы — отказ без обращения к диску;
 *   2. `path.resolve` и проверка вложенности в каталог страницы (`inside()`);
 *   3. `lstat` — только обычный файл, иначе 404 (за симлинком не идём и здесь);
 *   4. расширение обязано найтись в ЗАКРЫТОМ словаре типов; чужое расширение — 404, а НЕ
 *      отдача октетным потоком: неизвестный тип на странице, за которой стоит терминал, —
 *      это способ протащить в браузер то, чего мы не разбирали;
 *   5. `realpath` и ПОВТОРНАЯ проверка вложенности: `lstat` отбивает симлинк только
 *      в последнем звене, а подкаталог-симлинк внутри `pult/web` увёл бы отдачу наружу;
 *   6. размер в пределах потолка, чтение байтами через примитив шлюза.
 *
 * ПРЯМОГО `node:fs` В ЭТОМ ФАЙЛЕ НЕТ — правило фазы 1 действует и здесь.
 *
 * ОБРАМЛЕНИЕ СТРАНИЦЫ ОТБИВАЕТСЯ ЗАГОЛОВКАМИ, а не заголовком `Sec-Fetch-Site`, который мы
 * сами объявили необязательным: иначе единственная защита от прозрачного слоя поверх
 * терминала держалась бы на том, чего может не быть. Отсюда `frame-ancestors 'none'`
 * в политике и `X-Frame-Options: DENY` рядом с ней.
 *
 * НИ ОДНОГО ЗАГОЛОВКА ОБЩЕГО ДОСТУПА МЕЖДУ ИСТОЧНИКАМИ здесь не выставляется.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inside, statSafe, isPlainFileStat, readBytesCapped, realPath } from './fs-safe.mjs';
import { STATIC_DIR, STATIC_TYPES, MAX_STATIC_FILE, CSP } from '../config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Абсолютный каталог страницы. Вычисляется один раз и от расположения кода. */
export const WEB_DIR = path.resolve(HERE, '..', STATIC_DIR);

/**
 * Путь адреса в относительный путь внутри каталога страницы.
 *
 * Возвращает `null` на всём, что не годится к обращению: чужая форма, битое процентное
 * кодирование, нулевой байт, управляющий символ. До диска такой запрос не доходит.
 */
function relFromPathname(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return null;
  const raw = pathname === '/' ? '/index.html' : pathname;
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  for (let k = 0; k < decoded.length; k += 1) {
    const code = decoded.charCodeAt(k);
    if (code < 0x20 || code === 0x7f) return null;
  }
  const rel = decoded.slice(1);
  return rel.length ? rel : null;
}

/**
 * Найти файл страницы. `{ok:true, path, type, document}` либо `{ok:false}`.
 *
 * Причины отказа наружу не различаются намеренно: снаружи это всё один 404, а разбирать
 * «почему не отдали» человек будет по коду, а не по ответу.
 */
export async function findStatic(pathname) {
  const rel = relFromPathname(pathname);
  if (rel === null) return { ok: false };

  const target = path.resolve(WEB_DIR, rel);
  if (!inside(WEB_DIR, target)) return { ok: false };

  const ext = path.extname(target).toLowerCase();
  const type = STATIC_TYPES[ext];
  if (!type) return { ok: false };

  const st = await statSafe(target);
  if (!st.ok || !isPlainFileStat(st.stat, target)) return { ok: false };

  // `lstat` отбивает симлинк только в ПОСЛЕДНЕМ звене: подкаталог-симлинк внутри `pult/web`
  // увёл бы отдачу наружу мимо проверки вложенности. Поэтому здесь тот же приём, что
  // в `resolveTarget()`: канонизация и ПОВТОРНАЯ проверка вложенности по вернувшемуся пути.
  // Асимметрия с шлюзом опаснее самой дыры — два соседних читателя с разным порядком проверок
  // при первой же правке сходятся по слабому.
  const rp = await realPath(target);
  if (!rp.ok || !inside(WEB_DIR, rp.path)) return { ok: false };

  return { ok: true, path: rp.path, type, document: ext === '.html' };
}

/**
 * Отдать файл страницы. Вернёт `true`, если ответ написан, и `false`, если файла нет, —
 * тогда общий 404 демона отвечает как обычно, одной формой на все маршруты.
 */
export async function serveStatic(res, pathname) {
  const found = await findStatic(pathname);
  if (!found.ok) return false;

  const read = await readBytesCapped(found.path, MAX_STATIC_FILE);
  if (!read.ok) return false;

  const headers = {
    'Content-Type': found.type,
    'Content-Length': read.buf.length,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    // ПОЛИТИКА СТАВИТСЯ НА ВСЕ ОТВЕТЫ СТАТИКИ, а не только на документ страницы. Причина:
    // `.svg` при прямом переходе — документ ТОГО ЖЕ происхождения, и скрипт внутри него
    // выполнится, а `nosniff` здесь не помогает. Шаг 18 привезёт в `pult/web` чужие сборки,
    // и лишняя строка заголовка дешевле разбора «почему у нас исполнился чужой SVG».
    'Content-Security-Policy': CSP,
  };
  if (found.document) {
    headers['X-Frame-Options'] = 'DENY';
  }
  res.writeHead(200, headers);
  res.end(read.buf);
  return true;
}
