#!/usr/bin/env node
/**
 * Обновление МЕХАНИЗМА Claude Agent Kit в проекте до версии из мастер-копии.
 *
 *   node .claude/hooks/update.mjs --plan     показать, что обновится/добавится/устареет
 *   node .claude/hooks/update.mjs --apply [--overwrite-modified] [--remove-stale]
 *
 * Отличие от install: install только ДОБАВЛЯЕТ недостающее и никогда не трогает существующее.
 * update умеет ОБНОВЛЯТЬ механизм (агенты, хуки, команды, промт, ассеты), но бережёт:
 *   — живые файлы (settings.json, PROJECT_PROFILE.md, artifacts/*, история) — не трогает вовсе;
 *   — файлы, которые вы правили (хеш разошёлся с зафиксированным в манифесте) — по умолчанию
 *     НЕ перезаписывает, помечает как «ваши правки»; перезапись — только с --overwrite-modified.
 *
 * Как отличаем «старую сток-версию» от «ваших правок»: по манифесту .cckit-manifest.json.
 * Если файл сейчас в точности такой, каким его зафиксировал манифест при установке, — это сток,
 * его безопасно обновить. Если содержимое разошлось с манифестом (или манифеста нет) — считаем
 * это вашей правкой и спрашиваем. Так проектные агенты (заточенные под ваш проект) не затираются.
 *
 * Источник — мастер ~/.claude/agent-kit (обновляется установщиком кита).
 * Ничего, кроме файлов .claude/ этого проекта, не меняет и не падает с ошибкой.
 */

import { readFileSync, existsSync, statSync, readdirSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // .claude проекта
const PROJECT_ROOT = path.resolve(KIT_DIR, '..');
const MASTER = path.join(os.homedir(), '.claude', 'agent-kit');
const MANIFEST = path.join(KIT_DIR, '.cckit-manifest.json');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const APPLY = has('--apply');
const OVERWRITE_MODIFIED = has('--overwrite-modified');
const REMOVE_STALE = has('--remove-stale');

const out = (s = '') => process.stdout.write(s + '\n');
const done = (m) => { if (m) out(m); process.exit(0); };
const toPosix = (p) => p.replace(/\\/g, '/');

if (!existsSync(MASTER)) {
  done('Мастер-копия ~/.claude/agent-kit не найдена. Обнови кит установщиком (install.bat / install.sh), затем повтори.');
}
if (!existsSync(path.join(KIT_DIR, 'agents')) && !existsSync(path.join(KIT_DIR, 'commands'))) {
  done('В этом проекте кит не установлен — обновлять нечего. Разверни: /cckit_install.');
}

// Живые файлы — их update не трогает (кроме «донести, если отсутствует»).
function isLiving(rel) {
  if (rel === 'artifacts/history' || rel.startsWith('artifacts/history/')) return true;
  const mutable = new Set([
    'settings.json', 'settings.local.json',
    'PROJECT_PROFILE.md', 'PROJECT_PROFILE.template.md',
    '.init-mode', '.cckit-manifest.json',
  ]);
  if (mutable.has(rel)) return true;
  if (rel.startsWith('artifacts/')) return true;
  if (rel === 'explores' || rel.startsWith('explores/')) return true; // кэш разведок — наработка проекта
  if (rel === 'map.html' || rel === 'guide.html') return true;         // собранные страницы, а не механизм
  return false;
}
// Никогда не едет из мастера в проект.
const NEVER_SHIP = new Set(['settings.local.json', 'CLAUDE.md', 'PROJECT_PROFILE.template.md', '.cckit-manifest.json']);

const sha = (file) => { try { return 'sha256:' + createHash('sha256').update(readFileSync(file)).digest('hex'); } catch { return ''; } };
const firstLine = (file) => { try { return (readFileSync(file, 'utf8').split('\n')[0] || '').trim(); } catch { return ''; } };

// Хеши из манифеста: путь-с-.claude/ -> hash
let manifestHashes = null;
if (existsSync(MANIFEST)) {
  try {
    const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    manifestHashes = new Map();
    for (const e of (m.entries || [])) if (e && e.hash) manifestHashes.set(e.path, e.hash);
  } catch { manifestHashes = null; }
}

// Перечисляем файлы мастера (то, что кит может нести в проект).
const masterFiles = [];
(function walk(dir) {
  let names; try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    const abs = path.join(dir, n);
    let st; try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) { walk(abs); continue; }
    const rel = toPosix(path.relative(MASTER, abs));
    if (NEVER_SHIP.has(rel)) continue;
    masterFiles.push(rel);
  }
})(MASTER);

const plan = { update: [], add: [], modified: [], living: [], uptodate: [], stale: [] };

for (const rel of masterFiles) {
  const projAbs = path.join(KIT_DIR, rel);
  const key = '.claude/' + rel;
  if (isLiving(rel)) {
    if (!existsSync(projAbs)) plan.add.push(rel);   // живого нет — донесём (новый шаблон/артефакт)
    else plan.living.push(rel);                      // живой есть — не трогаем
    continue;
  }
  if (!existsSync(projAbs)) { plan.add.push(rel); continue; }
  const ph = sha(projAbs);
  const mh = sha(path.join(MASTER, rel));
  if (ph && mh && ph === mh) { plan.uptodate.push(rel); continue; }
  const baseline = manifestHashes ? manifestHashes.get(key) : null;
  if (baseline && baseline === ph) plan.update.push(rel);   // текущее == зафиксированному стоку → обновляем
  else plan.modified.push(rel);                              // ваши правки или нет манифеста → спросим
}

