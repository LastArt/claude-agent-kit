#!/usr/bin/env node
/**
 * Удаление Claude Agent Kit из ПРОЕКТА по реестру .claude/.cckit-manifest.json.
 *
 *   node .claude/hooks/uninstall.mjs --plan  --mode service   показать, что удалит режим «служебное»
 *   node .claude/hooks/uninstall.mjs --plan  --mode all       показать, что удалит режим «всё с памятью»
 *   node .claude/hooks/uninstall.mjs --apply --mode <service|all> [--keep-modified]
 *
 * Режимы:
 *   service — снять только механизм кита (агенты, хуки, команды, промт, настройки).
 *             Память (архив прошлых задач в artifacts/history) ОСТАЁТСЯ — вернётесь, история цела.
 *   all     — снять всё, включая память.
 *
 * Безопасность («добрый гость»):
 *   — удаляет ТОЛЬКО пути из реестра; чего в реестре нет — не трогает никогда;
 *   — не выходит за пределы .claude/: корневые IDEA.md, CLAUDE.md и код проекта в стороне;
 *   — статичные файлы с несовпавшим хешем (вы их правили) по умолчанию НЕ удаляет —
 *     помечает как «изменён вами»; удалить их можно только явным --apply без --keep-modified,
 *     и команда /cckit_uninstall спрашивает про них отдельно;
 *   — опустевшие каталоги кита убирает, каталоги с чужими файлами внутри — оставляет;
 *   — без --apply не удаляет НИЧЕГО (по умолчанию это сухой прогон).
 *
 * Никогда не падает с ошибкой: не смог — сообщит и выйдет с нулём.
 */

import { readFileSync, existsSync, statSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // .../.claude
const PROJECT_ROOT = path.resolve(KIT_DIR, '..');
const MANIFEST = path.join(KIT_DIR, '.cckit-manifest.json');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const MODE = (argv[argv.indexOf('--mode') + 1] || '').toLowerCase() === 'all' ? 'all' : 'service';
const APPLY = has('--apply');
const KEEP_MODIFIED = has('--keep-modified');

const out = (s = '') => process.stdout.write(s + '\n');
const done = (msg) => { if (msg) out(msg); process.exit(0); };

if (!existsSync(MANIFEST)) {
  done('Реестр .claude/.cckit-manifest.json не найден — не могу надёжно определить, что принадлежит киту. '
    + 'Ничего не удалено. Пересоздать реестр: node .claude/hooks/write-manifest.mjs');
}

let manifest;
try { manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')); }
catch { done('Реестр повреждён (не читается как JSON). Ничего не удалено — разберите вручную.'); }

const entries = Array.isArray(manifest.entries) ? manifest.entries : [];

// Резолвим путь из реестра и убеждаемся, что он ВНУТРИ .claude/. Всё, что вне — игнор.
function resolveInside(rel) {
  const abs = path.resolve(PROJECT_ROOT, rel);
  const r = path.relative(KIT_DIR, abs);
  const inside = r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
  return inside ? abs : null;
}

const inScope = (e) => (MODE === 'all' ? true : e.group !== 'memory');

const remove = [];   // будет удалено
const modified = []; // статичные, изменённые пользователем — по умолчанию сохраняются
const missing = [];  // в реестре есть, на диске уже нет
const kept = [];     // осознанно оставлено (память в режиме service)

for (const e of entries) {
  if (!e || typeof e.path !== 'string') continue;
  const abs = resolveInside(e.path);
  if (!abs) continue;                                  // защита от выхода за .claude/
  if (!inScope(e)) { kept.push(e.path); continue; }
  if (!existsSync(abs)) { missing.push(e.path); continue; }
  if (e.dir) { remove.push({ ...e, abs }); continue; }
  if (e.hash) {
    let cur = '';
    try { cur = 'sha256:' + createHash('sha256').update(readFileSync(abs)).digest('hex'); } catch { /* прочитать не смогли */ }
    if (cur && cur !== e.hash) { modified.push({ ...e, abs }); continue; }
  }
  remove.push({ ...e, abs });
}

const modeLabel = MODE === 'all'
  ? 'ВСЁ, включая память (архив прошлых задач)'
  : 'только служебные файлы (память в artifacts/history сохраняется)';

out(`Claude Agent Kit — удаление из проекта`);
out(`Проект:  ${PROJECT_ROOT}`);
out(`Версия кита: ${manifest.version || '—'} · установлен: ${manifest.created || '—'}`);
out(`Режим:   ${modeLabel}`);
out('');

// -------- Сухой прогон --------
if (!APPLY) {
  out(`Будет удалено файлов/папок: ${remove.length}`);
  if (modified.length) {
    out('');
    out(`⚠ Вы правили эти служебные файлы (${modified.length}) — по умолчанию они СОХРАНЯЮТСЯ:`);
    for (const e of modified) out(`   • ${e.path}`);
    out('   Удалить и их — подтвердите отдельно (флаг --apply без --keep-modified).');
  }
  if (MODE === 'service' && kept.length) {
    out('');
    out(`Память сохраняется (${kept.length} записей в artifacts/history) — снять её можно режимом «всё».`);
  }
  if (missing.length) {
    out('');
    out(`Уже отсутствуют (пропущу): ${missing.length}.`);
  }
  out('');
  out('Это предпросмотр — ничего не удалено. Выполнить: добавьте --apply.');
  done();
}

// -------- Реальное удаление --------
const toDelete = KEEP_MODIFIED ? remove : [...remove, ...modified];
let ok = 0;
const failed = [];
for (const e of toDelete) {
  try { rmSync(e.abs, { recursive: !!e.dir, force: true }); ok++; }
  catch (err) { failed.push(`${e.path}: ${err.message}`); }
}

// Убрать опустевшие каталоги кита. Каталог с чужими файлами внутри останется — это и есть
// «добрый гость»: удаляем только то, что сами принесли.
function pruneEmpty(dir) {
  if (!existsSync(dir)) return;
  let names;
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    const p = path.join(dir, name);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) pruneEmpty(p);
  }
  // recursive обязателен: без него rmSync на каталоге падает с ERR_FS_EISDIR даже при force.
  // Каталог здесь уже проверен как пустой, так что рекурсия ничего лишнего не унесёт.
  try { if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true }); } catch { /* не пусто или нельзя */ }
}
pruneEmpty(KIT_DIR);

