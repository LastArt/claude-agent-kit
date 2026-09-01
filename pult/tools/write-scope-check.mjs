#!/usr/bin/env node
/**
 * Доказательство ГРАНИЦЫ ЗАПИСИ демона: по проекту целиком, а не по одной папке `.claude`.
 *
 *   node pult/tools/write-scope-check.mjs [каталог для стендов]
 *
 * ГРАНИЦА УТВЕРЖДЕНИЯ, и она первая не случайно: инструмент меряет записи ДЕМОНА, а не его
 * ПОТОМКОВ. Сессия псевдотерминала запускает чужой процесс, которому писать куда угодно —
 * его работа; приписать его записи демону значило бы врать зелёным или красным наугад.
 * Поэтому сессия в сценарии поднимается пустой: вид, про который известно, что сам он ничего
 * не пишет, и НИ ОДНОЙ команды в неё не отправляется — меряется сам подъём.
 *
 * СТЕНД, А НЕ ЖИВОЙ ПРОЕКТ. Снимок настоящего проекта с зависимостями и историей упирался бы
 * в потолок числа файлов на каждом прогоне, а инструмент, который всегда красный, перестают
 * запускать. Поэтому каждый прогон разворачивает СВОИ стенды во временном каталоге ОС и после
 * себя убирает; каталог можно передать аргументом, но он обязан быть вне этого репозитория.
 *
 * СТЕНДОВ ДВА, И ВТОРОЙ НЕ РОСКОШЬ: первый с папкой `.claude`, второй — БЕЗ неё. Проект без
 * набора закрыт на запись целиком (состояние `no_kit`, код `write_no_kit`), и на стенде
 * с набором эта ветвь не меряется вовсе. Состояние штатное для реестра, а не краевое, и
 * непроверенным оставлять его нельзя.
 *
 * СТЕНДЫ ЗАВОДЯТСЯ В РЕЕСТР: демон знает проекты только из реестра, а дописывать ему маршрут,
 * принимающий путь проекта из запроса, запрещено в любом виде — такой маршрут и есть способ
 * обойти всё разом. Реестр на время прогона СВОЙ: каталог настроек подменяется временным
 * (`APPDATA` / `XDG_CONFIG_HOME`) и демону передаётся тот же. Причина ровно одна и она
 * практическая: боевой реестр — список проектов человека, и прогон, оборвавшийся посередине,
 * оставил бы в нём чужие записи. Свойство «демон знает проекты только из реестра» при этом
 * не ослаблено ни на букву — реестр читается тот, который мы подготовили.
 *
 * ДЕМОН ПОДНИМАЕТСЯ САМ И ТОЛЬКО ЧЕРЕЗ `process.execPath`: имя `node` разрешалось бы поиском
 * по путям, а это ровно та дыра, от которой заведена дверь `resolveCommand()`
 * в `pult/lib/fs-safe.mjs`. Порт занят кем-то другим — прогон не начинается: чужой демон
 * читает чужой реестр, и мерить его нечестно.
 *
 * ЧТО ИЗ СНИМКА ИСКЛЮЧЕНО — ПЕЧАТАЕТСЯ. `.git` (её переписывает сам git) и пути, игнорируемые
 * по `.gitignore` (это чужая работа), в снимок не входят, и число исключённых путей печатается
 * строкой: непронаблюдённое называется, а не умалчивается. Снимок берётся ПО РОДИТЕЛЮ стендов,
 * а не по самим стендам, — дешёвая страховка на случай, если запись ушла уровнем выше.
 * Потолок числа файлов поднят осознанно (`MAX_SNAPSHOT_FILES` ниже, 50 000 против 20 000
 * у прежнего инструмента): здесь наблюдается проект целиком, а не одна его папка.
 *
 * ОЖИДАНИЯ РАЗДЕЛЬНЫЕ. Внутри `.claude` любое расхождение — АВАРИЯ и код возврата 1. Вне
 * `.claude` расхождением считается всё, кроме файла, который сценарий сохранял намеренно,
 * и такие пути печатаются для разбора глазами. На стенде без набора не сохраняется ничего
 * намеренно, поэтому ЛЮБОЙ новый файл в его снимке — расхождение.
 *
 * ВЕТВЬ СЕКРЕТА МЕРИТСЯ ДВАЖДЫ, и это не дубль: на стенде с набором лежит `.env` (строка
 * внутри выдуманная), и проверяются ОБЕ его стороны — попытка сохранения обязана вернуть
 * `write_into_secret`, а дерево обязано отдать по нему `secret: true` вместе с
 * `writable: false`. Одного отказа маршрута мало: кнопку сохранения страница рисует
 * по признаку из дерева, и разъехавшись, эти две стороны дают активную кнопку на файле
 * секретов. Обе ветви заведены по находке ревью фазы 2 — до неё запись в `.env` не мерилась
 * ничем и не ограничивалась ничем.
 *
 * УБОРКА ТЕРПИТ ЗАНЯТОСТЬ И ГОВОРИТ ОБ ЭТОМ СТРОКОЙ, а не роняет прогон: сессия после
 * отключения клиента живёт пять минут, действия «закрыть сессию» в фазе нет, а на Windows
 * каталог с живым рабочим каталогом процесса не удаляется. Не удалилось — печатается строка
 * «стенд занят, удалить вручную» с путём, и код возврата от этого не меняется.
 *
 * ЧЕСТНАЯ ОГОВОРКА ТЕМ ЖЕ ТОНОМ, ЧТО У ПРЕЖНЕГО ИНСТРУМЕНТА: снимок видит только ОБЫЧНЫЕ
 * ФАЙЛЫ, поэтому созданный демоном КАТАЛОГ в него не попадёт вовсе, как и НЕДОЛГОВЕЧНЫЙ файл,
 * созданный и удалённый между двумя снимками. Настоящее доказательство границы записи —
 * разбор кода: единственный шлюз `resolveTarget()` в `pult/lib/fs-safe.mjs`, через который
 * обязана проходить каждая запись. Этот прогон — ПОДПОРКА к разбору, а не замена ему.
 *
 * Инструмент читает и пишет диск напрямую (`node:fs/promises`) намеренно: он не часть демона,
 * и правило «только примитивы `pult/lib/fs-safe.mjs`» относится к читателям, чьё содержимое
 * уезжает в HTTP-ответ. Наружу отсюда не уходит ничего, кроме строк в консоли.
 *
 * Коды возврата: 0 — расхождений нет; 1 — расхождение или отказ пришёл не своим кодом;
 * 3 — прогон ничего не доказывает (порт занят, демон не ответил, снимок усечён).
 */

