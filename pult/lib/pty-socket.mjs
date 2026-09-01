#!/usr/bin/env node
/**
 * Мост «вебсокет ↔ псевдотерминал».
 *
 * СЕРВЕР ВЕБСОКЕТА СОЗДАЁТСЯ ЗДЕСЬ И ТОЛЬКО С `noServer: true`. Это УСЛОВИЕ, а не деталь
 * реализации: форма с готовым HTTP-сервером в поле `server` вешает СОБСТВЕННЫЙ слушатель
 * события `upgrade` и доводит рукопожатие сама — ни `Host`, ни `Origin` не спрашивая. Тогда
 * ограждение `pult/server.mjs` перестаёт быть ограждением, а исход решает порядок регистрации
 * слушателей, то есть случайность. Форма с полем `port` не лучше: она открывает ВТОРОЙ
 * слушающий сокет, причём на всех интерфейсах, и поиск по имени поля `server` её не видит.
 *
 * Обе запрещённые формы названы здесь ОПИСАНИЕМ, а не строкой кода, намеренно: проверка
 * шага 15 плана фазы 2 ищет по каталогу подстроку создания сервера и требует РОВНО ОДНОГО
 * вхождения — процитированный в комментарии образец сделал бы эту проверку неверной.
 *
 * ДВА ПОТОЛКА ПРИ СОЗДАНИИ, оба обязательны:
 *   • `maxPayload` равен потолку ввода из констант. Умолчание библиотеки — 100 МиБ, то есть
 *     наш потолок проверялся бы уже ПОСЛЕ приёма ста мегабайт в память. Кадр сверх потолка
 *     библиотека закрывает сама, до разбора. Оговорка честная: обёртка кадра (`{"t":"input",
 *     "d":…}` плюс экранирование) входит в тот же потолок, поэтому фактический потолок ВВОДА
 *     чуть ниже — сторона запаса, а не дыры.
 *   • `perMessageDeflate: false` — сжатие даёт тот же множитель бесплатно нападающему.
 *
 * ОТ КЛИЕНТА ПРИНИМАЮТСЯ ТОЛЬКО ТЕКСТОВЫЕ КАДРЫ С JSON ЗАКРЫТОЙ ФОРМЫ: ввод и изменение
 * размера. Поля переносятся ПОИМЁННО, слияния и расширения разобранного объекта нет — так же
 * это сделано в `parseEntry()` в `pult/lib/registry.mjs`. Двоичный кадр, чужой ключ,
 * отсутствующий вид сообщения — ЗАКРЫТИЕ СОЕДИНЕНИЯ, а не «попробуем понять»: за этим адресом
 * стоит оболочка машины, и «попробуем понять» здесь стоит дороже, чем разорванное соединение.
 *
 * ПУТЬ К ПРОЕКТУ БЕРЁТСЯ ИЗ ЗАПИСИ РЕЕСТРА. Из адреса он не подставляется НИКОГДА: клиент
 * присылает идентификатор, идентификатор проверяется регуляркой и сверяется с реестром,
 * а рабочий каталог сессии — поле записи. Маршрута, принимающего путь проекта из запроса,
 * у демона нет и быть не должно — такой маршрут и есть способ обойти всё разом.
 *
 * ОБРАТНОЕ ДАВЛЕНИЕ. Перевалил объём буферизации сокета за порог — чтение из процесса
 * ПРИОСТАНАВЛИВАЕТСЯ и возобновляется при разгрузке; держится сверх порога дольше отведённого —
 * соединение закрывается. Без этого `yes` в терминале при медленном клиенте выедает память
 * демона, а кольцевой буфер сессии здесь не помогает: он про переподключение, а не про живой
 * поток.
 *
 * ПИНГ ОБЯЗАТЕЛЕН. Без него полуоткрытое соединение (уснувший ноутбук, убитая вкладка без
 * прощания) не даёт события отключения, таймер пяти минут не взводится НИКОГДА, и пункт 10
 * критерия готовности недостижим ровно в том случае, ради которого написан.
 *
 * ОТКЛЮЧЕНИЕ КЛИЕНТА ПЕРЕДАЁТ СЕССИЮ ТАЙМЕРУ, а не убивает её (решение 2 человека).
 *
 * ОШИБКА МОСТА НЕ РОНЯЕТ ДЕМОН: наружу уходит закрытие соединения, в stdout — своё машинное
 * слово из закрытого словаря, и ни строки чужого текста.
 */

