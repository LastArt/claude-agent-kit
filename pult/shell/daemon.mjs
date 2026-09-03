#!/usr/bin/env node
/**
 * ДЕМОН ГЛАЗАМИ ОБОЛОЧКИ: поиск системного Node, распознавание чужого ответа на нашем порту,
 * запуск, владение и останов. Это ЕДИНСТВЕННЫЙ модуль оболочки, который поднимает и гасит
 * демон; больше этого не делает никто.
 *
 * ДВА ЗАПРЕТА, БЕЗ КОТОРЫХ ОТКАЗ ОКАЗЫВАЕТСЯ ТИХИМ И НЕ ТАМ, ГДЕ ПРИЧИНА:
 *
 *   1. ПУТЬ ИСПОЛНЯЕМОГО ФАЙЛА ТЕКУЩЕГО ПРОЦЕССА ВНУТРИ ELECTRON — ЭТО БИНАРНИК ELECTRON,
 *      А НЕ NODE. Взять его «как готовый Node» значит запустить демон под чужим рантаймом,
 *      не заметив этого.
 *   2. ПЕРЕМЕННАЯ ЗАПУСКА ELECTRON В РЕЖИМЕ NODE ДАЁТ NODE С ABI ELECTRON. Под ним демон
 *      СТАРТУЕТ, страница живая, HTTP отвечает — а `loadPty()` в `pult/lib/pty.mjs` ловит
 *      исключение загрузки нативного модуля и возвращает пустоту: терминал молча перестаёт
 *      подниматься, и человек ищет поломку в терминале, а не в способе запуска.
 *
 * Поэтому рантайм здесь ИЩЕТСЯ, а не берётся из своего процесса, и не нашёлся — оболочка
 * ОТКАЗЫВАЕТ ЯВНО и окна не открывает. Обе переменные Electron вычищаются из окружения
 * ребёнка ПРИСТАВКОЙ (см. `childEnv()`), а не поимённо: приставка переживёт появление
 * следующей такой переменной.
 *
 * ЧЕСТНАЯ ОГОВОРКА ПРО ЕДИНУЮ ДВЕРЬ. `resolveCommand()` (`pult/lib/fs-safe.mjs`) закрывает
 * поиск исполняемого файла ПО РАБОЧЕМУ КАТАЛОГУ и требует абсолютного пути. Он НЕ закрывает
 * подмену самого файла в каталоге из переменной путей: тот, кто может записать в каталог
 * `PATH`, получает выполнение и без нас. Обещать здесь больше этого нельзя.
 *
 * ФОРМА ЗАПУСКА БЕРЁТСЯ ЦЕЛИКОМ И ПО ЧАСТЯМ НЕ ПЕРЕСОБИРАЕТСЯ (докблок `withArgs()`, находка
 * ревью фазы 2). Поле файла из формы уходит отсюда РОВНО В ОДНО МЕСТО — в человеческое
 * сообщение о найденном рантайме, и берётся там `target`, а не `file`, потому что у формы
 * командного файла в `file` лежит интерпретатор.
 *
 * ВЛАДЕНИЕ ЖИВЁТ В ПАМЯТИ, ФАЙЛА С НОМЕРОМ ПРОЦЕССА НЕТ. Подняли сами — гасим при выходе
 * И ПРИ ЛЮБОМ ОТКАЗЕ, СЛУЧИВШЕМСЯ ПОСЛЕ ЗАПУСКА: кто поднял, тот и убирает, на месте, а не
 * надеясь на выход главного процесса (находка 7 ревью 02.09.2026);
 * распознали чужой (или свой, но поднятый снаружи) — не трогаем НИКОГДА. Номер процесса
 * помнится, пока ребёнок жив, и снимается по событию его завершения: номера переиспользуются
 * системой, и удар по дереву после выхода ребёнка ушёл бы в чужое дерево.
 *
 * ЖУРНАЛ ОБОЛОЧКИ — ТОЛЬКО ПОТОК ВЫВОДА ПРОЦЕССА, В ФАЙЛ ВНУТРИ РЕПОЗИТОРИЯ НЕ ПИШЕТСЯ:
 * вывод демона содержит абсолютные пути с именем пользователя, а репозиторий публичный.
 *
 * Осмотр из обычного Node (Electron здесь не импортируется намеренно — модуль обязан
 * проверяться без окна):
 *
 *   node -e "import('./pult/shell/daemon.mjs').then(async m=>console.log(await m.findNode()))"
 */

