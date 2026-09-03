#!/usr/bin/env node
/**
 * Демон пульта: страница рабочего места, чтение проектов, живая сессия и правка файлов.
 *
 *   node pult/server.mjs
 *
 * Маршруты:
 *   GET  /health               состояние самого демона
 *   GET  /pending              что ждёт человека: гейт и активная задача, без обхода отпечатка
 *   GET  /projects             список проектов реестра, каждый — с версией и сверкой отпечатка
 *   GET  /projects/:id         один проект целиком, со списком задач
 *   GET  /projects/:id/tree    содержимое одного каталога проекта (`?dir=`)
 *   GET  /projects/:id/file    содержимое одного файла (`?path=`, `?reveal=1` для секретов)
 *   GET  /projects/:id/diff    список изменённого; с `?path=` — обе стороны одного файла
 *   POST /projects/:id/file    сохранение файла со сверкой токена (ЕДИНСТВЕННЫЙ метод записи)
 *   GET  /                     документ страницы рабочего места
 *   GET  /<файл>               файл страницы из `pult/web` (закрытый словарь расширений)
 *   UPGRADE /ws/pty            сессия псевдотерминала (второй вход, см. ниже)
 *
 * Страница отдаётся ОТДЕЛЬНЫМ путём ответа (`pult/lib/static.mjs`): `send()` ниже ставит
 * на все ответы тип JSON и политику `default-src 'none'`, и для машинного ответа это верно,
 * а для страницы означало бы «ничего не грузить и ничего не выполнять».
 *
 * ПРОВЕРКА ПРОИСХОЖДЕНИЯ ЖИВЁТ В `pult/lib/origin.mjs` — одна на ДВА ВХОДА В ДЕМОН, и входа
 * действительно два: обычный запрос и событие `upgrade`. В обоих она зовётся ПЕРВЫМ ДЕЛОМ,
 * до маршрутизации, до разбора адреса и до любого обращения к диску. Заголовок `Host` обязан
 * точно совпасть с одним из закрытого списка; `Sec-Fetch-Site`, если он есть, обязан быть
 * `same-origin` или `none` (отсутствие законно — консольные клиенты его не шлют); на апгрейде
 * к ним добавляется `Origin` (браузер шлёт его на рукопожатии всегда, и именно браузер здесь
 * угроза).
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
 * ЗАПИСЬ ПОЯВИЛАСЬ, И ОНА ОДНА: `POST /projects/:id/file` — сохранение файла проекта
 * со сверкой токена. Всё, что её ограничивает, живёт не здесь: путь проверяет шлюз
 * `resolveTarget()` в `pult/lib/fs-safe.mjs`, запись ведёт `saveProjectFile()`
 * в `pult/write/file.mjs`. Отсюда следствие, которое надо держать в голове при любой правке
 * этого файла: гарантия «в набор не пишем» стала ПРОВЕРОЧНОЙ, а не структурной — раньше её
 * держало отсутствие методов записи. Меряет её `pult/tools/write-scope-check.mjs`
 * (по проекту целиком), а прежнее доказательство `pult/tools/no-write-check.mjs` остаётся
 * верным по своей узкой формулировке — оно про дерево `.claude`.
 *
 * Вторая запись демона — время последнего просмотра в СВОЁМ реестре при запросе одного
 * проекта; она была и на фазе 1 и в кит не идёт.
 *
 * ФАЗА 3 ДОБАВЛЯЕТ ОДИН МАРШРУТ И ОДНУ ПРОВЕРКУ, И БОЛЬШЕ НИЧЕГО. Маршрут `GET /pending`
 * лёгкий и на чтение; методов записи по-прежнему ОДИН, правило «любое непустое тело — отказ»
 * не ослабляется второй раз, а маршрута, принимающего путь проекта из запроса, у демона нет
 * и быть не должно. Проверка — отказ по отвергнутому корню записи реестра: она стоит ОДНА
 * на все маршруты пути (дерево, файл, дифф, сохранение), потому что четыре копии одной
 * проверки расходятся при первой правке.
 */

