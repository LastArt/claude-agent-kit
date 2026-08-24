#!/usr/bin/env node
/**
 * Пишет реестр установленных китом файлов в .claude/.cckit-manifest.json.
 *
 *   node .claude/hooks/write-manifest.mjs
 *
 * Зачем: по этому реестру команда /cckit_uninstall удаляет РОВНО то, что кит сам создал,
 * и не трогает чужое. Запускается в конце разворачивания (/cckit_new-project, /cckit_install)
 * и при желании вручную, чтобы обновить реестр.
 *
 * Что кладём в реестр по каждому файлу:
 *   path   — путь от корня проекта (например ".claude/agents/explorer.md");
 *   group  — "service" (механизм кита) или "memory" (архив прошлых задач в artifacts/history);
 *   hash   — sha256 содержимого. ТОЛЬКО у статичных файлов кита (агенты, хуки, команды, ассеты,
 *            промт оркестратора). Живые файлы (settings.json, профиль, PLAN/REVIEW, кэш разведок
 *            в explores/) не хешируем: они законно меняются, совпадение всё равно ничего
 *            не значило бы.
 *
 * Что НЕ попадает в реестр (значит — не будет удалено при деинсталляции):
 *   — любой файл, которого нет в мастер-копии кита (~/.claude/agent-kit): чужое добро,
 *     случайно лежащее в .claude/, кит своим не считает и не трогает;
 *   — файлы за пределами .claude/ (IDEA.md, CLAUDE.md, код проекта) — они вне зоны кита.
 *
 * Скрипт ничего, кроме манифеста, не меняет и не падает: не смог — скажет и выйдет с нулём.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint } from './kit-fingerprint.mjs';

const KIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // .../.claude
const PROJECT_ROOT = path.resolve(KIT_DIR, '..');
const MANIFEST = path.join(KIT_DIR, '.cckit-manifest.json');

// Мастер-копия на этой машине. Если она есть — файл считается «китовым» только тогда, когда
// такой же путь есть в мастере. Это защищает чужие файлы в существующем проекте (additive-режим
// /cckit_install): их имён в мастере нет, и в реестр они не попадут.
const MASTER = path.join(os.homedir(), '.claude', 'agent-kit');
const MASTER_OK = existsSync(MASTER);
const masterHas = (rel) => existsSync(path.join(MASTER, rel));

const toPosix = (p) => p.replace(/\\/g, '/');
const kitRel = (abs) => toPosix(path.relative(KIT_DIR, abs));      // "agents/explorer.md"
const projRel = (abs) => toPosix(path.relative(PROJECT_ROOT, abs)); // ".claude/agents/explorer.md"

// Файлы, которые кит порождает уже ПОСЛЕ установки (их нет в мастере, но они наши).
const alwaysOurs = (rel) =>
  rel === '.cckit-manifest.json' ||
  rel === 'artifacts/history' || rel.startsWith('artifacts/history/') ||
  rel.startsWith('artifacts/') || // PLAN/REVIEW/ROADMAP/FAQ_TEMPLATE и снимки задач
  rel === 'explores' || rel.startsWith('explores/') || // кэш разведок модулей
  rel === 'map.html'; // карта проекта, собирается хуком уже после установки

function owned(rel) {
  if (alwaysOurs(rel)) return true;
  if (!MASTER_OK) return true;   // мастер недоступен (кит просто распакован) — тогда весь .claude наш
  return masterHas(rel);
}

// group + нужно ли хешировать
function classify(rel) {
  if (rel === 'artifacts/history' || rel.startsWith('artifacts/history/')) return { group: 'memory', hashed: false };
  const mutable = new Set([
    'settings.json', 'settings.local.json',
    'PROJECT_PROFILE.md', 'PROJECT_PROFILE.template.md',
    '.init-mode', '.cckit-manifest.json',
  ]);
  if (mutable.has(rel)) return { group: 'service', hashed: false };
  if (rel.startsWith('artifacts/')) return { group: 'service', hashed: false }; // живые артефакты
  if (rel === 'explores' || rel.startsWith('explores/')) return { group: 'service', hashed: false }; // кэш разведок
  if (rel === 'map.html' || rel === 'guide.html') return { group: 'service', hashed: false };        // собранные страницы
  return { group: 'service', hashed: true };                                     // механизм кита
}

const entries = [];
function walk(dir) {
  let names;
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    const abs = path.join(dir, name);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) { walk(abs); continue; }
    const rel = kitRel(abs);
    if (rel === '.cckit-manifest.json') continue;   // добавим отдельно: сейчас пишем его же
    if (!owned(rel)) continue;                       // чужое — не наше дело
    const { group, hashed } = classify(rel);
    const entry = { path: projRel(abs), group };
    if (hashed) {
      try { entry.hash = 'sha256:' + createHash('sha256').update(readFileSync(abs)).digest('hex'); }
      catch { /* не смогли прочитать — оставим без хеша, удалится как обычный файл */ }
    }
    entries.push(entry);
  }
}
walk(KIT_DIR);