import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { HOST, PORT, VERSION_RE, SESSION_ENV_DROP, SESSION_ENV_DROP_PREFIX } from '../config.mjs';
import { resolveCommand, withArgs } from '../lib/fs-safe.mjs';

// --- константы оболочки: живут рядом с потребителем --------------------------

/** Младшая версия системного Node, с которой демон объявлен работающим (`engines` демона). */
const NODE_MIN_MAJOR = 18;

/** Проба версии ИСПОЛНЯЕТ найденный файл, поэтому у неё свой таймаут и свой потолок вывода. */
const VERSION_PROBE_MS = 5000;
const VERSION_MAX_BYTES = 4 * 1024;

/** Проба здоровья: таймаут и потолок тела ДО разбора JSON. */
const HEALTH_TIMEOUT_MS = 1500;
const HEALTH_MAX_BODY = 8 * 1024;

/** Сколько ждём здоровья от поднятого своего демона и как часто спрашиваем. */
const START_WAIT_MS = 20000;
const START_POLL_MS = 300;

/** Потолки журнала: длина строки, всего байт вывода ребёнка и сколько последних строк помним. */
const LOG_LINE_MAX = 500;
const LOG_TOTAL_MAX = 256 * 1024;
const LOG_KEEP_LINES = 20;

/** Сколько ждём мягкого завершения, прежде чем гасить с принуждением. */
const KILL_GRACE_MS = 3000;

/**
 * Явное указание рантайма человеком — АБСОЛЮТНЫМ путём и через ту же дверь, без послаблений.
 * Приставка `CCKIT_` не случайна: та же приставка вычищается из окружения ребёнка, то есть
 * переменная до демона и до сессий терминала не доедет — ей там делать нечего.
 */
const RUNTIME_ENV = 'CCKIT_PULT_NODE';

/**
 * ЧТО ДОБАВЛЯЕТСЯ К ЗАКРЫТОМУ СПИСКУ ДЕМОНА. Ребёнок — процесс Node, и переменные Electron
 * ему не нужны ни одной; одна из них к тому же переключает рантайм (запрет 2 в шапке).
 */
const CHILD_ENV_DROP_PREFIX = ['ELECTRON_'];

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Каталог демона и его точка входа — абсолютные, считаются от адреса этого модуля. */
export const DAEMON_DIR = path.resolve(HERE, '..');
export const DAEMON_ENTRY = path.join(DAEMON_DIR, 'server.mjs');

/**
 * Адрес страницы. СОБИРАЕТСЯ ИЗ КОНСТАНТ ДЕМОНА и нигде не пишется строкой: расхождение
 * с белым списком происхождения (`HOST_ALLOW`, `ORIGIN_ALLOW` в `pult/config.mjs`) дало бы
 * 403 на каждый запрос окна.
 */
export const PULT_URL = `http://${HOST}:${PORT}/`;

const say = (s) => process.stdout.write(`[shell] ${s}\n`);

/** Отказ — машинный код плюс человеческая причина. Наружу уходит ровно эта пара. */
const fail = (code, message) => ({ ok: false, code, message });

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });

// --- окружение ребёнка -------------------------------------------------------