import http from 'node:http';
import process from 'node:process';

import {
  HOST, PORT, LAN, MAX_CONNECTIONS, REQUEST_TIMEOUT_MS, HEADERS_TIMEOUT_MS,
  KEEP_ALIVE_TIMEOUT_MS, MAX_REQUEST_LINE, MAX_CONCURRENT_SCANS, MAX_PROJECTS,
  BUDGET_REQUEST, PROJECT_ID_RE, WS_PATH, MAX_SESSIONS, MAX_BODY_BYTES, FAULT,
  MAX_CONCURRENT_PENDING,
} from './config.mjs';
import { makeBudget, capText } from './lib/fs-safe.mjs';
import { requestRefusal, upgradeRefusal } from './lib/origin.mjs';
import { serveStatic } from './lib/static.mjs';
import { readRegistry, touchProject } from './lib/registry.mjs';
import { readReference } from './read/reference.mjs';
import { readProject } from './read/project.mjs';
import { readPending } from './read/pending.mjs';
import { readTree } from './read/tree.mjs';
import { readProjectFile } from './read/file.mjs';
import { saveProjectFile } from './write/file.mjs';
import { changedFiles, fileSides } from './lib/git.mjs';
import { wsServer, bridge } from './lib/pty-socket.mjs';
import { hookExit } from './lib/pty.mjs';

// Держится рядом с манифестом пакета (`pult/package.json`) и ОБЯЗАН с ним совпадать: по этому
// полю оболочка фазы 3 распознаёт чужой ответ на своём порту, поэтому значение обязано
// оставаться разбираемым как версия — «число.число.число» и ничего больше.
//
// ФАЗА 4 ПОДНЯЛА НОМЕР, НО НЕ ТРОНУЛА ПОВЕРХНОСТЬ ДЕМОНА, и это стоит записать рядом:
// новых маршрутов она не завела ни одного, метод записи по-прежнему ОДИН
// (`POST /projects/:id/file`), а тела запросов у остальных маршрутов по-прежнему отбиваются.
// Всё, что фаза 4 добавила, — это чтение (запись о раскладке и сверка по составу) и работа
// ОБОЛОЧКИ подпроцессами: раскладку, снос и команды набора запускает она, а не демон.
const PULT_VERSION = '0.4.0';

// Ограничитель одновременности, ОДИН на оба тяжёлых маршрута (`/projects` и `/projects/:id`):
// полный скан синхронный, и второй параллельный только встал бы в очередь на том же потоке.
// Счётчик общий намеренно — маршруты конкурируют за один цикл событий, и раздельные счётчики
// дали бы дыру того же вида. Это НЕ кэш фактов между запросами — счётчик живёт внутри одного
// хода и правилу 1 раздела OVERVIEW не противоречит.
let scanning = 0;

// СВОЙ ограничитель у маршрута ожиданий, а не общий с обходом отпечатка. Причины две.
// Первая: собственный бюджет маршрута ограничивает ОДИН вызов, а не частоту, — а звать его
// может любой локальный клиент, не только наш опрос раз в минуту, и сотня параллельных
// вызовов сложилась бы в сотню бюджетов на одном цикле событий. Вторая: счётчик обходов
// держит СИНХРОННУЮ работу, и вешать на него лёгкий асинхронный маршрут значит гасить их
// друг о друга. Это тоже не кэш фактов между запросами — счётчик живёт внутри одного хода.
let pendingCalls = 0;

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

/**
 * Код отказа в состояние ответа HTTP.
 *
 * КОД ИЗ ЗАКРЫТОГО СЛОВАРЯ УЕЗЖАЕТ КЛИЕНТУ КАК ЕСТЬ — он и есть машинная причина; таблица
 * ниже подбирает только число состояния, потому что без него ответа не бывает. Умолчание —
 * 403: причин отказа больше, чем осмысленных чисел, и притворяться, что каждая имеет своё,
 * значило бы врать о смысле.
 */
