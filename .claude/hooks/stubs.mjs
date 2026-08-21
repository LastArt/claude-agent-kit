#!/usr/bin/env node
/**
 * Раскладывает заглушки рабочих файлов из assets/stubs по их местам.
 *
 *   node .claude/hooks/stubs.mjs           разложить недостающее, существующее не трогать
 *   node .claude/hooks/stubs.mjs --force   перезаписать, даже если файл уже на месте
 *   node .claude/hooks/stubs.mjs --dry     показать, что было бы сделано
 *
 * Зачем. PLAN.md, REVIEW.md, SECURITY.md и кэш разведок — рабочие файлы: в них лежит текущая
 * задача, а не пустая форма. Поэтому в исходниках набора их нет вовсе (иначе чужая задача
 * уезжала бы в каждый новый проект), а эталонные заглушки живут в assets/stubs. Этот хук
 * их материализует: установщик зовёт его для мастер-копии, разработчик набора — для себя
 * после свежего клона.
 *
 * Ничего, кроме перечисленных файлов, не трогает и не падает: нет заглушек — скажет и выйдет
 * с нулём.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STUBS = path.join(KIT, 'assets', 'stubs');
const FORCE = process.argv.includes('--force');
const DRY = process.argv.includes('--dry');
const out = (s) => process.stdout.write(s + '\n');

// Имя заглушки в assets/stubs -> куда она ложится внутри .claude
const PLACES = [
  ['PLAN.md', 'artifacts/PLAN.md'],
  ['REVIEW.md', 'artifacts/REVIEW.md'],
  ['SECURITY.md', 'artifacts/SECURITY.md'],
  ['FAQ_TEMPLATE.md', 'artifacts/FAQ_TEMPLATE.md'],
  ['explores-INDEX.md', 'explores/INDEX.md'],
];

if (!existsSync(STUBS)) {
  out('[stubs] нет assets/stubs — раскладывать нечего.');
  process.exit(0);
}

let placed = 0, kept = 0, missing = 0;
for (const [stub, target] of PLACES) {
  const from = path.join(STUBS, stub);
  const to = path.join(KIT, target);
  if (!existsSync(from)) {
    out(`[stubs] нет заглушки ${stub} — пропускаю`);
    missing++;
    continue;
  }
  if (existsSync(to) && !FORCE) { kept++; continue; }
  if (DRY) { out(`[stubs] положил бы ${target}`); placed++; continue; }
  try {
    mkdirSync(path.dirname(to), { recursive: true });
    writeFileSync(to, readFileSync(from));
    placed++;
  } catch (err) {
    out(`[stubs] не смог положить ${target}: ${err.message}`);
  }
}

out(`[stubs] разложено: ${placed}`
  + (kept ? `, оставлено как есть: ${kept}` : '')
  + (missing ? `, заглушек не найдено: ${missing}` : ''));