/**
 * ОКРУЖЕНИЕ ДЕМОНА: наследование минус ЗАКРЫТЫЙ ИМЕНОВАННЫЙ СПИСОК. Своего не добавляется
 * ничего — ни одной переменной.
 *
 * Список берётся ТОТ ЖЕ, что объявлен в `pult/config.mjs` для сессий терминала, и это
 * несущее свойство, а не экономия: демон отдаёт своё окружение каждой сессии через
 * `sessionEnv()`, поэтому всё, что не вычищено здесь, доедет до оболочки машины у человека.
 * Отдельным списком «для оболочки» эти два множества разошлись бы молча.
 *
 * Сверка имён БЕЗ УЧЁТА РЕГИСТРА: на Windows имена переменных регистронезависимы,
 * и переменная в нижнем регистре иначе проскочила бы мимо приставки.
 */
export function childEnv(base = process.env) {
  const drop = new Set(SESSION_ENV_DROP.map((n) => n.toUpperCase()));
  const prefixes = [...SESSION_ENV_DROP_PREFIX, ...CHILD_ENV_DROP_PREFIX].map((p) => p.toUpperCase());
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (typeof v !== 'string') continue;
    const up = k.toUpperCase();
    if (drop.has(up)) continue;
    if (prefixes.some((p) => up.startsWith(p))) continue;
    env[k] = v;
  }
  return env;
}

// --- запуск подпроцесса ------------------------------------------------------

/**
 * ЗНАК ПРОЦЕНТА В ФОРМЕ КОМАНДНОГО ФАЙЛА. `cmd /c` подставляет значение переменной окружения
 * по процентам ДАЖЕ ВНУТРИ КАВЫЧЕК (докблок `withArgs()`), а знак процента в имени каталога
 * на Windows законен. Значит аргумент с процентом приедет в командный файл ИСКАЖЁННЫМ,
 * и отказ будет тихим.
 *
 * Проверяются ВСЕ аргументы вместе с путём до самого командного файла: в командную строку
 * интерпретатора уезжает и он. Для обычного исполняемого файла проверка не нужна и не
 * применяется — там аргументы идут массивом, оболочки в цепочке нет.
 *
 * Функция живёт здесь, а зовётся и отсюда, и из `pult/shell/add-project.mjs`: правило одно
 * на все запуски оболочки, и второй его копии быть не должно.
 */
export function percentUnsafe(form, args = []) {
  if (!form || form.shellFile !== true) return false;
  const list = Array.isArray(args) ? args : [];
  return [form.target, ...list].some((a) => String(a).includes('%'));
}

/**
 * Запуск с ожиданием конца, таймаутом и ПОТОЛКАМИ НА ОБА ПОТОКА по отдельности.
 *
 * Функция общая для пробы версии (здесь) и для запуска инструмента реестра
 * (`pult/shell/add-project.mjs`): дисциплина запуска обязана быть одна, а две её копии
 * разошлись бы при первой правке. Форма приходит ЦЕЛИКОМ и подставляется через `withArgs()`.
 */
export function runCapped(form, args, options = {}) {
  const {
    cwd = DAEMON_DIR,
    env = childEnv(),
    timeoutMs = VERSION_PROBE_MS,
    maxBytes = VERSION_MAX_BYTES,
  } = options;

  return new Promise((resolve) => {
    const shaped = withArgs(form, args);
    // Пустая форма — ЯВНЫЙ ОТКАЗ, а не попытка собрать командную строку руками.
    if (!shaped) { resolve(fail('form_empty', 'форма запуска не собралась (кавычка в пути?)')); return; }

    let child;
    try {
      child = spawn(shaped.file, shaped.args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: shaped.verbatim === true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve(fail('spawn_failed', `не запустился: ${(e && (e.code || e.name)) || 'ошибка'}`));
      return;
    }

    const caps = { out: '', err: '' };
    const cut = { out: false, err: false };
    const grab = (key) => (chunk) => {
      const room = maxBytes - Buffer.byteLength(caps[key]);
      if (room <= 0) { cut[key] = true; return; }
      const text = chunk.toString('utf8');
      if (Buffer.byteLength(text) > room) { cut[key] = true; caps[key] += text.slice(0, room); return; }
      caps[key] += text;
    };
    child.stdout.on('data', grab('out'));
    child.stderr.on('data', grab('err'));

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch { /* уже мёртв */ }
    }, timeoutMs);

    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.on('error', (e) => settle(fail('spawn_failed', `не запустился: ${(e && (e.code || e.name)) || 'ошибка'}`)));
    child.on('close', (code) => settle({
      ok: true, code, killed, stdout: caps.out, stderr: caps.err, truncated: cut.out || cut.err,
    }));
  });
}