const FAULT_STATUS = Object.freeze({
  [FAULT.PATH_UNREACHABLE]: 404,
  [FAULT.NOT_PLAIN_FILE]: 404,
  [FAULT.FILE_TOO_BIG]: 413,
  [FAULT.BODY_TOO_BIG]: 413,
  [FAULT.BAD_BODY]: 400,
  [FAULT.FILE_CHANGED]: 409,
  [FAULT.READ_TIMEOUT]: 504,
  [FAULT.GIT_UNAVAILABLE]: 503,
  [FAULT.GIT_FAILED]: 503,
});

const statusFor = (code) => FAULT_STATUS[code] || 403;

/**
 * Чтение: дерево каталога, содержимое файла, дифф задачи.
 *
 * Относительный путь приходит ПАРАМЕТРОМ ЗАПРОСА и передаётся читателям без склейки строк:
 * все проверки пути живут в шлюзе `resolveTarget()` в `pult/lib/fs-safe.mjs`, и свой порядок
 * проверок здесь был бы второй гарантией, которая при первой правке сойдётся по слабой.
 *
 * У маршрута файла есть ЯВНЫЙ ПРИЗНАК «отдать файл, попавший под образец секрета»: без него
 * читатель отдаёт отказ, с ним — содержимое и строка в stdout. Умолчание закрытое намеренно
 * (набор уже решил это правилами `deny`), но это умолчание, а не стена.
 */
async function routeRead(req, res, url, kind, entry) {
  if (kind === 'tree') {
    const result = await readTree(entry.path, url.searchParams.get('dir') || '');
    send(res, result.ok ? 200 : statusFor(result.code), result);
    return;
  }

  if (kind === 'file') {
    const rel = url.searchParams.get('path') || '';
    const reveal = url.searchParams.get('reveal') === '1';
    const result = await readProjectFile(entry.path, rel, { reveal });
    if (result.ok && reveal && result.secret) {
      // Осознанное действие обязано быть видимым. В строку идёт присланный относительный путь
      // через очистку свободного текста: печатать в свой stdout чужую строку как есть —
      // та же ошибка, что печатать чужой заголовок.
      say(`отдан файл под образцом секрета: проект ${entry.id}, ${capText(rel, 200).text}`);
    }
    send(res, result.ok ? 200 : statusFor(result.code), result);
    return;
  }

  // Дифф: без пути — список изменённого для вкладки, с путём — ОБЕ СТОРОНЫ одного файла.
  // Обе отдаёт демон (`fileSides()` в `pult/lib/git.mjs`), а не страница: там `--`, потолки,
  // фильтр секретов и ключи `--no-ext-diff --no-textconv`.
  const rel = url.searchParams.get('path');
  const result = rel === null
    ? await changedFiles(entry.path)
    : await fileSides(entry.path, rel);
  send(res, result.ok ? 200 : statusFor(result.code), result);
}

/**
 * ПЕРВЫЙ МЕТОД ЗАПИСИ У ДЕМОНА, и общая проверка «любое непустое тело — отказ» здесь
 * ослаблена ТОЧЕЧНО: тело читается только на этом маршруте и только при типе содержимого
 * `application/json`.
 *
 * Требование типа — не формальность: оно заставляет браузер делать предварительный запрос,
 * а заголовков общего доступа между источниками демон не отдаёт; вместе со сверкой
 * происхождения это закрывает подделку запроса с чужой страницы.
 *
 * ОБЪЁМ СЧИТАЕТСЯ НА ЛЕТУ И РВЁТ СОЕДИНЕНИЕ при превышении потолка: `Content-Length` —
 * заявление клиента, а не доказательство.
 *
 * Разобранный объект НЕ СЛИВАЕТСЯ ни с чем: три поля переносятся ПОИМЁННО и проверяются
 * каждое по своей форме, лишнее игнорируется. Коды отказа уезжают клиенту как есть, в том
 * числе «запись в проект без набора» (`write_no_kit`): проект без папки `.claude` закрыт
 * на запись целиком по правилу шлюза, и клиент обязан получить именно эту причину, иначе
 * штатное состояние реестра читается как поломка демона и «чинится» ослаблением шлюза.
 * Тем же порядком уезжает `write_into_secret`: файл под образцом секрета закрыт на запись
 * насовсем, и признака, симметричного `reveal` у чтения, у этого маршрута нет намеренно.
 */
