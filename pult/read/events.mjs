#!/usr/bin/env node
/**
 * Журнал событий кита — хвостом.
 *
 * Журнал растёт без ротации, поэтому читается только хвост: через `tailBytes()`
 * в `pult/lib/fs-safe.mjs`, который сам проверяет обычность файла ДО открытия дескриптора.
 * Прямых обращений к `node:fs` в модуле нет. Тот же приём в ките — `selftest()`
 * в `.claude/hooks/events.mjs`.
 *
 * Сквозной бюджет запроса приходит аргументом и тратится здесь тоже: журнал — такой же
 * читатель проекта, как остальные, и исключением из бюджета не был бы безопасен (64 КБ
 * на проект при потолке в 64 проекта — это до 4 МБ чтения мимо всех счётчиков).
 *
 * Буфер декодируется целиком, первая строка отбрасывается, если читали не с начала: в ней
 * и обрубок записи, и разрубленный многобайтный символ. Строка длиннее потолка пропускается
 * без разбора. Нечитаемая строка пропускается МОЛЧА: последняя может быть недописана,
 * а в журнале этого репозитория лежат посторонние строки от проб фазы 0.
 *
 * ИЗ РАЗОБРАННОГО СОБЫТИЯ БЕРУТСЯ ПОИМЁННО ТОЛЬКО `ts`, `event` и `task_id`. `payload`
 * не читается и наружу не идёт НИКОГДА: в нём живёт заголовок задачи, то есть свободный текст
 * человека (§0.2 контракта). Значение `event` отдаётся только при совпадении с закрытым
 * списком имён, `task_id` — только по форме идентификатора, `ts` — только через единственную
 * дверь к временам в виде `utc-iso` (журнал пишет его временем в UTC — см. `emit()`
 * в `.claude/hooks/events.mjs`).
 *
 * Событие с нераспознанным временем на роль «последнего движения конвейера» не годится:
 * берётся предыдущее разобранное.
 *
 * ХОДЫ И ПОПЫТКИ ПО ЧИСЛУ СТРОК НЕ СЧИТАЮТСЯ — один ход может дать два результата приёмки
 * подряд. Никакой агрегации на этой фазе нет вовсе: единственный потребитель — время
 * последнего движения конвейера в поле «кит менялся».
 */

import path from 'node:path';

import { tailBytes, timeField, enumField } from '../lib/fs-safe.mjs';
import {
  FAULT, ENUM, TASK_ID_RE, TASK_ID_MAX, EVENTS_TAIL_BYTES, MAX_LINE_BYTES,
} from '../config.mjs';

/**
 * Последнее годное событие журнала.
 *
 * @param {string} kitDir  папка кита проекта
 * @param {object} options `budget` — сквозной счётчик запроса: чтение хвоста тратит его
 *                         наравне с остальными читателями проекта (списывается размер
 *                         хвоста, см. `tailBytes()` в `pult/lib/fs-safe.mjs`)
 * @returns {{last: object|null, skipped: number, faults: Array}}
 */
export async function readLastEvent(kitDir, options = {}) {
  const budget = options.budget || null;
  const file = path.join(kitDir, 'artifacts', 'events.jsonl');
  const faults = [];

  const tail = await tailBytes(file, EVENTS_TAIL_BYTES, budget);
  if (!tail.ok) {
    // Журнала нет — это не отказ: проект мог ни разу не запускать конвейер.
    // Исчерпанный бюджет — отказ, и назвать его надо своим кодом, а не «нечитаемым журналом»:
    // файл читаем, кончился ход запроса.
    if (tail.code === FAULT.BUDGET_EXHAUSTED) {
      faults.push({ field: 'events', code: FAULT.BUDGET_EXHAUSTED });
    } else if (tail.code !== FAULT.PATH_UNREACHABLE) {
      faults.push({ field: 'events', code: FAULT.EVENTS_UNREADABLE });
    }
    return { last: null, skipped: 0, faults };
  }

  const lines = tail.buf.toString('utf8').split(/\r?\n/);
  if (tail.partial && lines.length) lines.shift();

  let last = null;
  let skipped = 0;
  let badTime = false;

  for (const line of lines) {
    if (!line || line.length > MAX_LINE_BYTES) {
      if (line) skipped += 1;
      continue;
    }
    let data = null;
    try {
      data = JSON.parse(line);
    } catch {
      skipped += 1;                                   // недописанная или посторонняя строка
      continue;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) { skipped += 1; continue; }

    const event = enumField(typeof data.event === 'string' ? data.event : '', ENUM.event);
    if (event === null) { skipped += 1; continue; }

    const ts = typeof data.ts === 'string' ? timeField(data.ts, 'utc-iso') : null;
    if (ts === null) { skipped += 1; badTime = true; continue; }

    const rawId = typeof data.task_id === 'string' ? data.task_id : '';
    const taskId = (rawId && rawId.length <= TASK_ID_MAX && TASK_ID_RE.test(rawId)) ? rawId : null;

    // Поля переносятся поимённо: `payload` не читается вовсе.
    last = { ts, event, task_id: taskId };
  }

  if (badTime) faults.push({ field: 'events.ts', code: FAULT.TIME_UNRECOGNISED });
  return { last, skipped, faults };
}
