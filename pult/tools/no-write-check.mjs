#!/usr/bin/env node
/**
 * Доказательство «демон не пишет в кит ни байта».
 *
 *   node pult/tools/no-write-check.mjs [число запросов]
 *
 * Один процесс делает всё и сам ничего не пишет на диск: снимок дерева кита держится
 * в памяти, файлов не создаётся ни одного.
 *
 * Как устроено: снимок всего дерева `.claude` КАЖДОГО проекта реестра (относительный путь —
 * метка изменения, размер, хеш содержимого), затем сотня запросов к демону (по умолчанию 100,
 * чередуя список и одиночные проекты по кругу), затем снимки повторяются и сравниваются.
 * Печатается список изменившихся, появившихся и пропавших путей; непустой список — код
 * возврата 1.
 *
 * Наблюдаются все записи реестра, а не первая: `/projects` сканирует их все, и прогон
 * по одному проекту доказывал бы меньше, чем обещает эта шапка. Потолок наблюдения тот же,
 * что у демона (`MAX_PROJECTS`), — дальше первых записей он и сам не читает.
 *
 * Запросы идут с корректным заголовком `Host` из белого списка — иначе демон ответит 403
 * и прогон не докажет ничего.
 *
 * ЗЕЛЁНЫЙ КОД ОБЕЩАЕТ РОВНО ТО, ЧТО ПРОВЕРЕНО. Усечение ЛЮБОГО из снимков (дерево крупнее
 * `MAX_SNAPSHOT_FILES`) даёт код 3 и слова «прогон ничего не доказывает», а не ноль:
 * «расхождений нет» по обрезанному дереву — это ложное зелёное, и оно хуже отсутствия
 * инструмента. Тем же кодом 3 кончается прогон, на котором демон не ответил ни разу.
 *
 * ЧЕСТНАЯ ОГОВОРКА ПЕРВАЯ. Снимок ловит не только демона: хуки набора пишут журнал событий
 * и состояние задачи параллельно, и в «изменившихся» окажется их работа, а не работа пульта.
 * Поэтому прогон делается в спокойном окне — ни агента, ни хуков в работе, — а инструмент
 * печатает ПУТИ, а не «да/нет»: расхождение разбирается глазами.
 *
 * ЧЕСТНАЯ ОГОВОРКА ВТОРАЯ: ЧТО ЭТОТ ПРОГОН НЕ УВИДИТ. Снимок берёт только обычные файлы,
 * поэтому созданный демоном КАТАЛОГ в него не попадёт вовсе. Не попадёт и НЕДОЛГОВЕЧНЫЙ файл —
 * лок или временный файл, созданный и удалённый между двумя снимками: следа он не оставит,
 * даже если между снимками существовал. Настоящее доказательство «в кит не пишется ни байта» —
 * разбор кода (все пишущие вызовы заперты в `mkdirSecure()` и `writeSecureAtomic()`
 * в `pult/lib/fs-safe.mjs`, а путь им даёт только `registryFile()`); этот прогон — подпорка
 * к разбору, а не замена ему.
 *
 * ГРАНИЦА ЭТОГО ДОКАЗАТЕЛЬСТВА С ФАЗЫ 2 — ГЛАВНОЕ, ЧТО НАДО ПРОЧИТАТЬ ПЕРЕД ТЕМ, КАК
 * СОСЛАТЬСЯ НА ЗЕЛЁНЫЙ КОД. Инструмент остаётся ВЕРНЫМ по своей узкой формулировке: в кит
 * не пишется ни байта, и снимок дерева `.claude` до и после серии запросов это по-прежнему
 * меряет. Но с фазы 2 он НЕДОСТАТОЧЕН, и разница не в аккуратности, а в предмете: на фазе 1
 * методов записи у демона не было вовсе, поэтому «в кит не пишем» и «никуда не пишем» были
 * одним утверждением; теперь у демона есть `POST /projects/:id/file`, он пишет в файлы
 * ЧУЖОГО ПРОЕКТА по замыслу, и про запись ЗА ПРЕДЕЛЫ выбранного файла — в соседний каталог
 * проекта, наружу проекта по симлинку, в `.git`, в файл под образцом секрета — этот прогон
 * не говорит НИЧЕГО: он туда просто не смотрит.
 *
 * ПОЛНОЕ ДОКАЗАТЕЛЬСТВО — `pult/tools/write-scope-check.mjs`: он снимает проект целиком,
 * гоняет сценарий сохранений (в том числе четыре, обязанные получить отказ, каждый своим
 * кодом) и держит раздельные ожидания внутри и вне `.claude`. У НЕГО ТОЖЕ ЕСТЬ СВОЯ ГРАНИЦА,
 * и она названа первым абзацем его шапки: он меряет записи ДЕМОНА, а не его ПОТОМКОВ —
 * сессия псевдотерминала запускает чужой процесс, и его записи демону не принадлежат.
 *
 * Держать оба инструмента и не сливать их — решение, а не недоделка: этот прогон дёшев,
 * идёт по боевому реестру и отвечает на вопрос фазы 1 («кит цел»), а тот разворачивает свои
 * стенды и отвечает на вопрос фазы 2 («запись не вышла за файл»).
 *
 * Инструмент читает диск напрямую (`node:fs/promises`) намеренно: он не часть демона,
 * и правило «только примитивы `pult/lib/fs-safe.mjs`» относится к читателям, чьё содержимое
 * уезжает в HTTP-ответ. Здесь наружу не уходит ничего, кроме имён путей в консоли.
 */

