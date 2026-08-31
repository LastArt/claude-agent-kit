#!/usr/bin/env node
/**
 * Сторож копии алгоритма отпечатка.
 *
 *   node pult/tools/fingerprint-parity.mjs
 *
 * Что делает. Читает оригинал `.claude/hooks/kit-fingerprint.mjs` КАК ТЕКСТ — не импортирует
 * и не запускает, — вырезает из него область от объявления набора пропускаемых имён
 * до конца объявления функции отпечатка. Из копии `pult/lib/fingerprint.mjs` берёт область
 * между маркерами `// >>> ORIGIN` и `// <<< ORIGIN`, выбрасывает строки с пометкой ограждения
 * и снимает префикс со строк-оригиналов. Сравнивает построчно.
 *
 * Зачем. Число демона и число, которое печатает приветствие набора, сравнивает человек.
 * Разойдётся алгоритм — сравнивать станет нечего, и произойдёт это молча.
 *
 * КАНАРЕЙКА НА ОГРАЖДЕНИЯ. Константа `EXPECTED_GUARDS` — ожидаемое число пометок
 * `// pult:guard` внутри области. Их девять: шесть ограждений, заведённых поверх оригинала,
 * плюс три собственных `catch` оригинала (несостоявшийся `lstat`, неперечислимый каталог,
 * нечитаемый файл), которые в оригинале молча теряют путь, а в копии взводят признак усечения.
 * Пометок меньше — ограждение пропало. Пометок БОЛЬШЕ — тоже отказ: строки с пометкой сверка
 * выбрасывает, поэтому лишняя пометка есть готовый способ спрятать расхождение. Константа
 * поднимается осознанно, вместе с новым ограждением и записью о нём в шапке копии.
 *
 * ЧЕГО ЭТОТ ИНСТРУМЕНТ НЕ ДЕЛАЕТ. Он считает пометки, а не проверяет их смысл. Ограждение,
 * ослабленное внутри — скажем, проверка вложенности, которая всегда возвращает истину, —
 * пройдёт и сверку, и канарейку. Это известная граница: ограждения держатся канарейкой
 * и глазами человека.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PULT_DIR = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(PULT_DIR, '..');

const ORIGIN_FILE = path.join(REPO_ROOT, '.claude', 'hooks', 'kit-fingerprint.mjs');
const COPY_FILE = path.join(PULT_DIR, 'lib', 'fingerprint.mjs');

// Девять — не «примерно девять». Перечень ограждений с причинами живёт в шапке копии.
const EXPECTED_GUARDS = 9;

const GUARD = '// pult:guard';
const ORIGINAL_PREFIX = '//= ';
const OPEN = '// >>> ORIGIN';
const CLOSE = '// <<< ORIGIN';

const out = (s = '') => process.stdout.write(`${s}\n`);
const err = (s = '') => process.stderr.write(`${s}\n`);

/** Область оригинала: от набора пропускаемых имён до закрывающей скобки функции отпечатка. */
function originRegion(lines) {
  const start = lines.findIndex((l) => l.startsWith('const SKIP = new Set(['));
  if (start < 0) return null;
  const fp = lines.findIndex((l) => l.startsWith('export function fingerprint('));
  if (fp < 0) return null;
  let end = -1;
  for (let i = fp; i < lines.length; i += 1) {
    if (lines[i] === '}') { end = i; break; }
  }
  if (end < 0) return null;
  return lines.slice(start, end + 1);
}

/** Область копии между маркерами. */
function copyRegion(lines) {
  const start = lines.findIndex((l) => l.trim().startsWith(OPEN));
  const end = lines.findIndex((l) => l.trim().startsWith(CLOSE));
  if (start < 0 || end < 0 || end < start) return null;
  return lines.slice(start + 1, end);
}

/**
 * Копия — обратно в оригинал: строки с пометкой выбрасываются, строки-оригиналы теряют
 * префикс. Заодно считаются пометки и проверяется парность.
 */
