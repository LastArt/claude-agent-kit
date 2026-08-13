#!/usr/bin/env node
/**
 * Статистика работы над проектом: токены, модели, помощники, инструменты, задачи.
 *
 * Откуда данные. Сами агенты своего расхода НЕ знают — модель не видит собственных
 * токенов. Цифры берутся из транскриптов, которые Claude Code пишет на диск:
 * ~/.claude/projects/<путь-проекта>/<сессия>.jsonl — по записи на сообщение, с полем usage.
 *
 * Формат этих файлов не документирован и может измениться с версией Claude Code, поэтому
 * скрипт написан осторожно: не находит данных или не понимает формат — говорит об этом
 * прямо и выходит с нулём, а не падает и не выдумывает цифры.
 *
 *   node .claude/hooks/stats.mjs            текущая (последняя) сессия
 *   node .claude/hooks/stats.mjs --all      все сессии проекта
 *
 * Вывод — markdown: помощник вставляет его в свой ответ, и таблицы отрисовываются.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const KIT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const ALL = process.argv.includes('--all');

const dir = findTranscriptDir();
if (!dir) {
  out(`Транскрипты этого проекта не найдены в \`~/.claude/projects\`.

Статистика собирается из журналов Claude Code, а они появляются только после работы
в этой папке. Если проект открывали под другим путём или с другой машины — данные лежат там.`);
  process.exit(0);
}

const files = readdirSync(dir)
  .filter((f) => f.endsWith('.jsonl'))
  .map((f) => ({ f, m: statSync(path.join(dir, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m);

if (!files.length) { out('В журналах проекта пока нет ни одной сессии.'); process.exit(0); }

const chosen = ALL ? files : [files[0]];
const s = collect(chosen.map((x) => path.join(dir, x.f)));

if (!s.assistant) {
  out('В журнале нет ответов ассистента — считать нечего.');
  process.exit(0);
}

render(s);

// --- сбор -------------------------------------------------------------------

function collect(paths) {
  const st = {
    sessions: paths.length, user: 0, assistant: 0,
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    models: new Map(), tools: new Map(), commands: new Map(), byDay: new Map(),
    main: { msgs: 0, output: 0 }, sub: { msgs: 0, output: 0 },
    first: null, last: null, versions: new Set(), unknown: 0,
  };

  for (const p of paths) {
    let raw;
    try { raw = readFileSync(p, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { st.unknown++; continue; }

      if (o.timestamp) {
        const t = Date.parse(o.timestamp);
        if (!Number.isNaN(t)) {
          if (st.first === null || t < st.first) st.first = t;
          if (st.last === null || t > st.last) st.last = t;
        }
      }
      if (o.version) st.versions.add(o.version);
      if (o.type === 'user') {
        // Возвраты инструментов тоже приходят как user — их считать нельзя,
        // иначе «ваших сообщений» окажется в разы больше, чем вы написали.
        const c = o.message && o.message.content;
        const isToolResult = Array.isArray(c) && c.some((b) => b && b.type === 'tool_result');
        if (!isToolResult) st.user++;
      }
      if (o.type !== 'assistant') continue;

      st.assistant++;
      const msg = o.message || {};
      const u = msg.usage || {};
      const outTok = u.output_tokens || 0;

      st.input += u.input_tokens || 0;
      st.output += outTok;
      st.cacheRead += u.cache_read_input_tokens || 0;
      st.cacheWrite += u.cache_creation_input_tokens || 0;

      const model = short(msg.model || 'неизвестно');
      const m = st.models.get(model) || { msgs: 0, output: 0 };
      m.msgs++; m.output += outTok;
      st.models.set(model, m);

      const bucket = o.isSidechain ? st.sub : st.main;
      bucket.msgs++; bucket.output += outTok;

      if (o.attributionSkill) {
        const c = st.commands.get(o.attributionSkill) || { msgs: 0, output: 0 };
        c.msgs++; c.output += outTok;
        st.commands.set(o.attributionSkill, c);
      }

      if (o.timestamp) {
        const day = String(o.timestamp).slice(0, 10);
        const d = st.byDay.get(day) || { msgs: 0, output: 0 };
        d.msgs++; d.output += outTok;
        st.byDay.set(day, d);
      }

      for (const block of Array.isArray(msg.content) ? msg.content : []) {
        if (block && block.type === 'tool_use' && block.name) {
          st.tools.set(block.name, (st.tools.get(block.name) || 0) + 1);
        }
      }
    }
  }
  return st;
}

// --- вывод ------------------------------------------------------------------

function render(s) {
  const lines = [];
  const scope = ALL ? `все сессии проекта (${s.sessions})` : 'текущая сессия';

  lines.push(`## 📊 Статистика — ${scope}`, '');
  const meta = [`📁 \`${path.basename(PROJECT_DIR)}\``];
  if (duration(s)) meta.push(`⏱️ ${duration(s)}`);
  if (s.versions.size) meta.push(`🏷️ Claude Code ${[...s.versions].join(', ')}`);
  lines.push(meta.join(' · '), '');

  const cacheTotal = s.cacheRead + s.input;
  // Округление вниз: показать «100%», когда в кеш попало не всё, — значит соврать.
  const hit = cacheTotal ? Math.floor((s.cacheRead / cacheTotal) * 10000) / 100 : 0;
  const hitMark = hit >= 90 ? '🟢' : hit >= 60 ? '🟡' : '🔴';

  lines.push('| | Метрика | Значение |', '|---|---|---|');
  lines.push(`| 💬 | Ваших сообщений | ${n(s.user)} |`);
  lines.push(`| 🤖 | Ответов ассистента | ${n(s.assistant)} |`);
  lines.push(`| ✍️ | Токенов на выход | **${n(s.output)}** |`);
  lines.push(`| 📥 | Прямой вход | ${n(s.input)} |`);
  lines.push(`| ⚡ | Прочитано из кеша | ${n(s.cacheRead)} |`);
  lines.push(`| 💾 | Записано в кеш | ${n(s.cacheWrite)} |`);
  lines.push(`| ${hitMark} | Попаданий в кеш | ${hit}% |`);
  lines.push('');

  // Эмодзи живут только в заголовках и таблице: внутри блоков они занимают двойную
  // ширину и ломают выравнивание полосок.
  section(lines, '🧠 По моделям', s.models, (v) => v.msgs, (k, v) => `${pad(k, 12)} ${bar(v.msgs, max(s.models, (x) => x.msgs))} ${n(v.msgs)} ответов · ${n(v.output)} вых.`);

  if (s.sub.msgs) {
    lines.push('**🤝 Основной поток и помощники**', '', '```');
    const top = Math.max(s.main.output, s.sub.output);
    lines.push(`${pad('основной', 12)} ${bar(s.main.output, top)} ${n(s.main.output)} вых. · ${n(s.main.msgs)} отв.`);
    lines.push(`${pad('помощники', 12)} ${bar(s.sub.output, top)} ${n(s.sub.output)} вых. · ${n(s.sub.msgs)} отв.`);
    lines.push('```', '');
  }

  section(lines, '⌨️ По командам', s.commands, (v) => v.output, (k, v) => `${pad('/' + k, 20)} ${n(v.output)} вых. · ${n(v.msgs)} отв.`);
  section(lines, '🔧 Инструменты', s.tools, (v) => v, (k, v) => `${pad(k, 16)} ${bar(v, max(s.tools, (x) => x))} ${n(v)}`, 8);
  if (s.byDay.size > 1) {
    section(lines, '📅 По дням', s.byDay, (v) => v.output, (k, v) => `${pad(k, 12)} ${bar(v.output, max(s.byDay, (x) => x.output))} ${n(v.output)} вых.`, 14);
  }

  const tasks = countTasks();
  if (tasks !== null) {
    lines.push(`**📚 Задач в архиве:** ${tasks}${tasks ? ' — подробности `/cckit_recall`' : ' (появятся после первой завершённой задачи)'}`, '');
  }

  lines.push('---', '');
  lines.push('_Считано по журналам Claude Code на этой машине. Стоимость не указана намеренно:_');
  lines.push('_она зависит от тарифа, и выдуманная цифра хуже, чем её отсутствие._');

  out(lines.join('\n'));
}

/** Секция с сортировкой по убыванию и ограничением длины. */
function section(lines, title, map, weight, fmt, limit = 10) {
  if (!map.size) return;
  const rows = [...map].sort((a, b) => weight(b[1]) - weight(a[1])).slice(0, limit);
  lines.push(`**${title}**`, '', '```');
  for (const [k, v] of rows) lines.push(fmt(k, v));
  lines.push('```', '');
}