// --- поиск системного Node ---------------------------------------------------

const NO_NODE_TEXT = [
  'Системный Node не найден.',
  '',
  'Пульт запускает демон СИСТЕМНЫМ Node, потому что Node внутри Electron — другой ABI,',
  'и нативный псевдотерминал под ним не грузится: терминал переставал бы подниматься молча.',
  '',
  `Что делать: поставить Node ${NODE_MIN_MAJOR} или новее, либо указать его АБСОЛЮТНЫМ путём`,
  `в переменной окружения ${RUNTIME_ENV}.`,
].join('\n');

/** Найденное запоминается на процесс: проба версии ИСПОЛНЯЕТ файл, и делать это дважды незачем. */
let nodeCache = null;

/**
 * Системный Node: форма запуска, абсолютный путь и версия. Не нашлось или версия старая —
 * `{ ok: false, code, message }`, и вызывающий обязан показать причину и НЕ открывать окно.
 */
export async function findNode() {
  if (nodeCache) return nodeCache;

  const explicit = process.env[RUNTIME_ENV];
  let form = null;
  if (typeof explicit === 'string' && explicit.trim()) {
    const raw = explicit.trim();
    if (!path.isAbsolute(raw)) {
      return fail('runtime_env_not_absolute', `${RUNTIME_ENV} обязана содержать АБСОЛЮТНЫЙ путь к node`);
    }
    form = await resolveCommand(raw);
    if (!form) return fail('runtime_env_unresolved', `${RUNTIME_ENV} указывает не на обычный исполняемый файл`);
  } else {
    form = await resolveCommand('node');
    if (!form) return fail('node_not_found', NO_NODE_TEXT);
  }

  // Поле файла берётся ТОЛЬКО для человеческого сообщения: у формы командного файла
  // в `file` лежит интерпретатор, а не сам Node. Запускается всегда форма целиком.
  const shown = form.shellFile === true ? form.target : form.file;

  if (percentUnsafe(form, ['--version'])) {
    return fail('percent_in_path', `в пути к Node есть знак процента, а запуск идёт через командный файл:\n  ${shown}`);
  }

  const probe = await runCapped(form, ['--version'], { timeoutMs: VERSION_PROBE_MS, maxBytes: VERSION_MAX_BYTES });
  if (!probe.ok) return probe;
  if (probe.killed) return fail('node_probe_timeout', `найденный Node не ответил на запрос версии за ${VERSION_PROBE_MS} мс:\n  ${shown}`);
  if (probe.code !== 0) return fail('node_probe_failed', `найденный Node вернул код ${probe.code} на запрос версии:\n  ${shown}`);

  // РАЗБОР — СВЕРКОЙ С ФОРМОЙ НОМЕРА, а не выковыриванием цифр из чужого текста.
  const first = String(probe.stdout).split(/\r?\n/)[0].trim();
  const bare = first.startsWith('v') ? first.slice(1) : first;
  if (!VERSION_RE.test(bare)) {
    return fail('node_version_unreadable', `не разобрал версию найденного Node:\n  ${shown}`);
  }
  const major = Number(bare.split('.')[0]);
  if (major < NODE_MIN_MAJOR) {
    return fail('node_too_old', `найден Node v${bare}, а демону нужен ${NODE_MIN_MAJOR} или новее:\n  ${shown}`);
  }

  nodeCache = { ok: true, form, file: shown, version: bare };
  return nodeCache;
}