const kitGone = !existsSync(KIT_DIR);
let leftovers = [];
if (!kitGone) { try { leftovers = readdirSync(KIT_DIR); } catch { /* */ } }

out(`Удалено: ${ok}.`);
if (KEEP_MODIFIED && modified.length) out(`Сохранены изменённые вами файлы: ${modified.length}.`);
if (MODE === 'service' && kept.length) out(`Память сохранена: ${kept.length} записей в artifacts/history.`);
if (failed.length) { out(`Не удалось удалить (${failed.length}):`); for (const f of failed) out(`   • ${f}`); }

if (kitGone) {
  out('Папка .claude/ удалена полностью — кита в проекте больше нет.');
} else {
  // Причин остаться две: мы сами что-то намеренно сберегли (память, правки) или внутри лежит чужое.
  // Раньше сообщение всегда валило это на «чужие файлы» — теперь называем настоящую причину.
  const mine = [];
  if (MODE === 'service' && kept.length) mine.push('память');
  if (KEEP_MODIFIED && modified.length) mine.push('ваши правки');
  const why = mine.length
    ? `в ней осталось сохранённое намеренно (${mine.join(' и ')}) и, возможно, чужие файлы`
    : 'в ней есть не принадлежащие киту файлы';
  out(`Папка .claude/ оставлена: ${why} (${leftovers.join(', ') || 'скрытые'}). Это не ошибка — кит не трогает лишнего.`);
}
out('');
out('Глобальная установка на машине (~/.claude/agent-kit и команды /cckit_* в других проектах) не затронута.');
out('Полностью перезапустите Claude Code, чтобы он забыл снятые команды.');
