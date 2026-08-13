#!/usr/bin/env node
/**
 * Архивирует завершённую задачу: PLAN.md + REVIEW.md → .claude/artifacts/history/.
 *
 * Зачем. PLAN.md и REVIEW.md перезаписываются на каждой новой задаче, и вместе с ними
 * исчезает единственное, что нельзя восстановить, перечитав код: ПОЧЕМУ сделали так,
 * что рассматривали и отвергли, обо что споткнулись. Архив — это память проекта.
 * Хранится обычным markdown: читается человеком, ищется через grep, не бьётся и не требует
 * никаких инструментов, чтобы прочитать.
 *
 * Запускается ОРКЕСТРАТОРОМ перед тем, как planner перезапишет план (у самого planner
 * нет Bash — и не нужно). Вызов идемпотентный и безопасный: нечего архивировать —
 * молча выходит с нулём, ничего не удаляя.
 *
 *   node .claude/hooks/archive-task.mjs           заархивировать текущие PLAN/REVIEW
 *   node .claude/hooks/archive-task.mjs --dry     показать, что будет сделано
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = path.join(KIT_DIR, 'artifacts');
const HISTORY = path.join(ARTIFACTS, 'history');
const INDEX = path.join(HISTORY, 'INDEX.md');
const DRY = process.argv.includes('--dry');

const plan = read(path.join(ARTIFACTS, 'PLAN.md'));
const review = read(path.join(ARTIFACTS, 'REVIEW.md'));
const security = read(path.join(ARTIFACTS, 'SECURITY.md'));

// Пустой план или нетронутый шаблон — архивировать нечего. Это норма, а не ошибка.
if (!plan.trim() || plan.includes('<название задачи>')) {
  process.stdout.write('[архив] плана для архивации нет — пропускаю\n');
  process.exit(0);
}

const title = (plan.match(/^#\s*PLAN\s*[—-]\s*(.+)$/m) || [, 'без названия'])[1].trim();
const date = (plan.match(/\*\*Дата:\*\*\s*_?\(?(\d{4}-\d{2}-\d{2})\)?_?/) || [, today()])[1];
const files = filesFromPlan(plan);
const outcome = outcomeFromReview(review);

const name = `${date}-${slug(title)}.md`;
const target = path.join(HISTORY, name);

const entry = `# ${title}

**Дата:** ${date}
**Итог ревью:** ${outcome}
**Затронутые файлы:** ${files.length ? files.join(', ') : 'не указаны в плане'}

---

## План

${plan.trim()}

---

## Аудит безопасности

${security.trim() || '_аудит не проводился_'}

---

## Ревью

${review.trim() || '_ревью не проводилось_'}
`;

const indexLine = `- **${date}** — ${title} — ${outcome} — [подробно](${name})\n`;

if (DRY) {
  process.stdout.write(`[архив] был бы создан: artifacts/history/${name}\n`);
  process.stdout.write(`[архив] строка индекса: ${indexLine}`);
  process.exit(0);
}

mkdirSync(HISTORY, { recursive: true });
writeFileSync(target, entry, 'utf8');

if (!existsSync(INDEX)) {
  writeFileSync(INDEX, `# История задач\n\n> Пополняется автоматически при старте новой задачи.\n> Полный текст каждой записи — в соседних файлах. Искать: \`grep -ri "<что ищем>" .claude/artifacts/history\`\n\n`, 'utf8');
}
appendFileSync(INDEX, indexLine, 'utf8');

process.stdout.write(`[архив] задача сохранена: artifacts/history/${name}\n`);

// --- вспомогательное -------------------------------------------------------

function read(p) { try { return readFileSync(p, 'utf8'); } catch { return ''; } }

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Пути из шагов плана: строки вида «_Файл:_ `путь`». */
function filesFromPlan(src) {
  const found = new Set();
  for (const m of src.matchAll(/_Файл:_\s*`([^`]+)`/g)) found.add(m[1].trim());
  return [...found].slice(0, 12);
}

function outcomeFromReview(src) {
  const text = src.trim();
  if (!text) return 'ревью не проводилось';
  if (/^APPROVED\s*$/m.test(text)) return 'APPROVED';
  const counts = ['🔴', '🟡', '⚪'].map((mark) => (text.split(mark).length - 1));
  const [crit, important] = counts;
  if (crit || important) return `замечания: 🔴 ${crit}, 🟡 ${important}`;
  return 'ревью проведено';
}

/**
 * Имя файла из названия задачи. Кириллица переводится в латиницу: так имя остаётся
 * читаемым и не ломается при переносе архива между системами и архиваторами.
 */
function slug(title) {
  const map = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
    й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
    у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
    э: 'e', ю: 'yu', я: 'ya',
  };
  return [...title.toLowerCase()]
    .map((ch) => (map[ch] !== undefined ? map[ch] : ch))
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'zadacha';
}
