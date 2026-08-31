#!/usr/bin/env node
/**
 * Демон пульта: HTTP только на чтение.
 *
 *   node pult/server.mjs
 *
 * Три маршрута:
 *   GET /health          состояние самого демона
 *   GET /projects        список проектов реестра, каждый — с версией и сверкой отпечатка
 *   GET /projects/:id    один проект целиком, со списком задач
 *
 * ПРОВЕРКА ПРОИСХОЖДЕНИЯ — ПЕРВЫМ ДЕЛОМ, до маршрутизации и до любого обращения к диску.
 * Заголовок `Host` обязан точно совпасть с одним из закрытого списка; `Sec-Fetch-Site`, если
 * он есть, обязан быть `same-origin` или `none` (отсутствие законно — консольные клиенты его
 * не шлют).
 *
 * Почему этого нельзя не делать. Привязка к `127.0.0.1` границей для браузера НЕ является:
 * страница заводит домен, который переезжает на петлю, после чего запрос
 * к `http://evil.example:7331/projects` для браузера однопроисхожденный. Отсутствие
 * заголовков общего доступа между источниками ответ не удерживает — они управляют чтением
 * ответа чужим источником, а здесь источник для браузера свой. Сам `Host` Node не проверяет
 * никогда. На фазе 2 за этим же адресом встанет терминал с доступом к оболочке машины,
 * и эта проверка станет защитой оболочки.
 *
 * ПОРЯДОК РАБОТЫ ВНУТРИ ЗАПРОСА: сначала эталон — один раз и по СОБСТВЕННОМУ бюджету, затем
 * опрос проектов со СКВОЗНЫМ бюджетом файлов и объёма, с таймаутом на каждый проект и общим
 * бюджетом времени. Иначе тяжёлый чужой каталог в реестре выбирает бюджет целиком, эталон
 * не считается, и `verdict: unknown` получают все проекты сразу.
 *
 * МЕЖДУ ЗАПРОСАМИ НЕ ХРАНИТСЯ НИЧЕГО: ни результатов, ни эталона, ни модулей чужого кода.
 * Кэш здесь — второй источник правды, запрещённый разделом 1.3 контракта.
 *
 * ЗАПИСИ НЕТ. Методов записи не существует; единственная запись демона на диск — время
 * последнего просмотра в СВОЁМ реестре при запросе одного проекта. В `.claude` читаемого
 * проекта не пишется ни байта — это критерий готовности фазы, и доказывает его
 * `pult/tools/no-write-check.mjs`.
 */

import http from 'node:http';
import process from 'node:process';

import {
  HOST, PORT, LAN, HOST_ALLOW, MAX_CONNECTIONS, REQUEST_TIMEOUT_MS, HEADERS_TIMEOUT_MS,
  KEEP_ALIVE_TIMEOUT_MS, MAX_REQUEST_LINE, MAX_CONCURRENT_SCANS, MAX_PROJECTS,
  BUDGET_REQUEST, PROJECT_ID_RE,
} from './config.mjs';
import { makeBudget } from './lib/fs-safe.mjs';
import { readRegistry, touchProject } from './lib/registry.mjs';
import { readReference } from './read/reference.mjs';
import { readProject } from './read/project.mjs';

const PULT_VERSION = '0.1.0';   // держится рядом с манифестом пакета, см. pult/package.json

// Ограничитель одновременности, ОДИН на оба тяжёлых маршрута (`/projects` и `/projects/:id`):
// полный скан синхронный, и второй параллельный только встал бы в очередь на том же потоке.
// Счётчик общий намеренно — маршруты конкурируют за один цикл событий, и раздельные счётчики
// дали бы дыру того же вида. Это НЕ кэш фактов между запросами — счётчик живёт внутри одного
// хода и правилу 1 раздела OVERVIEW не противоречит.
let scanning = 0;

const say = (s) => process.stdout.write(`[pult] ${s}\n`);