// --- клиент демона -----------------------------------------------------------

/**
 * ОДИН КЛИЕНТ НА ВСЕ ОБРАЩЕНИЯ ОБОЛОЧКИ К ДЕМОНУ: и проба здоровья здесь, и минутный опрос
 * ожиданий в `pult/shell/notify.mjs`. Дисциплина одна и вынесена сюда именно поэтому:
 *
 *   • свой таймаут;
 *   • ПОТОЛОК ТЕЛА ДО РАЗБОРА — тело копится в буфер, и разбирать нечего, пока оно не дочитано
 *     целиком в пределах потолка;
 *   • ПЕРЕАДРЕСАЦИИ НЕ ЧИТАЮТСЯ ВОВСЕ: ответ, отличный от 200, разбору не подлежит,
 *     а код возврата отдаётся вызывающему — по нему `notify.mjs` отличает старый демон
 *     (404 на маршруте ожиданий) от поломки.
 *
 * @returns {Promise<{answered: boolean, status: number, body: string, code: string}>}
 */
export function getCapped(pathname, options = {}) {
  const { timeoutMs = HEALTH_TIMEOUT_MS, maxBody = HEALTH_MAX_BODY } = options;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (r) => { if (!settled) { settled = true; resolve(r); } };

    const req = http.request({
      host: HOST,
      port: PORT,
      path: pathname,
      method: 'GET',
      headers: { Host: `${HOST}:${PORT}`, Accept: 'application/json' },
    }, (res) => {
      const status = res.statusCode || 0;
      if (status !== 200) {
        res.resume();
        settle({ answered: true, status, body: '', code: 'status' });
        return;
      }
      const chunks = [];
      let size = 0;
      let over = false;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBody) { over = true; res.destroy(); return; }
        chunks.push(c);
      });
      res.on('close', () => {
        if (over) { settle({ answered: true, status, body: '', code: 'too_big' }); return; }
        settle({ answered: true, status, body: Buffer.concat(chunks).toString('utf8'), code: 'ok' });
      });
      res.on('error', () => settle({ answered: true, status, body: '', code: 'broken' }));
    });

    req.setTimeout(timeoutMs, () => req.destroy());
    req.on('error', () => settle({ answered: false, status: 0, body: '', code: 'no_answer' }));
    req.end();
  });
}

// --- проба здоровья ----------------------------------------------------------

/**
 * РАСПОЗНАВАНИЕ ПО БЕЛОМУ СПИСКУ ПОЛЕЙ: признак готовности, имя пульта (сам ключ) и версия
 * РАЗБИРАЕМОЙ ФОРМЫ. Ни одного другого поля ответа мы не читаем.
 */
function recognise(body) {
  let parsed;
  try { parsed = JSON.parse(body); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.ok !== true) return null;
  const version = parsed.pult;
  if (typeof version !== 'string' || !VERSION_RE.test(version)) return null;
  return version;
}

const FOREIGN_TEXT = [
  `На ${HOST}:${PORT} уже кто-то отвечает, и это не демон пульта.`,
  '',
  'Окно не открывается намеренно: иначе в нём оказалась бы ЧУЖАЯ страница —',
  'с мостом в главный процесс и системным диалогом выбора папки.',
  '',
  'Что делать: освободить порт (закрыть занявшую его программу) и запустить пульт заново.',
].join('\n');