// --- мелочи -----------------------------------------------------------------

function out(text) { process.stdout.write(text.trimEnd() + '\n'); }

/** Разряды пробелами без Intl: сборки Node без полной ICU ломают toLocaleString. */
function n(v) { return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }

function pad(s, w) { return s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length); }

function bar(value, top, width = 18) {
  if (!top) return '';
  const filled = Math.max(value > 0 ? 1 : 0, Math.round((value / top) * width));
  return '█'.repeat(filled) + '·'.repeat(width - filled);
}

function max(map, weight) {
  let m = 0;
  for (const [, v] of map) m = Math.max(m, weight(v));
  return m;
}

function short(model) {
  return String(model)
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-\d+$/, (x) => x);
}

function duration(s) {
  if (s.first === null || s.last === null || s.last <= s.first) return '';
  const min = Math.round((s.last - s.first) / 60000);
  if (min < 60) return `${min} мин`;
  return `${Math.floor(min / 60)} ч ${min % 60} мин`;
}

/** Сколько задач уже уехало в историю — если архив вообще заведён. */
function countTasks() {
  const history = path.join(KIT_DIR, 'artifacts', 'history');
  if (!existsSync(history)) return null;
  try {
    return readdirSync(history).filter((f) => f.endsWith('.md') && f !== 'INDEX.md').length;
  } catch { return null; }
}

/**
 * Папка транскриптов: Claude Code кодирует путь проекта, заменяя всё, кроме букв и цифр,
 * на дефис. Регистр диска при этом может отличаться, поэтому есть запасное сравнение
 * без учёта регистра.
 */
function findTranscriptDir() {
  const root = path.join(os.homedir(), '.claude', 'projects');
  if (!existsSync(root)) return null;
  const key = PROJECT_DIR.replace(/[^a-zA-Z0-9]/g, '-');
  const exact = path.join(root, key);
  if (existsSync(exact)) return exact;
  try {
    const found = readdirSync(root).find((d) => d.toLowerCase() === key.toLowerCase());
    return found ? path.join(root, found) : null;
  } catch { return null; }
}