import { mkdtemp, mkdir, writeFile, readdir, lstat, readFile, rm, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

import { WebSocket } from 'ws';

import { HOST, PORT, HOST_ALLOW, WS_PATH, FAULT } from '../config.mjs';
import { addProject, readRegistry } from '../lib/registry.mjs';
import { checkIgnored } from '../lib/git.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..', 'server.mjs');
const REPO = path.resolve(HERE, '..', '..');

// Потолок ПОДНЯТ ОСОЗНАННО: наблюдается проект целиком, а не одна папка настроек.
const MAX_SNAPSHOT_FILES = 50000;
const DAEMON_START_MS = 15000;
const SESSION_MS = 2000;

const out = (s = '') => process.stdout.write(`${s}\n`);
const err = (s = '') => process.stderr.write(`[pult] ${s}\n`);

// --- стенды ------------------------------------------------------------------

/**
 * Развернуть два стенда в одном родителе: с набором и без него.
 *
 * Симлинк наружу заводится ТОЛЬКО символической ссылкой на ФАЙЛ: именно она даёт отдельный
 * код отказа (`target_not_plain_file`), а каталожная точка соединения дала бы тот же код,
 * что и путь с двумя точками, и случай перестал бы что-либо различать. Нет привилегии —
 * случай называется пропущенным, а не подменяется похожим.
 */