/**
 * Кто отвечает на нашем порту.
 *
 * ФОРМУЛИРОВКА ТОЧНАЯ, И РАСШИРЯТЬ ЕЁ НЕЛЬЗЯ: проба распознаёт ЧУЖУЮ СЛУЖБУ и СТАРЫЙ ДЕМОН,
 * но НЕ ЗАЩИЩАЕТ ОТ НАМЕРЕННО ПОДСТАВЛЕННОГО ОТВЕТЧИКА — три поля подделываются тривиально.
 * Потери от этого нет (у занявшего порт петли и так есть выполнение кода на машине),
 * но обещать здесь «защиту от подмены» нельзя.
 *
 * Клиент — общий (`getCapped()`): таймаут, потолок тела ДО разбора JSON, переадресации
 * не читаются вовсе — ответ, отличный от 200, считается чужим.
 *
 * @returns {Promise<{answered: boolean, mine: boolean, version: string|null, code: string}>}
 */
export async function probeHealth(timeoutMs = HEALTH_TIMEOUT_MS) {
  const res = await getCapped('/health', { timeoutMs, maxBody: HEALTH_MAX_BODY });
  if (!res.answered) return { answered: false, mine: false, version: null, code: 'no_answer' };
  if (res.code !== 'ok') return { answered: true, mine: false, version: null, code: `health_${res.code}` };
  const version = recognise(res.body);
  return version
    ? { answered: true, mine: true, version, code: 'ours' }
    : { answered: true, mine: false, version: null, code: 'health_foreign' };
}

// --- владение процессом ------------------------------------------------------

/**
 * Состояние владения. Файла с номером процесса НЕТ намеренно: он пережил бы падение оболочки,
 * и следующий запуск гасил бы по нему чужое дерево.
 */
const state = { child: null, pid: null, owned: false, version: null, tail: [], stopping: false };

/**
 * Кого позвать, если СВОЙ демон ушёл сам, а не по нашей команде.
 *
 * Раньше эта новость никуда не уходила: обработчик писал строку в журнал и всё. Между тем
 * окно в этот момент выглядит живым, а любая страница отвечает «нет связи» — то есть оболочка
 * ЗНАЕТ о поломке и молчит о ней (находка человека 02.09.2026, дефект 2). Хук ставит главный
 * процесс, дело хука — сказать человеку.
 */
let goneHook = null;

export function onDaemonGone(fn) {
  goneHook = typeof fn === 'function' ? fn : null;
}

/** Что показывать в меню трея и в журнале: свой демон или внешний. */
export function daemonState() {
  return { owned: state.owned && state.pid !== null, pid: state.pid, version: state.version };
}

/** Последние строки вывода ребёнка — для сообщения об отказе. */
const tailText = () => (state.tail.length ? `\n\nПоследнее из вывода демона:\n${state.tail.join('\n')}` : '');

/** Построчная печать вывода ребёнка в журнал оболочки с потолками. */
function pipeLog(stream, tag) {
  let rest = '';
  let total = 0;
  let stopped = false;
  stream.on('data', (chunk) => {
    if (stopped) return;
    total += chunk.length;
    if (total > LOG_TOTAL_MAX) {
      stopped = true;
      say(`${tag}: вывод превысил потолок журнала, дальше молчу`);
      return;
    }
    rest += chunk.toString('utf8');
    const lines = rest.split(/\r?\n/);
    rest = lines.pop() || '';
    for (const line of lines) {
      if (!line) continue;
      const short = line.length > LOG_LINE_MAX ? `${line.slice(0, LOG_LINE_MAX)}…` : line;
      state.tail.push(`${tag}: ${short}`);
      if (state.tail.length > LOG_KEEP_LINES) state.tail.shift();
      say(`${tag}: ${short}`);
    }
  });
}

/**
 * Демон на порту: распознать чужого, признать своего внешнего или поднять собственного.
 *
 * @returns {Promise<{ok: true, owned: boolean, version: string}|{ok: false, code: string, message: string}>}
 */
