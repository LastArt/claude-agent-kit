#!/usr/bin/env node
/**
 * Артефакты задачи: ревью, аудит безопасности и итог.
 *
 * У РЕВЬЮ И АУДИТА читается машинная шапка. Вердикт отдаётся только как совпадение
 * с закрытым словарём (`approved`, `changes_requested`, `blocked` — по эталонам
 * `.claude/assets/stubs/REVIEW.md` и `.claude/assets/stubs/SECURITY.md`), у ревью ещё три
 * счётчика — только целые без знака, иначе `null`.
 *
 * Два случая различаются намеренно, и коды у них разные:
 *   • шапки нет вовсе (в том числе из-за метки порядка байтов или пустой строки перед
 *     разделителем) — весь объект `null` и свой код;
 *   • шапка есть, а вердикт пуст или не из словаря — вердикт `null` и другой код.
 * Без этого различения «ревью не проводилось» и «ревью написано криво» слились бы в одно.
 *
 * ЕДИНСТВЕННЫЙ ЗАПАСНОЙ ПУТЬ для файлов старого формата — строгое совпадение всей строки
 * со словом одобрения, как в `outcomeFromReview()` в `.claude/hooks/map.mjs`. Подсчёт эмодзи
 * НЕ переносится: заголовки таблиц в форме содержат те же значки, и на нетронутой заглушке
 * он врёт про ревью, которого не было.
 *
 * ИТОГ ЗАДАЧИ шапки не имеет и разбирается как проза: дата — только через единственную дверь
 * к временам в виде `date`, не совпало — `null` и код; кусок прозы чужого файла на место даты
 * не переносится никогда. Сводка — первый непустой абзац раздела о сделанном, чек-лист —
 * пункты раздела ручной проверки с признаком отметки, всё в пределах потолков и через очистку
 * свободного текста.
 *
 * Все чтения — через примитивы `pult/lib/fs-safe.mjs`; прямых обращений к `node:fs` нет.
 * Правила разбора недоверенного текста — те же, что в `pult/read/tasks.mjs`.
 */

import path from 'node:path';

import { readTextCapped, capText, timeField, enumField, counterField } from '../lib/fs-safe.mjs';
import { frontMatter } from './tasks.mjs';
import {
  FAULT, ENUM, MAX_TEXT_FILE, MAX_LINE_BYTES, MAX_CHECKLIST,
} from '../config.mjs';

/** Старый формат: весь файл — одно слово одобрения. Строгое совпадение строки целиком. */
const LEGACY_APPROVED_RE = /^APPROVED\s*$/m;

/** Пункт чек-листа с признаком отметки. */
const CHECK_RE = /^-\s+\[([ xX])\]\s*(.*)$/;

/** Строка даты в итоге задачи. */
const DATE_RE = /^\*\*Дата:\*\*\s*(.*)$/;

async function readIf(file, budget) {
  const res = await readTextCapped(file, MAX_TEXT_FILE, budget);
  return res.ok ? res.text : null;
}

/**
 * Шапка ревью или аудита.
 *
 * @param {string|null} text
 * @param {string} kind    `review` — с тремя счётчиками, `security` — только вердикт
 */
function header(text, kind, faults) {
  const missingCode = kind === 'review' ? FAULT.REVIEW_HEADER_MISSING : FAULT.SECURITY_HEADER_MISSING;
  if (text === null) return null;

  const fm = frontMatter(text);
  if (!fm) {
    // Запасной путь для копий до 1.15: весь файл — одно слово одобрения.
    if (LEGACY_APPROVED_RE.test(text)) {
      return kind === 'review'
        ? { verdict: 'approved', critical: null, important: null, minor: null }
        : { verdict: 'approved' };
    }
    faults.push({ field: kind, code: missingCode });
    return null;
  }

  const raw = fm.has('verdict') ? fm.get('verdict') : '';
  const verdict = enumField(raw, ENUM.verdict);
  if (verdict === null) faults.push({ field: `${kind}.verdict`, code: FAULT.ENUM_UNRECOGNISED });

  if (kind !== 'review') return { verdict };

  const out = { verdict, critical: null, important: null, minor: null };
  for (const field of ['critical', 'important', 'minor']) {
    const value = counterField(fm.has(field) ? fm.get(field) : '');
    if (value === null && fm.has(field)) faults.push({ field: `review.${field}`, code: FAULT.ENUM_UNRECOGNISED });
    out[field] = value;
  }
  return out;
}

/** Итог задачи: дата, сводка, чек-лист. Наружу идут только эти три поля. */
function outcome(text, faults) {
  if (text === null) return null;
  const lines = text.split(/\r?\n/);

  let date = null;
  for (const line of lines) {
    if (line.length > MAX_LINE_BYTES) continue;
    const m = line.match(DATE_RE);
    if (!m) continue;
    const value = timeField(m[1].trim(), 'date');
    if (!value) faults.push({ field: 'done.date', code: FAULT.TIME_UNRECOGNISED });
    date = value;
    break;
  }

  // Сводка — первый непустой абзац раздела о сделанном.
  let summary = null;
  const madeAt = lines.findIndex((l) => l.trim().startsWith('## Что сделано'));
  if (madeAt >= 0) {
    const buf = [];
    for (let i = madeAt + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.trim().startsWith('## ')) break;
      if (line.length > MAX_LINE_BYTES) continue;
      if (!line.trim()) {
        if (buf.length) break;
        continue;
      }
      buf.push(line.trim());
    }
    if (buf.length) {
      const t = capText(buf.join(' '));
      if (t.truncated) faults.push({ field: 'done.summary', code: FAULT.TEXT_TRUNCATED });
      summary = t.text;
    }
  }

  // Чек-лист — пункты раздела ручной проверки.
  const checklist = [];
  const checkAt = lines.findIndex((l) => l.trim().startsWith('## Проверить руками'));
  if (checkAt >= 0) {
    for (let i = checkAt + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.trim().startsWith('## ')) break;
      if (line.length > MAX_LINE_BYTES) continue;
      const m = line.trim().match(CHECK_RE);
      if (!m) continue;
      if (checklist.length >= MAX_CHECKLIST) {
        faults.push({ field: 'done.checklist', code: FAULT.TEXT_TRUNCATED });
        break;
      }
      const t = capText(m[2]);
      if (t.truncated) faults.push({ field: 'done.checklist', code: FAULT.TEXT_TRUNCATED });
      checklist.push({ done: m[1].toLowerCase() === 'x', text: t.text });
    }
  }

  if (date === null && summary === null && checklist.length === 0) {
    faults.push({ field: 'done', code: FAULT.DONE_UNPARSED });
  }
  return { present: true, summary, checklist, date };
}

/**
 * Артефакты одной задачи.
 *
 * @param {string} taskDir папка задачи
 * @param {object} options `budget` — сквозной счётчик запроса
 */
export async function readArtifacts(taskDir, options = {}) {
  const budget = options.budget || null;
  const faults = [];

  const reviewText = await readIf(path.join(taskDir, 'REVIEW.md'), budget);
  const securityText = await readIf(path.join(taskDir, 'SECURITY.md'), budget);
  const doneText = await readIf(path.join(taskDir, 'DONE.md'), budget);

  return {
    review: header(reviewText, 'review', faults),
    security: header(securityText, 'security', faults),
    done: outcome(doneText, faults),
    faults,
  };
}