import process from 'node:process';
import { WebSocketServer } from 'ws';

import { readRegistry } from './registry.mjs';
import { open as openSession } from './pty.mjs';
import {
  FAULT, PROJECT_ID_RE, PTY_KINDS, MAX_PTY_INPUT, MAX_COLS, MAX_ROWS,
  WS_PING_MS, WS_SILENCE_MS, WS_BACKPRESSURE_BYTES, WS_BACKPRESSURE_MS,
} from '../config.mjs';

const say = (s) => process.stdout.write(`[pult] ${s}\n`);

/**
 * ЕДИНСТВЕННЫЙ сервер вебсокета демона, и он без своего слушателя. Рукопожатие доводит
 * `pult/server.mjs` — ПОСЛЕ сверки происхождения, сверки пути и ограничителя соединений.
 */
export const wsServer = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_PTY_INPUT,
  perMessageDeflate: false,
});

/**
 * Закрытая форма сообщений от клиента: вид — список допустимых ключей. Ключ, которого здесь
 * нет, закрывает соединение; проверяется именно СОСТАВ ключей, а не наличие нужных, — иначе
 * лишнее поле проезжает молча.
 */
const FRAME_KEYS = Object.freeze({
  input: Object.freeze(['t', 'd']),
  resize: Object.freeze(['t', 'cols', 'rows']),
});