export async function ensureDaemon() {
  const first = await probeHealth();
  if (first.answered && first.mine) {
    state.owned = false;
    state.version = first.version;
    say(`демон уже работает и распознан как наш (${first.version}) — поднят снаружи, гасить не буду`);
    return { ok: true, owned: false, version: first.version };
  }
  if (first.answered) {
    say(`на порту отвечает не наш демон: ${first.code}`);
    return fail('foreign_responder', FOREIGN_TEXT);
  }

  const node = await findNode();
  if (!node.ok) return node;
  say(`системный Node: ${node.file} (v${node.version})`);

  if (percentUnsafe(node.form, [DAEMON_ENTRY])) {
    return fail('percent_in_path', `в пути к демону есть знак процента, а запуск идёт через командный файл:\n  ${DAEMON_ENTRY}`);
  }
  const shaped = withArgs(node.form, [DAEMON_ENTRY]);
  if (!shaped) return fail('form_empty', 'форма запуска демона не собралась (кавычка в пути?)');

  state.tail = [];
  let child;
  try {
    child = spawn(shaped.file, shaped.args, {
      cwd: DAEMON_DIR,
      env: childEnv(),
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: shaped.verbatim === true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    return fail('spawn_failed', `демон не запустился: ${(e && (e.code || e.name)) || 'ошибка'}`);
  }

  state.child = child;
  state.pid = child.pid;
  state.owned = true;
  pipeLog(child.stdout, 'daemon');
  pipeLog(child.stderr, 'daemon');

  let exited = null;
  // НОМЕР СНИМАЕТСЯ ПО СОБЫТИЮ ЗАВЕРШЕНИЯ. Дальше гасить нечего и НЕЛЬЗЯ: номер уже мог
  // достаться чужому процессу.
  child.on('exit', (code, signal) => {
    const wasUp = state.version !== null && !state.stopping;
    exited = { code, signal };
    state.child = null;
    state.pid = null;
    state.owned = false;
    say(`демон завершился (код ${code}${signal ? `, сигнал ${signal}` : ''})`);
    // УХОД БЕЗ НАШЕЙ КОМАНДЫ — новость для человека, а не строка в журнал. `wasUp` отличает
    // «умер, уже отработав» от «не поднялся вовсе»: второе разбирается ниже по циклу ожидания
    // и доходит до человека своим отказом.
    if (wasUp && goneHook) {
      try { goneHook({ code, signal, tail: state.tail.slice(-5) }); } catch { /* сообщать нечем */ }
    }
  });
  child.on('error', (e) => { say(`демон не запустился: ${(e && (e.code || e.name)) || 'ошибка'}`); });

  /**
   * ОТКАЗ ПОСЛЕ ТОГО, КАК СВОЙ ПРОЦЕСС УЖЕ ЗАПУЩЕН: сначала гасим своего ребёнка, потом
   * отвечаем отказом.
   *
   * Почему здесь, а не у вызывающего (находка 7 ревью 02.09.2026): главный процесс уходит
   * по этим ветвям через `app.exit()`, а тот НЕ поднимает `before-quit`, то есть останов
   * не звался вовсе. Лечить это в главном процессе значит требовать от него помнить, какие
   * именно ветви успели создать процесс. Чужого демона правило не касается: `stopDaemon()`
   * трогает процесс только при СВОЁМ владении, и внешний демон переживает нас по-прежнему.
   */
  const failAfterSpawn = async (code, message) => {
    await stopDaemon();
    return fail(code, message);
  };

  const deadline = Date.now() + START_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(START_POLL_MS);
    const probe = await probeHealth();
    if (probe.answered && probe.mine) {
      state.version = probe.version;
      // Ребёнок мог умереть ровно между пробами: тогда отвечает НЕ ОН, и владения у нас нет.
      const owned = state.pid !== null;
      state.owned = owned;
      say(owned
        ? `демон поднят нами (${probe.version}), номер процесса ${state.pid}`
        : `демон снаружи (${probe.version}) — гасить не буду`);
      return { ok: true, owned, version: probe.version };
    }
    if (probe.answered) return failAfterSpawn('foreign_responder', FOREIGN_TEXT);
    if (exited) {
      // ПОВТОРНАЯ ПРОБА С РАСПОЗНАВАНИЕМ: вероятнее всего порт занят ДРУГИМ демоном,
      // и наш ребёнок умер именно об это.
      const again = await probeHealth();
      if (again.answered && again.mine) {
        state.version = again.version;
        say(`наш процесс не поднялся, но на порту распознан наш демон (${again.version}) — он снаружи`);
        return { ok: true, owned: false, version: again.version };
      }
      if (again.answered) return fail('foreign_responder', FOREIGN_TEXT);
      return fail('daemon_exited', `демон завершился сразу, код ${exited.code}.${tailText()}`);
    }
  }
  return failAfterSpawn('health_timeout', `демон не ответил на пробу здоровья за ${Math.round(START_WAIT_MS / 1000)} с.${tailText()}`);
}

/** Ждём ухода ребёнка не дольше срока; вернули `true` — ушёл. */
function waitExit(child, ms) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) { resolve(true); return; }
    const timer = setTimeout(() => resolve(false), ms);
    if (timer.unref) timer.unref();
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

