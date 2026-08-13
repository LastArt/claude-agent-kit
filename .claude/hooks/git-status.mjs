#!/usr/bin/env node
/**
 * Stop-хук: короткая сводка о состоянии рабочего дерева после остановки агента.
 *
 * Раньше здесь печатался весь `git status --short --branch`. В репозитории с десятками
 * правок это простыня, которую перестают читать, — поэтому теперь:
 *   • чистое дерево  → не печатается НИЧЕГО (нет новости — нет строки);
 *   • есть правки    → одна строка со счётчиками + до 8 файлов;
 *   • не git-папка   → тихий выход, как и раньше.
 *
 * Кроссплатформенно (через node, без shell-специфичных операторов).
 */
import { execFileSync } from 'node:child_process';

const MAX_FILES = 8;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

try {
  git(['rev-parse', '--is-inside-work-tree']); // бросит, если не репозиторий или нет git
} catch {
  process.exit(0); // не git-папка — тихо выходим
}

let lines;
try {
  lines = git(['status', '--porcelain', '--branch']).split('\n').filter(Boolean);
} catch {
  process.exit(0);
}

const head = lines[0] || '';
const files = lines.slice(1);
if (files.length === 0) process.exit(0); // чисто — молчим

// Ветка и расхождение с удалёнкой берём из служебной строки `## main...origin/main [ahead 2]`
const branch = (head.match(/^## (?:No commits yet on )?([^.\s]+)/) || [, '?'])[1];
const track = (head.match(/\[(.+)\]$/) || [, ''])[1];

let modified = 0, added = 0, deleted = 0, untracked = 0, renamed = 0;
for (const l of files) {
  const x = l.slice(0, 2);
  if (x === '??') untracked++;
  else if (x.includes('A')) added++;
  else if (x.includes('D')) deleted++;
  else if (x.includes('R')) renamed++;
  else modified++;
}

const parts = [];
if (modified) parts.push(`изменено ${modified}`);
if (added) parts.push(`добавлено ${added}`);
if (deleted) parts.push(`удалено ${deleted}`);
if (renamed) parts.push(`переименовано ${renamed}`);
if (untracked) parts.push(`новых ${untracked}`);

let out = `▌ ${branch}: ${parts.join(', ')}`;
if (track) out += ` · ${track}`;
out += '\n';

for (const l of files.slice(0, MAX_FILES)) out += `  ${l}\n`;
if (files.length > MAX_FILES) out += `  … и ещё ${files.length - MAX_FILES}\n`;

process.stdout.write(out);
process.exit(0);
