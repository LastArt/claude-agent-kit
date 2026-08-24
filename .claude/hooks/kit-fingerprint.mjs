#!/usr/bin/env node
/**
 * Отпечаток набора — короткий хеш от СОСТАВА и содержимого стокового механизма.
 *
 * Зачем. Номер версии поднимают не на каждую правку, и этого достаточно, чтобы «1.8.0»
 * в мастер-копии и «1.8.0» в проекте оказались разными наборами файлов. Сравнить их можно
 * было только вручную, по размерам и датам. Отпечаток отвечает на этот вопрос сразу:
 * совпал — наборы идентичны, разошёлся — что-то ехало мимо номера версии.
 *
 * Состав берётся из `ship.list`, а НЕ обходом папки. Обход считал бы и рабочие файлы —
 * план, кэш разведок, собранные страницы, — и отпечаток менялся бы на каждом шаге работы:
 * вторая болезнь вместо лечения первой. Живые файлы исключены по той же причине:
 * `settings.json` и профиль правит человек, к составу механизма это отношения не имеет.
 *
 * Общий модуль, а не копия в каждом хуке: три места (реестр, баннер, обновление) обязаны
 * считать одинаково, иначе сравнивать будет нечего.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const SKIP = new Set([
  'settings.json', 'settings.local.json',
  'PROJECT_PROFILE.md', 'PROJECT_PROFILE.template.md',
  'guide.html', 'map.html', '.cckit-manifest.json', '.init-mode',
]);

/** Пути из ship.list (без комментариев и пустых строк). null — списка нет. */
export function shipEntries(kitDir) {
  const list = path.join(kitDir, 'ship.list');
  if (!existsSync(list)) return null;
  const out = [];
  for (const raw of readFileSync(list, 'utf8').split(/\r?\n/)) {
    const entry = raw.split('#')[0].trim();
    if (entry) out.push(entry);
  }
  return out;
}

/** Шесть символов sha256 от отсортированных пар «путь + хеш». null — считать не из чего. */
export function fingerprint(kitDir) {
  const list = shipEntries(kitDir);
  if (!list) return null;
  const files = [];
  const add = (rel) => {
    if (SKIP.has(rel)) return;
    const abs = path.join(kitDir, rel);
    let st;
    try { st = statSync(abs); } catch { return; }
    if (st.isDirectory()) {
      let names;
      try { names = readdirSync(abs); } catch { return; }
      for (const n of names.sort()) add(rel + '/' + n);
      return;
    }
    try {
      files.push(rel + '\t' + createHash('sha256').update(readFileSync(abs)).digest('hex'));
    } catch { /* нечитаемый файл в отпечаток не попадёт */ }
  };
  for (const entry of list) add(entry.replace(/\/$/, ''));
  if (!files.length) return null;
  files.sort();
  return createHash('sha256').update(files.join('\n'), 'utf8').digest('hex').slice(0, 6);
}