async function makeStands(parent) {
  const withKit = path.join(parent, 'project');
  const noKit = path.join(parent, 'bare');
  const outside = path.join(parent, 'outside');

  await mkdir(path.join(withKit, '.claude'), { recursive: true });
  await mkdir(path.join(withKit, 'sub'), { recursive: true });
  await mkdir(noKit, { recursive: true });
  await mkdir(outside, { recursive: true });

  await writeFile(path.join(withKit, 'a.txt'), 'первая строка\nвторая строка\n');
  await writeFile(path.join(withKit, 'sub', 'b.txt'), 'вложенный файл\n');
  // Файл под образцом секрета. Строка внутри — ВЫДУМАННАЯ ПУСТЫШКА: настоящих секретов
  // в стенд не попадает ни одного, а мерится здесь не содержимое, а отказ записи.
  await writeFile(path.join(withKit, '.env'), 'PULT_STAND_TOKEN=строка-пустышка\n');
  await writeFile(path.join(withKit, '.claude', 'VERSION'), '1.0.0\n');
  await writeFile(path.join(withKit, '.claude', 'settings.json'), '{}\n');
  await writeFile(path.join(noKit, 'c.txt'), 'проект без набора\n');
  await writeFile(path.join(outside, 'target.txt'), 'файл вне проекта\n');

  let link = null;
  try {
    await symlink(path.join(outside, 'target.txt'), path.join(withKit, 'link.txt'), 'file');
    link = 'link.txt';
  } catch {
    link = null;
  }
  return { withKit, noKit, outside, link };
}

// --- снимок ------------------------------------------------------------------

/**
 * Снимок дерева: относительный путь — метка изменения, размер, хеш содержимого.
 *
 * `.git` и игнорируемое по `.gitignore` в снимок не входят, число исключённых возвращается
 * наружу и печатается. Игнорируемость спрашивается у git ПОРЦИЕЙ НА КАТАЛОГ и через модуль
 * демона (`checkIgnored()` в `pult/lib/git.mjs`), то есть с `--no-optional-locks` и служебным
 * окружением: наблюдатель не имеет права сам менять то, что наблюдает.
 */
