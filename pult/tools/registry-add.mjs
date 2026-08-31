#!/usr/bin/env node
/**
 * Завести проект в реестре пульта.
 *
 *   node pult/tools/registry-add.mjs <путь к проекту>
 *
 * На фазе 1 это ЕДИНСТВЕННЫЙ способ добавить проект: API работает только на чтение, методов
 * записи у демона нет вовсе. В кит инструмент не пишет ничего — только в реестр пульта,
 * который лежит в профиле пользователя.
 *
 * Санитария входа (аргумент приходит из командной строки человека, но проверяется как чужой):
 *   • нулевой байт и управляющие символы — отказ;
 *   • длина сверх потолка — отказ;
 *   • сетевая (UNC) форма — отказ с объяснением: `stat` по такому пути уходит в сеть к чужому
 *     хосту с попыткой аутентификации, поддержки на фазе 1 нет намеренно;
 *   • путь приводится `resolve`, затем `realpath` — в реестр пишется РАЗРЕШЁННЫЙ путь,
 *     иначе один и тот же проект попадёт в реестр дважды под разными именами;
 *   • путь обязан существовать и быть каталогом по `lstat` (не симлинком на каталог).
 *
 * Повторный запуск с тем же путём дубля не создаёт.
 */

import path from 'node:path';
import process from 'node:process';

import { statSafe, realPath, isUncPath, sanePath, capText } from '../lib/fs-safe.mjs';
import { addProject, readRegistry, registryFile } from '../lib/registry.mjs';
import { MAX_PATH } from '../config.mjs';

const TAG = '[pult]';
const out = (s = '') => process.stdout.write(`${s}\n`);
const err = (s = '') => process.stderr.write(`${TAG} ${s}\n`);

function usage() {
  out('Завести проект в реестре пульта:');
  out('  node pult/tools/registry-add.mjs <путь к проекту>');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === '--help' || args[0] === '-h') {
    usage();
    return args.length === 1 ? 0 : 3;
  }

  const raw = args[0];
  if (!sanePath(raw)) {
    err('путь пуст, длиннее потолка или содержит управляющие символы');
    return 3;
  }
  if (raw.length > MAX_PATH) {
    err(`путь длиннее потолка (${MAX_PATH})`);
    return 3;
  }
  if (isUncPath(raw)) {
    err('сетевой (UNC) путь на фазе 1 не поддерживается намеренно:');
    err('обращение к нему уходит в сеть к чужому хосту с попыткой аутентификации');
    return 3;
  }

  const resolved = path.resolve(raw);
  const real = await realPath(resolved);
  if (!real.ok) {
    err(`путь недоступен: ${real.code}`);
    return 3;
  }
  if (isUncPath(real.path)) {
    err('после разрешения ссылок путь оказался сетевым (UNC) — отказ по той же причине');
    return 3;
  }

  const st = await statSafe(real.path);
  if (!st.ok) {
    err(`путь недоступен: ${st.code}`);
    return 3;
  }
  if (!st.stat.isDirectory()) {
    err('это не каталог: в реестр попадает корень проекта, а не файл');
    return 3;
  }

  const name = capText(path.basename(real.path)).text;
  const res = await addProject(real.path, name);
  if (!res.ok) {
    err(`не записал: ${res.code}`);
    return 3;
  }

  out(res.added ? `добавлено: ${res.entry.id} ${res.entry.name}` : `уже в реестре: ${res.entry.id} ${res.entry.name}`);
  out(`реестр: ${registryFile()}`);
  out('');
  const reg = await readRegistry();
  out(`записей: ${reg.entries.length}`);
  for (const e of reg.entries) {
    out(`  ${e.id}  ${e.name}  ${e.path}  просмотр: ${e.seen ? e.seen.value : '-'}`);
  }
  if (reg.faults.length) out(`отказы разбора: ${reg.faults.map((f) => f.code).join(', ')}`);
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  err(`не отработал: ${(e && (e.code || e.name)) || 'ошибка'}`);
  process.exit(3);
});