// Папка памяти наполняется уже после установки (архив задач). Сейчас пуста или отсутствует —
// фиксируем как каталог, чтобы режим полного удаления знал про неё.
const HIST = '.claude/artifacts/history';
if (!entries.some((e) => e.path === HIST)) entries.push({ path: HIST, group: 'memory', dir: true });

// Кэш разведок тоже наполняется после установки (файл на модуль). Фиксируем каталогом, чтобы
// снятие кита убирало и разведки, появившиеся позже.
const EXPL = '.claude/explores';
if (!entries.some((e) => e.path === EXPL)) entries.push({ path: EXPL, group: 'service', dir: true });

// Собранные страницы (карта проекта, инструкция) рождаются хуками уже после установки, поэтому
// на момент записи реестра их обычно ещё нет. Заявляем их заранее: появятся — снимутся вместе
// с китом, не появятся — деинсталляция молча пропустит несуществующее.
for (const page of ['.claude/map.html', '.claude/guide.html']) {
  if (!entries.some((e) => e.path === page)) entries.push({ path: page, group: 'service' });
}

// Файлы машинной приёмки рождаются после первого прогона, то есть почти всегда позже реестра.
// Заявляем их заранее по той же причине, что и страницы выше: иначе они переживут
// /cckit_uninstall и не дадут снять папку .claude/.
for (const f of ['.claude/artifacts/VERIFY.json', '.claude/artifacts/VERIFY.lock', '.claude/artifacts/GATE_STATE.json']) {
  if (!entries.some((e) => e.path === f)) entries.push({ path: f, group: 'service' });
}

// Сам манифест — служебный, уезжает вместе с китом.
entries.push({ path: '.claude/.cckit-manifest.json', group: 'service' });

entries.sort((a, b) => a.path.localeCompare(b.path));

let version = 'unknown';
try { version = (readFileSync(path.join(KIT_DIR, 'VERSION'), 'utf8').split('\n')[0] || '').trim() || 'unknown'; } catch { /* нет файла */ }

let created = '';
try { created = new Date().toISOString().slice(0, 10); } catch { /* без даты */ }

const fp = fingerprint(KIT_DIR);

const manifest = {
  kit: 'claude-agent-kit',
  version,
  // Отпечаток состава: по нему видно, что «одинаковая версия» — действительно один и тот же
  // набор файлов. Номер поднимают не на каждую правку, и этого хватает, чтобы мастер-копия
  // и проект разошлись при совпадающих числах — ровно та болезнь, которую он и лечит.
  fingerprint: fp,
  created,
  root: '.claude',
  note: 'Реестр файлов, которые Claude Agent Kit создал в этом проекте. По нему /cckit_uninstall '
    + 'удаляет ровно своё и не трогает чужое. Не редактируйте вручную — перезаписывается китом.',
  entries,
};

try {
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  const hashed = entries.filter((e) => e.hash).length;
  process.stdout.write(`Манифест обновлён: ${entries.length} записей (${hashed} с контролем целостности), версия ${version}${fp ? ' · ' + fp : ''}.\n`);
} catch (err) {
  process.stdout.write(`Не удалось записать манифест: ${err.message}. Деинсталляция по реестру будет недоступна.\n`);
}