async function routeSave(req, res, entry) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') {
    send(res, 415, { ok: false, code: FAULT.BAD_BODY });
    req.socket.end();
    return;
  }

  const body = await new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // РАЗРЫВ, А НЕ ОТВЕТ, — так требует шаг 17 плана, и отсюда следствие, которое надо
        // назвать: код `body_too_big` клиенту НЕ ДОЕЗЖАЕТ НИКОГДА, а `FAULT_STATUS` с его
        // 413 через ЭТОТ маршрут недостижим по построению. Запись в разрушенный сокет молча
        // выбрасывается, и клиент видит обрыв (curl — код 56). Ждать 413 в ручном сценарии
        // бессмысленно; если когда-нибудь понадобится именно ответ, разрыв придётся отложить
        // до его отправки, и это будет другое решение, а не «починка» этого (замечание ревью
        // фазы 2).
        finish({ ok: false, code: FAULT.BODY_TOO_BIG });
        req.socket.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('aborted', () => finish({ ok: false, code: FAULT.BAD_BODY }));
    req.on('error', () => finish({ ok: false, code: FAULT.BAD_BODY }));
    req.on('end', () => finish({ ok: true, buf: Buffer.concat(chunks) }));
  });
  if (!body.ok) {
    if (!res.headersSent) send(res, statusFor(body.code), { ok: false, code: body.code });
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(body.buf.toString('utf8'));
  } catch {
    send(res, 400, { ok: false, code: FAULT.BAD_BODY });
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    send(res, 400, { ok: false, code: FAULT.BAD_BODY });
    return;
  }
  // Поля переносятся ПОИМЁННО — так же, как это делает `parseEntry()` в `pult/lib/registry.mjs`.
  const rel = typeof parsed.path === 'string' ? parsed.path : null;
  const text = typeof parsed.text === 'string' ? parsed.text : null;
  const token = typeof parsed.token === 'string' ? parsed.token : null;
  if (rel === null || text === null || token === null) {
    send(res, 400, { ok: false, code: FAULT.BAD_BODY });
    return;
  }

  const result = await saveProjectFile(entry.path, rel, text, token, { projectId: entry.id });
  send(res, result.ok ? 200 : statusFor(result.code), result);
}