// Устаревшее: значилось в манифесте как китовый файл, но в новом мастере его больше нет.
if (manifestHashes) {
  const masterSet = new Set(masterFiles.map((r) => '.claude/' + r));
  for (const key of manifestHashes.keys()) {
    if (!masterSet.has(key) && existsSync(path.join(PROJECT_ROOT, key))) {
      plan.stale.push(key.replace(/^\.claude\//, ''));
    }
  }
}

for (const k of Object.keys(plan)) plan[k].sort();

const pv = firstLine(path.join(KIT_DIR, 'VERSION')) || '—';
const mv = firstLine(path.join(MASTER, 'VERSION')) || '—';

out('Claude Agent Kit — обновление механизма в проекте');
out(`Проект: ${PROJECT_ROOT}`);
out(`Версия: в проекте ${pv} -> в мастере ${mv}`);
if (!manifestHashes) out('Манифеста в проекте нет — расхождения не с чем сверить, спорные файлы попадут в «ваши правки» (безопасно).');
out('');

const listing = (label, arr) => { out(`${label} (${arr.length}):`); for (const r of arr) out(`   • ${r}`); };

// ---------- Сухой план ----------
if (!APPLY) {
  // Печатаем не только числа, но и имена: применение выведет ровно этот же список теми же
  // словами, и человек сможет сверить построчно, а не гадать, что стоит за цифрой.
  out(`Обновится (устаревший сток-механизм): ${plan.update.length}`);
  for (const rel of plan.update) out(`   • ${rel}`);
  out(`Добавится нового: ${plan.add.length}`);
  for (const rel of plan.add) out(`   • ${rel}`);
  out(`Итого будет записано файлов: ${plan.update.length + plan.add.length}`);
  out(`Уже актуально: ${plan.uptodate.length}`);
  out(`Живые файлы не трогаю: ${plan.living.length}`);
  if (plan.modified.length) { out(''); listing('Вы правили (по умолчанию СОХРАНЯЮ, обновить — только по вашему согласию)', plan.modified); }
  if (plan.stale.length) { out(''); listing('Устарели (нет в текущем ките, можно удалить)', plan.stale); }
  out('');
  out('Это предпросмотр — ничего не изменено.');
  out('Применить обновление: --apply  (перезаписать ваши правки: добавь --overwrite-modified; убрать устаревшее: --remove-stale)');
  done();
}

// ---------- Применение ----------
function bring(rel) {
  const from = path.join(MASTER, rel);
  const to = path.join(KIT_DIR, rel);
  try { mkdirSync(path.dirname(to), { recursive: true }); copyFileSync(from, to); return true; }
  catch (e) { out(`   ! не удалось записать ${rel}: ${e.message}`); return false; }
}

let updated = 0, added = 0, overwritten = 0, removed = 0;
for (const rel of plan.update) if (bring(rel)) updated++;
for (const rel of plan.add) if (bring(rel)) added++;
if (OVERWRITE_MODIFIED) for (const rel of plan.modified) if (bring(rel)) overwritten++;
if (REMOVE_STALE) {
  for (const rel of plan.stale) {
    try { rmSync(path.join(KIT_DIR, rel), { force: true }); removed++; }
    catch (e) { out(`   ! не удалось удалить ${rel}: ${e.message}`); }
  }
}

// Предпросмотр и применение обязаны говорить ОДНИМИ И ТЕМИ ЖЕ словами и печатать одни и те же
// имена файлов. Иначе человек сравнивает «обновится 4» с «обновлено 4, добавлено 2», видит
// расхождение там, где его нет, и перестаёт верить сухому прогону — а предпросмотр, которому
// нельзя верить, хуже отсутствующего.
out('');
out(`Обновлено (устаревший сток-механизм): ${updated}`);
for (const rel of plan.update) out(`   • ${rel}`);
out(`Добавлено нового: ${added}`);
for (const rel of plan.add) out(`   • ${rel}`);
out(`Итого записано файлов: ${updated + added + overwritten}`);
out('');
out('Числа не сошлись с предпросмотром? Значит между прогонами изменилась мастер-копия');
out('или сами файлы проекта — повтори --plan и сверься заново.');
out('');
if (OVERWRITE_MODIFIED) out(`Перезаписаны ваши правки: ${overwritten}.`);
else if (plan.modified.length) out(`Сохранены ваши правки: ${plan.modified.length} (обновить их — повтори с --overwrite-modified).`);
if (REMOVE_STALE) out(`Удалено устаревших: ${removed}.`);
else if (plan.stale.length) out(`Оставлены устаревшие: ${plan.stale.length} (убрать — повтори с --remove-stale).`);
out('');
out('Дальше: обнови реестр — node .claude/hooks/write-manifest.mjs — и полностью перезапусти Claude Code.');
out('');
// Версию печатает баннер при старте сессии. Обновление прошло в её середине, поэтому шапка
// и команды ещё какое-то время показывают прежнее число — файлы при этом уже новые.
// Без этой строки человек решает, что обновление не сработало, и запускает его снова.
out(`Версия в файлах уже новая (.claude/VERSION = ${firstLine(path.join(KIT_DIR, 'VERSION')) || mv}), но шапка сессии покажет её`);
out('только после ПОЛНОГО перезапуска Claude Code — перезагрузка окна редактора не считается.');