/**
 * Останов — ТОЛЬКО СВОЕГО демона и только пока ребёнок жив.
 *
 * На Windows гасится ДЕРЕВО системной утилитой (сам процесс Node родил сессии
 * псевдотерминала, и они пережили бы родителя), сначала мягко, затем с принуждением: сигнал
 * завершения там не доставляется ни при закрытии окна консоли, ни при принудительном снятии.
 *
 * ОГОВОРКА, КОТОРУЮ НЕ НАДО «ЧИНИТЬ»: оболочку, убитую жёстко, демон переживёт. Критерий
 * фазы требует не убивать ЧУЖОЙ демон, а не гарантировать уборку в любом исходе.
 *
 * ВТОРАЯ ОГОВОРКА — НАЗВАННАЯ ГРАНИЦА УТВЕРЖДЕНИЯ, А НЕ ДОЛГ. На Windows брошенный ребёнок
 * уходит вместе с родителем: это ПОВЕДЕНИЕ ПЛАТФОРМЫ, мы на него не влияем и его не обещаем.
 * НА POSIX РЕБЁНОК РОДИТЕЛЯ ПЕРЕЖИВАЕТ, и POSIX в этой фазе не проверялся вовсе. Отсюда
 * правило выше: гасим сами и на месте, а не рассчитываем на уборку за нами.
 */
export async function stopDaemon() {
  state.stopping = true;   // уход по нашей команде — не новость для человека
  const child = state.child;
  const pid = state.pid;
  if (!state.owned || child === null || pid === null) {
    say('свой демон не поднимался (или уже ушёл) — гасить нечего');
    return { ok: true, stopped: false, reason: 'not_owned' };
  }

  if (process.platform === 'win32') {
    const form = await resolveCommand('taskkill');
    if (!form) {
      say('taskkill не разрешён единой дверью — гашу сам процесс, дерево может пережить');
      try { child.kill(); } catch { /* уже мёртв */ }
    } else {
      await runCapped(form, ['/pid', String(pid), '/t'], { timeoutMs: KILL_GRACE_MS });
      if (!(await waitExit(child, KILL_GRACE_MS))) {
        await runCapped(form, ['/pid', String(pid), '/t', '/f'], { timeoutMs: KILL_GRACE_MS });
        await waitExit(child, KILL_GRACE_MS);
      }
    }
  } else {
    try { child.kill('SIGTERM'); } catch { /* уже мёртв */ }
    if (!(await waitExit(child, KILL_GRACE_MS))) {
      try { child.kill('SIGKILL'); } catch { /* уже мёртв */ }
      await waitExit(child, KILL_GRACE_MS);
    }
  }

  say('свой демон погашен');
  return { ok: true, stopped: true, reason: 'owned' };
}