async function route(req, res, url) {
  if (url.pathname === '/health') {
    send(res, 200, { ok: true, pult: PULT_VERSION, node: process.version });
    return;
  }

  // ЛЁГКИЙ МАРШРУТ ОЖИДАНИЙ — сразу после здоровья и ДО списка проектов: он зовётся
  // по расписанию, и путать его со списком нельзя ни человеку, ни читателю кода. Он НИЧЕГО
  // НЕ ПИШЕТ, и это записано здесь намеренно: соблазн отметить просмотр по расписанию
  // появится у первого же читателя, а отметка по таймеру превратила бы «время последнего
  // просмотра» во «время работы оболочки». Потолок числа проектов — тот же, что у списка,
  // и держит его сам читатель (`readPending()` в `pult/read/pending.mjs`).
  if (url.pathname === '/pending') {
    if (pendingCalls >= MAX_CONCURRENT_PENDING) {
      send(res, 503, { error: 'busy' });
      return;
    }
    pendingCalls += 1;
    try {
      send(res, 200, await readPending());
    } finally {
      pendingCalls -= 1;
    }
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
      // Отметка просмотра ставится и ОТВЕРГНУТОЙ записи, и это намеренно: обращения к диску
      // проекта здесь нет вовсе (читатель проекта вернулся состоянием «корень отвергнут»),
      // а особый случай ради вида завёл бы вторую ветвь на пустом месте.
      //
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

  // Дерево, файл, дифф и сохранение — под идентификатором проекта. Ограничитель
  // одновременности сюда НЕ вешается намеренно: он держит синхронный обход отпечатка,
  // а эти маршруты асинхронные и лёгкие; зато у каждого свой потолок из констант (размер
  // файла, число записей каталога, длина относительного пути, объём диффа).
  const sub = url.pathname.match(/^\/projects\/([^/]+)\/(tree|file|diff)$/);
  if (sub) {
    const id = decodeURIComponent(sub[1]);
    if (!PROJECT_ID_RE.test(id)) {
      send(res, 404, { error: 'not_found' });
      return;
    }
    // ПУТЬ ПРОЕКТА БЕРЁТСЯ ИЗ ЗАПИСИ РЕЕСТРА, идентификатор в файловый путь не подставляется.
    const registry = await readRegistry();
    const entry = registry.entries.find((e) => e.id === id);
    if (!entry) {
      send(res, 404, { error: 'not_found' });
      return;
    }
    // ОТКАЗ ПО ОТВЕРГНУТОМУ КОРНЮ — ОДИН НА ВСЕ ЧЕТЫРЕ МАРШРУТА (дерево, файл, дифф,
    // сохранение) и ДО вызова любого читателя и любой записи. Раскладывать его по читателям
    // значит завести четыре места, которые разойдутся. Пометка берётся из записи реестра,
    // корень заново не считается. Число состояния подбирается той же таблицей, что и у прочих
    // отказов, — умолчание 403; код уезжает клиенту как есть.
    if (entry.rejected) {
      send(res, statusFor(entry.rejected), { ok: false, code: entry.rejected });
      if (req.method === 'POST') req.socket.end();
      return;
    }
    if (req.method === 'POST') {
      await routeSave(req, res, entry);
      return;
    }
    await routeRead(req, res, url, sub[2], entry);
    return;
  }

  // Страница — ПОСЛЕ всех маршрутов API и ДО общего 404. Корень адреса отдаёт документ,
  // всё прочее ищется в каталоге страницы; чужое расширение и выход за каталог дают 404.
  // Ограничитель одновременности сюда не вешается: раздача статики асинхронная и лёгкая,
  // а счётчик держит синхронный обход отпечатка.
  if (await serveStatic(res, url.pathname)) return;

  // Тело у метода записи, не попавшего на свой маршрут, осталось непрочитанным — соединение
  // закрывается, иначе клиент ждёт приёма того, что мы читать не собираемся.
  if (req.method !== 'GET') {
    send(res, 405, { error: 'method_not_allowed' });
    req.socket.end();
    return;
  }
  send(res, 404, { error: 'not_found' });
}

const server = http.createServer((req, res) => {
  // 1. Происхождение — до маршрутизации и до любого обращения к диску.
  const refusal = requestRefusal(req);
  if (refusal) {
    // В stdout — своё машинное слово из двух (`host` / `site`), ни одного чужого значения:
    // сам заголовок сюда не печатается, он пришёл извне.
    say(`отказ по происхождению: ${refusal}`);
    send(res, 403, { error: 'forbidden' });
    return;
  }
  // Единственный маршрут с телом — сохранение файла. Признак считается по СЫРОЙ строке
  // запроса, без разбора адреса и без обращения к диску: он нужен двум проверкам ниже,
  // а они стоят до разбора намеренно. Строка сырая, поэтому признак — только предположение:
  // окончательно маршрут решает `route()` по разобранному адресу, и POST, туда не попавший,
  // получает 405 с закрытием соединения.
  const rawPath = typeof req.url === 'string' ? req.url.split('?')[0] : '';
  const save = req.method === 'POST' && /^\/projects\/[^/]+\/file$/.test(rawPath);

  // 2. Метод: кроме сохранения файла, методов записи у демона нет.
  if (!save && req.method !== 'GET') {
    send(res, 405, { error: 'method_not_allowed' });
    return;
  }
  // 3. Тело: любое непустое — отказ БЕЗ чтения тела. Ослабление ТОЧЕЧНОЕ — только маршрут
  //    сохранения, только он читает тело, и только по своему потолку и своему типу.
  const len = Number(req.headers['content-length'] || 0);
  if (!save && (len > 0 || req.headers['transfer-encoding'])) {
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

/**
 * ВТОРОЙ ВХОД В ДЕМОН. Обработчик обычного запроса и событие `upgrade` — РАЗНЫЕ точки:
 * маршрутизатор до второй не доходит, а за адресом вебсокета стоит оболочка машины. Слушатель
 * здесь ЕДИНСТВЕННЫЙ и свой: сервер вебсокета взят в форме `noServer`, и никакая библиотека
 * своего слушателя на него не вешает.
 *
 * Порядок жёсткий и переставлять его нельзя: происхождение → путь → ограничитель → и только
 * потом доведение рукопожатия. Отказ — уничтожение сокета БЕЗ рукопожатия и одно машинное
 * слово в stdout.
 */
let upgrades = 0;

server.on('upgrade', (req, socket, head) => {
  // 1. ПРОИСХОЖДЕНИЕ — ПЕРВОЙ СТРОКОЙ, до разбора адреса и до подъёма чего-либо.
  const refusal = upgradeRefusal(req);
  if (refusal) {
    say(`отказ по происхождению (апгрейд): ${refusal}`);
    socket.destroy();
    return;
  }

  // 2. Путь: единственный, и он из констант.
  let url;
  try {
    url = new URL(req.url, `http://${HOST}:${PORT}`);
  } catch {
    socket.destroy();
    return;
  }
  if (url.pathname !== WS_PATH) {
    say('отказ по адресу вебсокета');
    socket.destroy();
    return;
  }

  // 3. Ограничитель числа соединений: за каждым стоит процесс, и потолок у них общий.
  if (upgrades >= MAX_SESSIONS) {
    say('отказ: потолок соединений вебсокета');
    socket.destroy();
    return;
  }

  // ТОЛЬКО ПОСЛЕ ТРЁХ ПРОВЕРОК — рукопожатие и мост.
  wsServer.handleUpgrade(req, socket, head, (ws) => {
    upgrades += 1;
    ws.on('close', () => { upgrades -= 1; });
    bridge(ws, url).catch((e) => {
      say(`мост не поднялся: ${(e && (e.code || e.name)) || 'ошибка'}`);
      try { ws.close(1011, 'internal'); } catch { /* сокет уже мёртв */ }
    });
  });
});

server.maxConnections = MAX_CONNECTIONS;
server.requestTimeout = REQUEST_TIMEOUT_MS;
server.headersTimeout = HEADERS_TIMEOUT_MS;
server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;

server.on('clientError', (e, socket) => {
  if (socket && !socket.destroyed) socket.destroy();
});

// ЕДИНСТВЕННАЯ новая проверка при старте фазы 2, и она машинная намеренно. Пока за этим
// адресом стоит псевдотерминал с доступом к оболочке машины, решение «только петля» дешевле
// держать кодом, чем комментарием: включение сети обязано требовать осознанной правки вместе
// с авторизацией (фаза 5), а не смены одной буквы в константе.
if (LAN === true) {
  say('включение локальной сети требует авторизации, она в фазе 5');
  say('демон не поднят: верните LAN в false в pult/config.mjs');
  process.exit(1);
}

// Слушается только петля. Открытый вопрос 2 контракта закрыт решением человека 01.09.2026:
// пин-код, телефон и выход в сеть уехали в фазу 5 целиком.
const bindHost = HOST;

// Сессии псевдотерминала умирают вместе с демоном: обработчики `SIGINT`/`SIGTERM` и `exit`
// вешает `hookExit()` в `pult/lib/pty.mjs`. Оговорка про Windows — там же: `SIGTERM` не
// доставляется ни при закрытии окна консоли, ни при `taskkill`.
hookExit();

server.listen(PORT, bindHost, () => {
  say(`слушаю http://${HOST}:${PORT} (локальная сеть: нет, включение — фаза 5)`);
  say(`вебсокет: ${WS_PATH} (сверка происхождения на апгрейде, форма noServer)`);
  say('в .claude проектов не пишется ни байта; запись — только в файлы проекта по сверке токена');
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