async function snapshot(root) {
  const map = new Map();
  let truncated = false;
  let excluded = 0;
  // Подтвердил ли git проверку игнорируемости хоть раз. Ноль исключённых путей означает
  // РАЗНОЕ: «ничего не игнорируется» и «git не ответил», — и молчать об этой разнице нельзя.
  let ignoreChecked = false;

  const walk = async (dir, rel) => {
    if (truncated) return;
    let names = [];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    const visible = [];
    for (const name of names.sort()) {
      if (name === '.git') { excluded += 1; continue; }
      visible.push(name);
    }
    const ign = await checkIgnored(root, rel, visible);
    if (ign.checked === true) ignoreChecked = true;
    for (const name of visible) {
      if (truncated) return;
      const relPath = rel ? `${rel}/${name}` : name;
      if (ign.ignored.has(relPath)) { excluded += 1; continue; }
      const abs = path.join(dir, name);
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
  return { map, truncated, excluded, ignoreChecked };
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

// --- разговор с демоном ------------------------------------------------------

/** Один запрос с корректным заголовком `Host`: без него демон ответит 403 и прогон ничего не докажет. */
function ask(method, pathname, body) {
  return new Promise((resolve) => {
    const headers = { Host: HOST_ALLOW[0] };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request({ host: HOST, port: PORT, path: pathname, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

const save = (id, rel, text, token) => ask('POST', `/projects/${id}/file`, JSON.stringify({ path: rel, text, token }));

/**
 * Поднять сессию и закрыть её, НЕ ОТПРАВИВ НИ ОДНОЙ КОМАНДЫ.
 *
 * Этого достаточно: меряется сам подъём — рабочий каталог, окружение, конпти. Всё, что
 * человек напечатает в живом терминале дальше, — работа его процесса, а не демона, и границу
 * утверждения инструмента она не пересекает.
 */
function pokeSession(id) {
  return new Promise((resolve) => {
    let ws;
    try {
      ws = new WebSocket(`ws://${HOST}:${PORT}${WS_PATH}?project=${id}&kind=shell`, {
        origin: `http://${HOST}:${PORT}`,
      });
    } catch {
      resolve('сессия не открылась (конструктор)');
      return;
    }
    let opened = false;
    const stop = (r) => { try { ws.close(); } catch { /* уже закрыт */ } resolve(r); };
    ws.on('open', () => { opened = true; setTimeout(() => stop('поднята и отпущена'), SESSION_MS); });
    ws.on('error', (e) => resolve(`не поднялась (${(e && e.message) || 'ошибка'})`));
    ws.on('close', () => { if (!opened) resolve('закрыта до открытия'); });
    setTimeout(() => { if (!opened) stop('таймаут подъёма'); }, DAEMON_START_MS);
  });
}

/** Дождаться ответа демона. Не ответил — прогон ничего не доказывает. */
async function waitHealth(deadline) {
  while (Date.now() < deadline) {
    const r = await ask('GET', '/health');
    if (r.status === 200) return true;
    await new Promise((r2) => { setTimeout(r2, 200); });
  }
  return false;
}

// --- прогон ------------------------------------------------------------------

async function main() {
  const arg = process.argv[2];
  if (arg !== undefined && (arg === '--help' || arg === '-h')) {
    out('Доказательство границы записи демона:');
    out('  node pult/tools/write-scope-check.mjs [каталог для стендов]');
    return 0;
  }
  const base = arg ? path.resolve(arg) : os.tmpdir();
  // Стенд внутри этого репозитория запрещён: снимок увидел бы работу агента и хуков, и прогон
  // стал бы всегда красным — а инструмент, который всегда красный, перестают запускать.
  if (base === REPO || base.startsWith(`${REPO}${path.sep}`)) {
    err('каталог стендов обязан быть ВНЕ этого репозитория');
    return 3;
  }

  const already = await ask('GET', '/health');
  if (already.status !== 0) {
    err(`порт ${PORT} уже занят: остановите свой демон — чужой читает чужой реестр`);
    return 3;
  }

  // Каждый прогон разворачивает СВОЙ каталог: прошлый не переиспользуется никогда.
  const parent = await mkdtemp(path.join(base, 'pult-scope-'));
  // Реестр прогона лежит ОТДЕЛЬНО от стендов: демон пишет в него время просмотра, и попади
  // он под снимок — каждый прогон видел бы собственную запись как расхождение.
  const cfg = await mkdtemp(path.join(base, 'pult-cfg-'));
  process.env.APPDATA = cfg;
  process.env.XDG_CONFIG_HOME = cfg;

  const stands = await makeStands(parent);
  out(`стенды: ${parent}`);
  out(`  с набором : ${path.basename(stands.withKit)}`);
  out(`  без набора: ${path.basename(stands.noKit)}`);
  out(stands.link
    ? '  ссылка наружу: заведена (символическая ссылка на файл)'
    : '  ссылка наружу: СЛУЧАЙ ПРОПУЩЕН — нет привилегии создания символической ссылки');

  const addKit = await addProject(stands.withKit, 'стенд с набором');
  const addBare = await addProject(stands.noKit, 'стенд без набора');
  if (!addKit.ok || !addBare.ok) {
    err('стенды не завелись в реестр прогона');
    return 3;
  }
  const idKit = addKit.entry.id;
  const idBare = addBare.entry.id;
  out(`реестр прогона: ${(await readRegistry()).file}`);

  const daemon = spawn(process.execPath, [SERVER], {
    cwd: path.dirname(SERVER),
    env: { ...process.env, APPDATA: cfg, XDG_CONFIG_HOME: cfg },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const daemonLog = [];
  daemon.stdout.on('data', (c) => daemonLog.push(c.toString('utf8')));
  daemon.stderr.on('data', (c) => daemonLog.push(c.toString('utf8')));

  let code = 0;
  const notes = [];
  try {
    if (!await waitHealth(Date.now() + DAEMON_START_MS)) {
      err('демон не ответил — прогон ничего не доказывает');
      err(daemonLog.join('').split('\n').slice(0, 5).join('\n'));
      return 3;
    }

    const before = await snapshot(parent);
    if (before.truncated) {
      err(`снимок «до» усечён на ${MAX_SNAPSHOT_FILES} файлах — прогон ничего не доказывает`);
      return 3;
    }
    out(`снимок «до»: ${before.map.size} файлов, исключено путей: ${before.excluded}`
      + `${before.ignoreChecked ? '' : ' (git проверку игнорируемости не подтвердил)'}`);

    // 1. ЧТЕНИЕ. Серия запросов: список, оба проекта, дерево, дифф.
    const reads = [];
    for (const p of [
      '/projects',
      `/projects/${idKit}`,
      `/projects/${idBare}`,
      `/projects/${idKit}/tree?dir=`,
      `/projects/${idKit}/tree?dir=sub`,
      `/projects/${idKit}/diff`,
    ]) {
      reads.push([p, await ask('GET', p)]);
    }
    const okReads = reads.filter(([, r]) => r.status === 200).length;
    out(`чтение: ответов 200 — ${okReads} из ${reads.length}`);
    // Ответ не 200 НАЗЫВАЕТСЯ, а не прячется за числом: стенд не репозиторий, и вкладка
    // диффов на нём законно отвечает отказом, — но читатель прогона обязан видеть, какой
    // именно запрос не прошёл, иначе «5 из 6» читается как неисправность демона.
    for (const [p, r] of reads) {
      if (r.status !== 200) out(`  не 200: ${p} -> ${r.status} ${(r.json && (r.json.code || r.json.error)) || ''}`);
    }
    if (okReads === 0) {
      err('ни один запрос чтения не прошёл — прогон ничего не доказывает');
      return 3;
    }

    // 1а. ПРИЗНАК ЗАПИСИ В ДЕРЕВЕ у файла под образцом секрета — он обязан быть ЛОЖНЫМ.
    // Отказа маршрута мало: кнопку сохранения страница части D рисует по ЭТОМУ признаку,
    // и `writable: true` на `.env` есть кнопка-обманка на файле секретов. Ветвь заведена
    // по находке ревью фазы 2 — до неё её не мерила ни одна попытка.
    const treeRoot = reads.find(([p]) => p === `/projects/${idKit}/tree?dir=`);
    const treeEntries = treeRoot && treeRoot[1].json && Array.isArray(treeRoot[1].json.entries)
      ? treeRoot[1].json.entries : [];
    const envEntry = treeEntries.find((e) => e && e.name === '.env') || null;
    const envOk = Boolean(envEntry) && envEntry.secret === true && envEntry.writable === false;
    out(`дерево, .env: secret=${envEntry ? envEntry.secret : '—'},`
      + ` writable=${envEntry ? envEntry.writable : '—'} (ожидание true/false)${envOk ? '' : '  <-- РАСХОЖДЕНИЕ'}`);
    if (!envOk) {
      notes.push('в дереве .env не помечен секретом или помечен доступным на запись');
      code = 1;
    }

    // 2. СЕССИЯ: поднимается и отпускается, ни одной команды внутрь.
    out(`сессия терминала: ${await pokeSession(idKit)}`);

    // 3. ЗАПИСЬ, которая ОБЯЗАНА пройти.
    const opened = await ask('GET', `/projects/${idKit}/file?path=a.txt`);
    const token = opened.json && opened.json.token;
    const saved = await save(idKit, 'a.txt', 'изменено пультом\n', token || '');
    const savedOk = saved.json && saved.json.ok === true;
    out(`сохранение a.txt: ${savedOk ? 'прошло' : `ОТКАЗ ${saved.json && saved.json.code}`}`);
    if (!savedOk) {
      notes.push('намеренное сохранение не прошло — мерить нечего');
      code = 1;
    }

    // 4. ЗАПИСИ, КОТОРЫЕ ОБЯЗАНЫ БЫТЬ ОТБИТЫ, И КАЖДАЯ СВОИМ КОДОМ.
    //
    // ТОКЕН БЕРЁТСЯ НАСТОЯЩИЙ, И ЭТО НЕ МЕЛОЧЬ. Чтение внутри набора и в проекте без набора
    // разрешено, значит токен там добывается честно, — а с чужим токеном попытка упёрлась бы
    // в сверку (`file_changed`) НА ШАГ ПОЗЖЕ шлюза. Тогда ослабленная проверка «не в наборе»
    // осталась бы незамеченной: запись всё равно не состоялась бы, и мутационная проверка
    // доказывала бы работу сверки вместо работы шлюза.
    const kitToken = (await ask('GET', `/projects/${idKit}/file?path=.claude/VERSION`)).json;
    const bareToken = (await ask('GET', `/projects/${idBare}/file?path=c.txt`)).json;
    // Токен файла-секрета добывается ЧЕСТНО, через явный признак раскрытия: чтение таких
    // файлов закрыто умолчанием, а не насовсем, и без `reveal=1` токена бы не было вовсе.
    // С поддельным токеном попытка упёрлась бы в сверку на шаг ПОЗЖЕ шлюза — ровно та же
    // ловушка, что и с записью внутрь набора.
    const secretToken = (await ask('GET', `/projects/${idKit}/file?path=.env&reveal=1`)).json;
    const attempts = [
      ['внутрь .claude', await save(idKit, '.claude/VERSION', '9.9.9\n', (kitToken && kitToken.token) || 'x'), FAULT.WRITE_INTO_KIT],
      ['с двумя точками', await save(idKit, '../outside/target.txt', 'взлом\n', token || 'x'), FAULT.WRITE_OUTSIDE_ROOT],
      ['в проект без набора', await save(idBare, 'c.txt', 'взлом\n', (bareToken && bareToken.token) || 'x'), FAULT.WRITE_NO_KIT],
      ['в файл-секрет', await save(idKit, '.env', 'взлом\n', (secretToken && secretToken.token) || 'x'), FAULT.WRITE_INTO_SECRET],
    ];
    if (stands.link) {
      attempts.push(['по ссылке наружу', await save(idKit, stands.link, 'взлом\n', token || 'x'), FAULT.TARGET_NOT_PLAIN_FILE]);
    }
    for (const [name, res, expect] of attempts) {
      const got = res.json && res.json.code;
      const hit = got === expect;
      out(`  отказ «${name}»: ${got} (ожидание ${expect})${hit ? '' : '  <-- РАСХОЖДЕНИЕ'}`);
      if (!hit) {
        notes.push(`отказ «${name}» пришёл кодом ${got}, а не ${expect}`);
        code = 1;
      }
    }
    if (!stands.link) out('  отказ «по ссылке наружу»: случай пропущен (нет привилегии)');

    // 5. СНИМОК ПОСЛЕ и раздельные ожидания.
    const after = await snapshot(parent);
    if (after.truncated) {
      err(`снимок «после» усечён на ${MAX_SNAPSHOT_FILES} файлах — прогон ничего не доказывает`);
      return 3;
    }
    out(`снимок «после»: ${after.map.size} файлов, исключено путей: ${after.excluded}`
      + `${after.ignoreChecked ? '' : ' (git проверку игнорируемости не подтвердил)'}`);

    const diff = compare(before.map, after.map);
    const expected = 'project/a.txt';
    const inKit = [];
    const other = [];
    for (const [kind, list] of [['изменился', diff.changed], ['появился ', diff.appeared], ['пропал   ', diff.vanished]]) {
      for (const rel of list) {
        if (rel === expected && kind === 'изменился') continue;
        // Внутри `.claude` — авария и код 1 без разговоров; всё прочее печатается для разбора.
        if (rel.split('/').includes('.claude')) inKit.push(`    ${kind}: ${rel}`);
        else other.push(`    ${kind}: ${rel}`);
      }
    }

    if (inKit.length) {
      out('');
      out('АВАРИЯ: расхождения ВНУТРИ папки набора — демон писал в кит:');
      for (const line of inKit) out(line);
      code = 1;
    }
    if (other.length) {
      out('');
      out('расхождения вне папки набора (разберите глазами — сценарий сохранял только a.txt):');
      for (const line of other) out(line);
      code = 1;
    }
    if (!inKit.length && !other.length) {
      out('');
      out('расхождений нет: изменился ровно тот файл, который сценарий сохранял намеренно');
    }
    out('каталоги и недолговечные файлы этот снимок не видит — см. шапку файла');
  } finally {
    // Уборка: сначала демон, потом каталоги. Занятость ТЕРПИТСЯ и называется строкой.
    try { daemon.kill(); } catch { /* уже мёртв */ }
    await new Promise((r) => { setTimeout(r, 500); });
    for (const dir of [parent, cfg]) {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch (e) {
        out(`стенд занят, удалить вручную: ${dir} (${(e && e.code) || 'ошибка'})`);
      }
    }
    if (notes.length) {
      out('');
      for (const n of notes) out(`замечание: ${n}`);
    }
  }
  return code;
}

main().then((c) => process.exit(c)).catch((e) => {
  err(`прогон не состоялся: ${(e && (e.code || e.name)) || 'ошибка'}`);
  process.exit(3);
});