/** Заголовки на ВСЕ ответы. Заголовки общего доступа между источниками не выставляются. */
function send(res, code, body) {
  const text = `${JSON.stringify(body, null, 2)}\n`;
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
    'Referrer-Policy': 'no-referrer',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * Происхождение запроса. Возвращает код отказа (`host` или `site`) либо `null`.
 *
 * Два кода различаются ради stdout демона, а не ради ответа: наружу уходит одно слово
 * `forbidden` — какая именно проверка отбила запрос, атакующему знать незачем. А человеку,
 * разбирающему «почему пульт не отвечает браузеру», знать это необходимо, иначе причина
 * не доступна нигде.
 */
function originRefusal(req) {
  const host = req.headers.host;
  if (typeof host !== 'string' || !host || !HOST_ALLOW.includes(host)) return 'host';
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return 'site';
  return null;
}

/** Список проектов: эталон первым и по своему бюджету, затем проекты по сквозному. */
async function collect({ full, only }) {
  const reference = await readReference();
  const registry = await readRegistry();
  const budget = makeBudget(BUDGET_REQUEST);

  let entries = registry.entries;
  if (only) entries = entries.filter((e) => e.id === only);
  const capped = entries.slice(0, MAX_PROJECTS);

  const projects = await Promise.all(
    capped.map((entry) => readProject(entry, { reference, budget, full })),
  );

  const body = {
    generated_at: new Date().toISOString(),
    reference: {
      path: reference.path,
      version: reference.version,
      fingerprint: {
        value: reference.fingerprint.value,
        scan_truncated: reference.fingerprint.scan_truncated,
        reason: reference.fingerprint.reason,
      },
    },
    projects,
  };
  if (registry.faults.length) body.registry_faults = registry.faults;
  // Обрезка СПИСКА ПРОЕКТОВ по потолку, и имя у неё своё. Одно слово `truncated` на три
  // разных смысла в одном ответе (обрезка списка расхождений у проекта, неполный обход
  // у эталона, обрезка списка проектов здесь) — мина под фазу 2: читая поле единообразно,
  // потребитель обязан ошибиться. Оба поля описаны в блоке формы ответа раздела 1.5 контракта.
  if (entries.length > capped.length) body.projects_truncated = true;
  return body;
}

async function route(req, res, url) {
  if (url.pathname === '/health') {
    send(res, 200, { ok: true, pult: PULT_VERSION, node: process.version });
    return;
  }

  if (url.pathname === '/projects') {
    if (scanning >= MAX_CONCURRENT_SCANS) {
      send(res, 503, { error: 'busy' });
      return;
    }
    scanning += 1;
    try {
      send(res, 200, await collect({ full: false, only: null }));
    } finally {
      scanning -= 1;
    }
    return;
  }

  const m = url.pathname.match(/^\/projects\/([^/]+)$/);
  if (m) {
    // Идентификатор из адреса в файловый путь не подставляется НИКОГДА: он лишь сверяется
    // с записями реестра, а путь берётся из записи.
    const id = decodeURIComponent(m[1]);
    if (!PROJECT_ID_RE.test(id)) {
      send(res, 404, { error: 'not_found' });
      return;
    }
    // Тот же ограничитель и тот же счётчик, что у списка: маршрут не легче, а тяжелее —
    // `full: true` дочитывает ещё и задачи проекта. Без него параллельные запросы не шли бы
    // одновременно, а выстраивались в очередь на цикле событий, и `/health` ждал бы за всеми.
    if (scanning >= MAX_CONCURRENT_SCANS) {
      send(res, 503, { error: 'busy' });
      return;
    }
    scanning += 1;
    try {
      const body = await collect({ full: true, only: id });
      if (!body.projects.length) {
        send(res, 404, { error: 'not_found' });
        return;
      }
      // Единственная запись демона — и она в реестр пульта, а не в кит. Внутри ограничителя
      // намеренно: это чтение-правка-запись всего реестра целиком, и тот же счётчик, что
      // разводит обходы, разводит и её. Отпусти его раньше — два запроса разных проектов
      // успели бы вклиниться друг другу между чтением и записью, и одно время просмотра
      // потерялось бы. Цена — 503 держится ещё и на время записи, она меньше цены потери.
      await touchProject(id);
      send(res, 200, body);
    } finally {
      scanning -= 1;
    }
    return;
  }

  send(res, 404, { error: 'not_found' });
}

const server = http.createServer((req, res) => {
  // 1. Происхождение — до маршрутизации и до любого обращения к диску.
  const refusal = originRefusal(req);
  if (refusal) {
    // В stdout — своё машинное слово из двух (`host` / `site`), ни одного чужого значения:
    // сам заголовок сюда не печатается, он пришёл извне.
    say(`отказ по происхождению: ${refusal}`);
    send(res, 403, { error: 'forbidden' });
    return;
  }
  // 2. Метод: записи на этой фазе нет вовсе.
  if (req.method !== 'GET') {
    send(res, 405, { error: 'method_not_allowed' });
    return;
  }
  // 3. Тело: любое непустое — отказ БЕЗ чтения тела.
  const len = Number(req.headers['content-length'] || 0);
  if (len > 0 || req.headers['transfer-encoding']) {
    send(res, 400, { error: 'body_not_allowed' });
    req.socket.end();
    return;
  }
  // 4. Длина строки запроса.
  if (typeof req.url !== 'string' || req.url.length > MAX_REQUEST_LINE) {
    send(res, 400, { error: 'bad_request' });
    return;
  }

  let url;
  try {
    url = new URL(req.url, `http://${HOST}:${PORT}`);
  } catch {
    send(res, 400, { error: 'bad_request' });
    return;
  }

  route(req, res, url).catch((e) => {
    // Общий перехватчик: наружу — фиксированное тело, подробности только в stdout демона.
    say(`внутренняя ошибка: ${(e && (e.code || e.name)) || 'ошибка'}`);
    if (e && e.stack) process.stdout.write(`${e.stack}\n`);
    if (!res.headersSent) send(res, 500, { error: 'internal' });
    else res.end();
  });
});

server.maxConnections = MAX_CONNECTIONS;
server.requestTimeout = REQUEST_TIMEOUT_MS;
server.headersTimeout = HEADERS_TIMEOUT_MS;
server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;

server.on('clientError', (e, socket) => {
  if (socket && !socket.destroyed) socket.destroy();
});

// При выключенном доступе в локальную сеть слушается только петля. Включение — не тумблер
// в коде, а решение вместе с авторизацией (открытый вопрос 2 контракта).
const bindHost = LAN ? '0.0.0.0' : HOST;

server.listen(PORT, bindHost, () => {
  say(`слушаю http://${HOST}:${PORT} (локальная сеть: ${LAN ? 'да' : 'нет'})`);
  say('только чтение: методов записи нет, в .claude проектов не пишется ни байта');
});

server.on('error', (e) => {
  say(`не поднялся: ${(e && (e.code || e.name)) || 'ошибка'}`);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    say('останавливаюсь');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