function restore(region) {
  const restored = [];
  const problems = [];
  let guards = 0;
  for (let i = 0; i < region.length; i += 1) {
    const line = region[i];
    if (line.endsWith(GUARD)) {
      guards += 1;
      const next = region[i + 1];
      if (next === undefined || next.indexOf(ORIGINAL_PREFIX) < 0) {
        problems.push(`строка ${i + 1}: пометка ограждения без парной строки «${ORIGINAL_PREFIX}<оригинал>»`);
      }
      continue;
    }
    const at = line.indexOf(ORIGINAL_PREFIX);
    if (at >= 0 && (i === 0 || region[i - 1].endsWith(GUARD))) {
      restored.push(line.slice(at + ORIGINAL_PREFIX.length));
      continue;
    }
    if (at >= 0) {
      problems.push(`строка ${i + 1}: строка-оригинал не следует за пометкой ограждения`);
      continue;
    }
    restored.push(line);
  }
  return { restored, guards, problems };
}

async function main() {
  let originText;
  let copyText;
  try {
    originText = await readFile(ORIGIN_FILE, 'utf8');
  } catch {
    err(`[pult] не прочитал оригинал: ${path.relative(REPO_ROOT, ORIGIN_FILE)}`);
    return 1;
  }
  try {
    copyText = await readFile(COPY_FILE, 'utf8');
  } catch {
    err(`[pult] не прочитал копию: ${path.relative(REPO_ROOT, COPY_FILE)}`);
    return 1;
  }

  const origin = originRegion(originText.split(/\r?\n/));
  if (!origin) {
    err('[pult] в оригинале не нашлась область алгоритма: сместились опорные строки');
    return 1;
  }
  const copy = copyRegion(copyText.split(/\r?\n/));
  if (!copy) {
    err('[pult] в копии не нашлись маркеры области ORIGIN');
    return 1;
  }

  const { restored, guards, problems } = restore(copy);

  let bad = false;
  for (const p of problems) {
    err(`[pult] ${p}`);
    bad = true;
  }

  if (guards < EXPECTED_GUARDS) {
    err(`[pult] ограждение пропало: пометок ${guards}, ожидается ${EXPECTED_GUARDS}`);
    bad = true;
  } else if (guards > EXPECTED_GUARDS) {
    err(`[pult] пометок ${guards}, ожидается ${EXPECTED_GUARDS}: поднимите EXPECTED_GUARDS осознанно —`);
    err('       строки с пометкой сверка выбрасывает, поэтому лишняя пометка прячет расхождение');
    bad = true;
  }

  const n = Math.max(origin.length, restored.length);
  let diffs = 0;
  for (let i = 0; i < n; i += 1) {
    if (origin[i] === restored[i]) continue;
    diffs += 1;
    if (diffs === 1) err('[pult] алгоритм разошёлся с оригиналом:');
    err(`  строка ${i + 1}`);
    err(`    оригинал: ${origin[i] === undefined ? '(строки нет)' : origin[i]}`);
    err(`    копия   : ${restored[i] === undefined ? '(строки нет)' : restored[i]}`);
    if (diffs >= 10) { err('  …и дальше; остальное не печатаю'); break; }
  }
  if (diffs) bad = true;

  if (bad) return 1;

  out(`алгоритм совпадает: ${origin.length} строк, ограждений ${guards}`);
  // Абсолютный путь Windows импортируется только как file:// — иначе буква диска
  // читается как схема адреса.
  const { scan } = await import(pathToFileURL(COPY_FILE).href);
  const r = scan(path.join(REPO_ROOT, '.claude'), {});
  out(`отпечаток по копии: ${r.value === null ? 'не посчитан' : r.value}${r.truncated ? ' (обход усечён)' : ''}`);
  out('сверьте его глазами с хвостом строки `node .claude/hooks/banner.mjs --compact`');
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  err(`[pult] сторож не отработал: ${(e && (e.code || e.name)) || 'ошибка'}`);
  process.exit(1);
});