/** Целое от клиента: строка, дробь и `NaN` — не целое, а отказ. */
function isInt(v, min, max) {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

/**
 * Закрыть соединение своим машинным словом.
 *
 * Слово — из закрытого словаря отказов, то есть наше собственное; чужой текст в причину
 * закрытия не попадает никогда (RFC отводит на неё 123 байта, и цитировать туда чужой ввод —
 * это отдавать его обратно в браузер).
 */
function refuse(ws, code, why) {
  try {
    ws.close(code, why);
  } catch {
    try { ws.terminate(); } catch { /* сокет уже мёртв */ }
  }
}

/**
 * Свести соединение с сессией.
 *
 * Зовётся `pult/server.mjs` ПОСЛЕ доведения рукопожатия. Разбирает параметры, поднимает
 * (или подхватывает) сессию и качает байты в обе стороны.
 *
 * @param {import('ws').WebSocket} ws   уже поднятое соединение
 * @param {URL} url                     разобранный адрес запроса апгрейда
 */
export async function bridge(ws, url) {
  const id = url.searchParams.get('project') || '';
  const kind = url.searchParams.get('kind') || '';

  if (!PROJECT_ID_RE.test(id)) {
    refuse(ws, 1008, FAULT.REGISTRY_ENTRY_INVALID);
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(PTY_KINDS, kind)) {
    refuse(ws, 1008, FAULT.UNKNOWN_SESSION_KIND);
    return;
  }

  // Путь берётся ИЗ ЗАПИСИ РЕЕСТРА. Идентификатор в файловый путь не подставляется никогда —
  // ровно так же это устроено у маршрута одного проекта в `pult/server.mjs`.
  const registry = await readRegistry();
  const entry = registry.entries.find((e) => e.id === id);
  if (!entry) {
    refuse(ws, 1008, FAULT.PATH_UNREACHABLE);
    return;
  }

  const cols = Number(url.searchParams.get('cols'));
  const rows = Number(url.searchParams.get('rows'));
  const session = await openSession({
    projectPath: entry.path,
    projectId: entry.id,
    kind,
    cols: Number.isFinite(cols) ? cols : undefined,
    rows: Number.isFinite(rows) ? rows : undefined,
  });
  if (!session.ok) {
    say(`сессия не открыта: ${session.code}`);
    refuse(ws, 1008, session.code);
    return;
  }

  session.attach();
  say(`сессия ${session.id.slice(0, 8)}: проект ${entry.id}, вид ${kind}`);

  // ПОСЛЕДНИЙ ЭКРАН вернувшемуся клиенту. Для новой сессии буфер пуст, и кадр не шлётся вовсе:
  // пустой кадр терминал всё равно нарисует как ничего, а лишних кадров лучше не плодить.
  const screen = session.buffer();
  if (screen) {
    try { ws.send(screen); } catch { /* закрылись раньше первого кадра */ }
  }

  let lastSeen = Date.now();
  let paused = false;
  let overSince = 0;
  let closed = false;

  /** Обратное давление: пауза при переполнении, закрытие при затяжном переполнении. */
  const pressure = () => {
    if (closed || ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > WS_BACKPRESSURE_BYTES) {
      if (!paused) {
        paused = true;
        overSince = Date.now();
        session.pause();
      } else if (Date.now() - overSince > WS_BACKPRESSURE_MS) {
        say('соединение закрыто: клиент не разгребает вывод');
        try { ws.terminate(); } catch { /* уже мёртв */ }
      }
      return;
    }
    if (paused) {
      paused = false;
      overSince = 0;
      session.resume();
    }
  };

  const offData = session.onData((chunk) => {
    if (closed || ws.readyState !== ws.OPEN) return;
    try {
      ws.send(chunk);
    } catch {
      return;
    }
    pressure();
  });

  const offExit = session.onExit(() => {
    if (closed) return;
    refuse(ws, 1000, 'session_exit');
  });

  // Два таймера, и оба со своим смыслом: пинг ловит полуоткрытое соединение, разгрузка —
  // клиента, который перестал читать, не отключившись. Один таймер на оба дела означал бы
  // выбор между «редко проверяем давление» и «часто шлём пинги».
  const ping = setInterval(() => {
    if (closed) return;
    if (Date.now() - lastSeen > WS_SILENCE_MS) {
      say('соединение закрыто: клиент молчит дольше порога');
      try { ws.terminate(); } catch { /* уже мёртв */ }
      return;
    }
    try { ws.ping(); } catch { /* уже мёртв */ }
  }, WS_PING_MS);
  const drain = setInterval(pressure, 1000);
  if (typeof ping.unref === 'function') ping.unref();
  if (typeof drain.unref === 'function') drain.unref();

  ws.on('pong', () => { lastSeen = Date.now(); });

  ws.on('message', (data, isBinary) => {
    lastSeen = Date.now();
    // ДВОИЧНЫЙ КАДР — закрытие. Разбирать его нечем: форма у нас одна, и она текстовая.
    if (isBinary) {
      refuse(ws, 1003, FAULT.BAD_BODY);
      return;
    }
    const text = data.toString('utf8');
    if (Buffer.byteLength(text, 'utf8') > MAX_PTY_INPUT) {
      refuse(ws, 1009, FAULT.BODY_TOO_BIG);
      return;
    }
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      refuse(ws, 1008, FAULT.BAD_BODY);
      return;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      refuse(ws, 1008, FAULT.BAD_BODY);
      return;
    }
    const keys = Object.prototype.hasOwnProperty.call(FRAME_KEYS, obj.t) ? FRAME_KEYS[obj.t] : null;
    if (!keys) {
      refuse(ws, 1008, FAULT.BAD_BODY);
      return;
    }
    // СОСТАВ КЛЮЧЕЙ, а не наличие нужных: лишнее поле — признак чужой формы, а не мелочь.
    for (const k of Object.keys(obj)) {
      if (!keys.includes(k)) {
        refuse(ws, 1008, FAULT.BAD_BODY);
        return;
      }
    }
    if (obj.t === 'input') {
      if (typeof obj.d !== 'string' || Buffer.byteLength(obj.d, 'utf8') > MAX_PTY_INPUT) {
        refuse(ws, 1008, FAULT.BAD_BODY);
        return;
      }
      session.write(obj.d);
      return;
    }
    if (!isInt(obj.cols, 1, MAX_COLS) || !isInt(obj.rows, 1, MAX_ROWS)) {
      refuse(ws, 1008, FAULT.BAD_BODY);
      return;
    }
    session.resize(obj.cols, obj.rows);
  });

  ws.on('error', () => {
    // Ошибка соединения — не повод ронять демон и не повод убивать сессию: закрываемся
    // и отдаём её таймеру пяти минут.
    try { ws.terminate(); } catch { /* уже мёртв */ }
  });

  ws.on('close', () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    clearInterval(drain);
    offData();
    offExit();
    // Приостановленное чтение возобновляется ДО передачи сессии таймеру: иначе вернувшийся
    // клиент получит немой терминал, и лечить это будут снятием обратного давления.
    if (paused) session.resume();
    session.detach();
  });
}