import { readdir, lstat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';

import { HOST, PORT, HOST_ALLOW, MAX_PROJECTS } from '../config.mjs';
import { readRegistry } from '../lib/registry.mjs';

const DEFAULT_REQUESTS = 100;
const MAX_REQUESTS = 1000;
const MAX_SNAPSHOT_FILES = 20000;

const out = (s = '') => process.stdout.write(`${s}\n`);
const err = (s = '') => process.stderr.write(`[pult] ${s}\n`);

/** Снимок дерева: относительный путь — метка изменения, размер, хеш. */
async function snapshot(root) {
  const map = new Map();
  let truncated = false;

  const walk = async (dir, rel) => {
    if (truncated) return;
    let names = [];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (truncated) return;
      const abs = path.join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = await lstat(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        await walk(abs, relPath);
        continue;
      }
      if (!st.isFile()) continue;
      if (map.size >= MAX_SNAPSHOT_FILES) { truncated = true; return; }
      let hash = '';
      try {
        hash = createHash('sha256').update(await readFile(abs)).digest('hex');
      } catch {
        hash = 'не прочитан';
      }
      map.set(relPath, { mtime: st.mtimeMs, size: st.size, hash });
    }
  };

  await walk(root, '');
  return { map, truncated };
}

/** Один запрос к демону с корректным заголовком `Host`. */
function ask(pathname) {
  return new Promise((resolve) => {
    const req = http.request({
      host: HOST,
      port: PORT,
      path: pathname,
      method: 'GET',
      headers: { Host: HOST_ALLOW[0] },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', () => resolve(0));
    req.end();
  });
}

function compare(before, after) {
  const changed = [];
  const appeared = [];
  const vanished = [];
  for (const [rel, a] of before.entries()) {
    const b = after.get(rel);
    if (!b) { vanished.push(rel); continue; }
    if (a.hash !== b.hash || a.size !== b.size || a.mtime !== b.mtime) changed.push(rel);
  }
  for (const rel of after.keys()) if (!before.has(rel)) appeared.push(rel);
  return { changed, appeared, vanished };
}

async function main() {
  const arg = process.argv[2];
  let count = DEFAULT_REQUESTS;
  if (arg !== undefined) {
    if (!/^\d{1,4}$/.test(arg)) {
      err('число запросов — целое без знака');
      return 3;
    }
    count = Math.min(Number(arg), MAX_REQUESTS);
  }

  const reg = await readRegistry();
  if (!reg.entries.length) {
    err('в реестре нет проектов: добавьте хотя бы один (pult/tools/registry-add.mjs)');
    return 3;
  }
  // Наблюдаются все записи, которые читает сам демон: его потолок — тот же `MAX_PROJECTS`.
  const targets = reg.entries.slice(0, MAX_PROJECTS);
  const dropped = reg.entries.length - targets.length;

  out(`проектов в реестре: ${reg.entries.length}`);
  if (dropped) out(`наблюдаю первые ${targets.length}: столько же читает /projects (потолок ${MAX_PROJECTS})`);
  out(`запросов: ${count}`);

  /** Снимки всех наблюдаемых китов. Усечение любого — отказ, а не предупреждение. */
  const snapshotAll = async (when) => {
    const shots = new Map();
    for (const entry of targets) {
      const kitDir = path.join(entry.path, '.claude');
      const shot = await snapshot(kitDir);
      if (shot.truncated) {
        err(`снимок ${when} обрезан на ${MAX_SNAPSHOT_FILES} файлах: ${entry.id} ${entry.name}`);
        err('прогон ничего не доказывает: часть дерева не наблюдалась');
        return null;
      }
      shots.set(entry.id, shot.map);
    }
    return shots;
  };

  const before = await snapshotAll('до');
  if (!before) return 3;
  for (const entry of targets) {
    out(`  ${entry.id}  ${entry.name}: ${before.get(entry.id).size} файлов`);
  }

  let ok = 0;
  let bad = 0;
  for (let i = 0; i < count; i += 1) {
    // Чётные ходы — список целиком, нечётные — одиночные проекты по кругу.
    const entry = targets[Math.floor(i / 2) % targets.length];
    const code = await ask(i % 2 === 0 ? '/projects' : `/projects/${entry.id}`);
    if (code === 200) ok += 1;
    else bad += 1;
  }
  out(`ответов 200: ${ok}, прочих: ${bad}`);
  if (ok === 0) {
    err('демон не ответил ни разу — прогон ничего не доказывает');
    return 3;
  }

  const after = await snapshotAll('после');
  if (!after) return 3;

  let total = 0;
  const lines = [];
  for (const entry of targets) {
    const diff = compare(before.get(entry.id), after.get(entry.id));
    const n = diff.changed.length + diff.appeared.length + diff.vanished.length;
    if (!n) continue;
    total += n;
    lines.push(`  ${entry.id} ${entry.name}:`);
    for (const rel of diff.changed) lines.push(`    изменился : ${rel}`);
    for (const rel of diff.appeared) lines.push(`    появился  : ${rel}`);
    for (const rel of diff.vanished) lines.push(`    пропал    : ${rel}`);
  }

  if (!total) {
    out(`расхождений нет (наблюдалось проектов: ${targets.length})`);
    out('каталоги и недолговечные файлы этот снимок не видит — см. шапку файла');
    return 0;
  }

  out('');
  out('расхождения (разберите глазами: хуки набора могли писать параллельно):');
  for (const line of lines) out(line);
  return 1;
}

main().then((code) => process.exit(code)).catch((e) => {
  err(`прогон не состоялся: ${(e && (e.code || e.name)) || 'ошибка'}`);
  process.exit(3);
});
