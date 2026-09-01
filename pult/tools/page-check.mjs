#!/usr/bin/env node
/**
 * ПОСТОЯННЫЕ МАШИННЫЕ ПРОВЕРКИ СТРАНИЦЫ: полотно сравнения и кнопки редактора.
 *
 *   node pult/tools/page-check.mjs [каталог для стендов] [--negative layout|buttons]
 *
 * ЗАЧЕМ ЭТОТ ИНСТРУМЕНТ ВООБЩЕ ЕСТЬ. Два дефекта фазы 2 нашёл человек руками ПОСЛЕ вердикта
 * ревью: полотно сравнения схлопывалось в полосу в несколько пикселей после изменения размера
 * окна, а «Сохранить» была активна на только что открытом файле без единой правки. Описания
 * обеих проверок жили в `PLAN.md`, а папка задач выведена из-под git — закрытие задачи
 * уничтожило бы их вместе с задачей, и оба дефекта снова остались бы не стережёнными ничем.
 * Здесь они переписаны в исполняемый вид.
 *
 * ЧТО МЕРИТСЯ И КОГДА КРАСНЕЕТ — по одной строке на проверку, потому что проверка без
 * названного условия провала не проверка, а показания.
 *
 *   1. ПОЛОТНО СРАВНЕНИЯ. Меряется РЕДАКТОР СРАВНЕНИЯ ВНУТРИ полотна (`.monaco-diff-editor`
 *      внутри `#diff-host`), а не сам `#diff-host`. Краснеет, если высота редактора меньше
 *      0,9 высоты полотна или меньше 120 px, если высота полотна меньше половины панели
 *      `#pane-diff`, либо если видимых строк в нём меньше десяти. Мерить одну высоту
 *      `#diff-host` НЕДОСТАТОЧНО — именно так находка и проскочила мимо ревью: на больной
 *      странице `#diff-host` был 601 из 601, а полосой в 5 px был редактор ВНУТРИ него.
 *      Меряется ДВАЖДЫ: сразу после открытия файла и после полного пути болезни —
 *      «показать дифф → уйти на другую вкладку → позвать изменение размера → вернуться».
 *      Одного первого замера мало: на больном коде он зелёный.
 *
 *   2. КНОПКИ РЕДАКТОРА И ОТМЕТКА ПРАВКИ. Краснеет, если сразу после открытия файла
 *      «Сохранить» активна или отметка `#editor-dirty` видна; если после правки модели
 *      «Сохранить» осталась неактивной или отметка не появилась; если после сохранения
 *      «Сохранить» осталась активной, отметка не погасла или на диске старый текст.
 *      Отдельной строкой меряется «Перечитать»: при открытом файле она обязана быть активной.
 *
 *   3. СТРОКА ПРО НЕОТСЛЕЖИВАЕМЫЕ. Вкладка диффов считает `git diff HEAD` и новых файлов
 *      не показывает. Краснеет, если под списком нет строки про неотслеживаемые либо если
 *      число в ней разошлось с тем, что видит `git status` (на стенде их ровно два: файл
 *      и каталог целиком). Молчаливо неполный список — это дефект, а не особенность.
 *
 * ОТРИЦАТЕЛЬНЫЕ ПРОБЫ ВСТРОЕНЫ, потому что «проверка обязана уметь провалиться» — это
 * свойство, которое надо уметь показать в любой день, а не только в день написания.
 * `--negative layout` возвращает `layout()` во вкладке диффов к прежней форме (вызов без
 * размеров), `--negative buttons` возвращает `setButtons()` к прежней («Сохранить» включена
 * писабельностью, а не правкой). ПРАВИТСЯ ТОЛЬКО КОПИЯ СТЕНДА, файлы репозитория не трогаются
 * ни в одном режиме. Проба, не наложившаяся на текст (код изменился), — это код 3, а не тихий
 * зелёный: непроверенное называется.
 *
 * СТЕНД СВОЙ И ПОРТ СВОЙ. Демон человека может быть поднят на боевом порту, и трогать его
 * нельзя: инструмент разворачивает КОПИЮ пульта во временном каталоге, ставит ей свободный
 * порт правкой её собственного `config.mjs` и поднимает демона на нём. Реестр тоже свой
 * (каталог настроек подменяется временным), проект в реестре один — стенд, заведённый этим же
 * прогоном. Ни одного запроса к чужому демону и ни одной записи в чужой проект.
 *
 * ЗАЧЕМ КОПИЯ, А НЕ КЛЮЧ ЗАПУСКА: порт лежит в `PORT` (`pult/config.mjs`), и из него же
 * считаются белые списки `Host` и `Origin`. Демон, поднятый на другом порту без правки этих
 * списков, отвечал бы браузеру 403 на каждый запрос — то есть страница не открылась бы вовсе.
 * Поэтому меняется одна строка в копии, а не поведение демона.
 *
 * КОПИЯ СОБИРАЕТСЯ ЖЁСТКИМИ ССЫЛКАМИ ТАМ, ГДЕ ЭТО БЕЗОПАСНО. Привезённые сборки (`web/vendor`,
 * 25 МБ) переносятся `link()`: для читателя страницы это обычные файлы, а `realpath` у них
 * свой собственный — то есть проверка вложенности в каталог страницы (`findStatic()`
 * в `pult/lib/static.mjs`) проходит, чего символическая ссылка не дала бы. Исходники
 * копируются побайтно: жёсткая ссылка делит содержимое с оригиналом, и правка стенда испортила
 * бы репозиторий. `node_modules` подключается точкой соединения — разрешение модулей Node
 * канонизацию путей переживает, а проверок вложенности там нет.
 *
 * ГРАНИЦА УТВЕРЖДЕНИЯ. Инструмент меряет СТРАНИЦУ на стенде в headless-браузере: раскладку,
 * состояние кнопок и текст под списком. Он не говорит ничего ни о границе записи (это
 * `pult/tools/write-scope-check.mjs`), ни о целости набора (`pult/tools/no-write-check.mjs`),
 * ни о том, как страница выглядит в другом движке: браузер здесь один и тот, что нашёлся
 * на машине.
 *
 * Инструмент читает и пишет диск напрямую (`node:fs/promises`) намеренно: он не часть демона,
 * и правило «только примитивы `pult/lib/fs-safe.mjs`» относится к читателям, чьё содержимое
 * уезжает в HTTP-ответ. Наружу отсюда не уходит ничего, кроме строк в консоли.
 *
 * Коды возврата: 0 — все проверки зелёные; 1 — проверка провалилась (в отрицательной пробе
 * это ожидаемый исход); 2 — отрицательная проба НЕ покраснела, то есть проверка ничего
 * не стережёт; 3 — прогон ничего не доказывает (нет браузера, нет git, демон не поднялся,
 * страница не открылась, проба не наложилась).
 */

import {
  mkdtemp, mkdir, readdir, lstat, copyFile, link, symlink, readFile, writeFile, rm, realpath,
} from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

import { WebSocket } from 'ws';

import { resolveCommand, withArgs, gitEnv } from '../lib/fs-safe.mjs';
import { addProject } from '../lib/registry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PULT = path.resolve(HERE, '..');
const REPO = path.resolve(PULT, '..');

const DAEMON_START_MS = 20000;
const BROWSER_START_MS = 20000;
const WAIT_MS = 20000;
const CDP_CALL_MS = 30000;
const WINDOW = Object.freeze({ width: 1584, height: 749 });
const WINDOW_RESIZED = Object.freeze({ width: 1280, height: 880 });

// Стенд: сколько строк в файле, по которому смотрится дифф. Число не круглое ради красоты —
// полотну нужно заведомо больше строк, чем помещается в окно, иначе «мало видимых строк»
// перестало бы отличать больное полотно от короткого файла.
const STAND_LINES = 120;
const STAND_UNTRACKED = 2;   // `new.txt` и каталог `newdir/` целиком

const out = (s = '') => process.stdout.write(`${s}\n`);
const err = (s = '') => process.stderr.write(`[pult] ${s}\n`);
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// --- окружение ----------------------------------------------------------------

/** Где искать браузер. Первым — явное указание человека, дальше обычные места установки. */
function browserCandidates() {
  const env = process.env;
  const list = [];
  if (env.CCKIT_CHROME) list.push(env.CCKIT_CHROME);
  for (const base of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]) {
    if (!base) continue;
    list.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    list.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    list.push(path.join(base, 'Chromium', 'Application', 'chrome.exe'));
  }
  list.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
    '/usr/bin/chromium-browser', '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  return list;
}

async function findBrowser() {
  for (const p of browserCandidates()) {
    try {
      const st = await lstat(p);
      if (st.isFile()) return p;
    } catch { /* нет такого — пробуем следующий */ }
  }
  return null;
}

/** Свободный порт: занимаем и тут же отпускаем. Гонка возможна и лечится повтором прогона. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// --- копия пульта под стенд ---------------------------------------------------

/**
 * Разложить копию пульта. Возвращает счётчики — их видно в выводе: молчаливая копия,
 * потерявшая половину файлов, дала бы «страница не открылась» без объяснения.
 */
async function mirror(src, dst, rel = '', tally = { copied: 0, linked: 0 }) {
  await mkdir(dst, { recursive: true });
  for (const name of (await readdir(src)).sort()) {
    if (!rel && name === 'node_modules') continue;   // подключается точкой соединения
    const from = path.join(src, name);
    const to = path.join(dst, name);
    const childRel = rel ? `${rel}/${name}` : name;
    let st;
    try {
      st = await lstat(from);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      await mirror(from, to, childRel, tally);
      continue;
    }
    // Ни симлинков, ни устройств в поставке нет; чужое в стенд не тащим.
    if (!st.isFile()) continue;
    // ЖЁСТКАЯ ССЫЛКА ТОЛЬКО НА ПРИВЕЗЁННЫЕ СБОРКИ: они не правятся ни стендом, ни пробами.
    // Исходники копируются побайтно — правка стенда по жёсткой ссылке испортила бы репозиторий.
    if (childRel.startsWith('web/vendor/')) {
      try {
        await link(from, to);
        tally.linked += 1;
        continue;
      } catch { /* другой том или нет права — копируем */ }
    }
    await copyFile(from, to);
    tally.copied += 1;
  }
  return tally;
}

/**
 * Правка одной строки в копии. Замена — ПО СТРОКАМ, а не `replace()` со строкой: в тексте
 * набора живут `$` и обратные кавычки, и спецпоследовательности замены дважды портили файлы.
 */
async function patchPort(dir, port) {
  const file = path.join(dir, 'config.mjs');
  const lines = (await readFile(file, 'utf8')).split('\n');
  let hits = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('export const PORT = ')) {
      lines[i] = `export const PORT = ${port};`;
      hits += 1;
    }
  }
  if (hits !== 1) return { ok: false, hits };
  await writeFile(file, lines.join('\n'), 'utf8');
  return { ok: true, hits };
}

/**
 * ОТРИЦАТЕЛЬНЫЕ ПРОБЫ: вернуть в КОПИЮ прежнюю (больную) форму кода.
 *
 * Замена через `split/join` намеренно: спецпоследовательностей она не знает. Число вхождений
 * сверяется — не совпало, значит код изменился и проба ничего не докажет.
 */
const PROBES = Object.freeze({
  layout: {
    file: 'web/diff.mjs',
    what: 'layout() без размеров — прежняя форма вызова',
    from: [
      '    const width = host.clientWidth;',
      '    const height = host.clientHeight;',
      '    if (!width || !height) return;',
      '    try { view.layout({ width, height }); } catch { /* полотно не показано */ }',
    ].join('\n'),
    to: '    try { view.layout(); } catch { /* полотно не показано */ }',
  },
  buttons: {
    file: 'web/editor.mjs',
    what: '«Сохранить» включена писабельностью, а не правкой — прежняя форма setButtons()',
    from: '    saveButton.disabled = !(writable && dirty);',
    to: '    saveButton.disabled = !writable;',
  },
});

async function applyProbe(dir, kind) {
  const probe = PROBES[kind];
  const file = path.join(dir, ...probe.file.split('/'));
  const text = await readFile(file, 'utf8');
  const parts = text.split(probe.from);
  if (parts.length !== 2) return { ok: false, hits: parts.length - 1 };
  await writeFile(file, parts.join(probe.to), 'utf8');
  return { ok: true, hits: 1 };
}

// --- стенд --------------------------------------------------------------------

let gitForm;

/** Один вызов git на стенде: та же дисциплина, что у демона, — абсолютная команда и служебное окружение. */
async function git(cwd, args) {
  if (gitForm === undefined) gitForm = await resolveCommand('git');
  if (!gitForm) return { ok: false, exit: null, out: '' };
  const form = withArgs(gitForm, args);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(form.file, form.args, {
        cwd,
        env: gitEnv(),
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: form.verbatim === true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve({ ok: false, exit: null, out: '' });
      return;
    }
    let text = '';
    child.stdout.on('data', (c) => { text += c.toString('utf8'); });
    child.stderr.on('data', () => {});
    child.on('error', () => resolve({ ok: false, exit: null, out: '' }));
    child.on('close', (exit) => resolve({ ok: exit === 0, exit, out: text }));
  });
}

/**
 * Проект-стенд: репозиторий с одним коммитом, правкой в рабочем дереве и двумя
 * неотслеживаемыми записями (файл и каталог целиком — `git status` считает его ОДНОЙ).
 */
async function makeStand(dir) {
  const base = [];
  for (let i = 1; i <= STAND_LINES; i += 1) base.push(`строка ${i} — стенд проверки страницы`);

  await mkdir(path.join(dir, '.claude'), { recursive: true });
  await writeFile(path.join(dir, '.claude', 'VERSION'), '1.0.0\n');
  await writeFile(path.join(dir, '.claude', 'settings.json'), '{}\n');
  await writeFile(path.join(dir, 'a.txt'), `${base.join('\n')}\n`);
  await writeFile(path.join(dir, 'b.txt'), 'первая строка\nвторая строка\n');

  if (!(await git(dir, ['init'])).ok) return { ok: false, why: 'git init не прошёл' };
  if (!(await git(dir, ['add', '-A'])).ok) return { ok: false, why: 'git add не прошёл' };
  const commit = await git(dir, [
    '-c', 'user.email=stand@pult', '-c', 'user.name=pult stand', '-c', 'commit.gpgsign=false',
    'commit', '-m', 'стенд',
  ]);
  if (!commit.ok) return { ok: false, why: 'git commit не прошёл' };

  // Рабочая сторона расходится с коммитом — иначе во вкладке диффов сравнивать нечего.
  const changed = base.slice();
  changed[2] = 'строка 3 — правка рабочего дерева';
  changed.push('дописанная строка A', 'дописанная строка B');
  await writeFile(path.join(dir, 'a.txt'), `${changed.join('\n')}\n`);

  // Неотслеживаемое: `git diff HEAD` его не видит вовсе — ради этого и заведено.
  await writeFile(path.join(dir, 'new.txt'), 'новый файл\n');
  await mkdir(path.join(dir, 'newdir'), { recursive: true });
  await writeFile(path.join(dir, 'newdir', 'inside.txt'), 'файл в новом каталоге\n');

  const st = await git(dir, ['status', '--porcelain']);
  const untracked = st.out.split('\n').filter((l) => l.startsWith('??')).length;
  return { ok: true, untracked };
}

// --- разговор с демоном стенда ------------------------------------------------

function ask(port, method, pathname) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method, headers: { Host: `127.0.0.1:${port}` } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { json = null; }
          resolve({ status: res.statusCode, json, text });
        });
      },
    );
    req.on('error', () => resolve({ status: 0, json: null, text: '' }));
    req.end();
  });
}

async function waitHealth(port, deadline) {
  while (Date.now() < deadline) {
    const r = await ask(port, 'GET', '/health');
    if (r.status === 200) return true;
    await sleep(200);
  }
  return false;
}

// --- браузер: протокол отладчика ---------------------------------------------

/** Точка входа протокола. Браузер печатает её в `/json/version` не сразу — ждём. */
async function browserSocket(port, deadline) {
  while (Date.now() < deadline) {
    const r = await ask(port, 'GET', '/json/version');
    if (r.status === 200 && r.json && r.json.webSocketDebuggerUrl) return r.json.webSocketDebuggerUrl;
    await sleep(200);
  }
  return null;
}

/**
 * Минимальный клиент протокола: пары «запрос — ответ» по номеру. События не разбираются
 * вовсе — все ожидания здесь построены на опросе состояния страницы, а не на подписках:
 * опрос переживает пропущенное событие, подписка — нет.
 */
function connectCdp(url) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 128 * 1024 * 1024 });
    } catch (e) {
      reject(e);
      return;
    }
    const pending = new Map();
    let seq = 0;

    ws.on('message', (raw) => {
      let msg = null;
      try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (!msg || typeof msg.id !== 'number') return;
      const waiting = pending.get(msg.id);
      if (!waiting) return;
      pending.delete(msg.id);
      clearTimeout(waiting.timer);
      waiting.resolve(msg);
    });
    ws.on('error', (e) => {
      for (const [, w] of pending) { clearTimeout(w.timer); w.reject(e); }
      pending.clear();
      reject(e);
    });
    ws.on('open', () => resolve({
      send(method, params, sessionId) {
        return new Promise((res, rej) => {
          const id = (seq += 1);
          const timer = setTimeout(() => {
            pending.delete(id);
            rej(new Error(`нет ответа на ${method}`));
          }, CDP_CALL_MS);
          pending.set(id, { resolve: res, reject: rej, timer });
          const frame = { id, method, params: params || {} };
          if (sessionId) frame.sessionId = sessionId;
          try {
            ws.send(JSON.stringify(frame));
          } catch (e) {
            clearTimeout(timer);
            pending.delete(id);
            rej(e);
          }
        });
      },
      close() { try { ws.close(); } catch { /* уже закрыт */ } },
    }));
  });
}

/**
 * Страница как объект: выполнить выражение, дождаться условия, изменить размер окна.
 *
 * Все выражения оборачиваются в асинхронную функцию и возвращаются ЗНАЧЕНИЕМ, а не ссылкой:
 * ссылка на узел здесь бесполезна, а значение печатается в отчёт как есть.
 */
function makePage(cdp, sessionId) {
  const ev = async (body) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {\n${body}\n})()`,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);
    if (r.error) throw new Error(`протокол отказал: ${r.error.message || 'без причины'}`);
    const res = r.result || {};
    if (res.exceptionDetails) {
      const ex = res.exceptionDetails.exception || {};
      throw new Error(`страница отказала: ${ex.description || ex.value || 'без причины'}`);
    }
    return res.result ? res.result.value : undefined;
  };

  const waitFor = async (body, ms = WAIT_MS) => {
    const deadline = Date.now() + ms;
    for (;;) {
      let value = false;
      try { value = await ev(body); } catch { value = false; }
      if (value) return true;
      if (Date.now() >= deadline) return false;
      await sleep(120);
    }
  };

  const resize = async (size) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false,
    }, sessionId);
    // Размер меняется не мгновенно: обработчик `resize` на странице отрабатывает следующим
    // кадром, и замер без паузы поймал бы прежнюю раскладку.
    await sleep(400);
  };

  return { ev, waitFor, resize };
}

// --- проверки -----------------------------------------------------------------

/** Замер полотна: панель, полотно, редактор ВНУТРИ полотна и видимые строки. */
const MEASURE = `
  const pane = document.getElementById('pane-diff');
  const host = document.getElementById('diff-host');
  const view = host ? host.querySelector('.monaco-diff-editor') : null;
  return {
    pane: pane ? pane.clientHeight : null,
    host: host ? host.clientHeight : null,
    width: host ? host.clientWidth : null,
    view: view ? Math.round(view.getBoundingClientRect().height) : null,
    lines: host ? host.querySelectorAll('.view-line').length : 0,
  };
`;

function judgeCanvas(m) {
  const bad = [];
  if (!m || m.pane === null || m.host === null) { bad.push('панели или полотна нет в разметке'); return bad; }
  if (m.view === null) { bad.push('редактора сравнения внутри полотна нет'); return bad; }
  if (m.host < m.pane * 0.5 || m.host < 200) bad.push(`полотно ${m.host} px при панели ${m.pane} px`);
  if (m.view < m.host * 0.9 || m.view < 120) bad.push(`редактор сравнения ${m.view} px при полотне ${m.host} px`);
  if (m.lines < 10) bad.push(`видимых строк ${m.lines}`);
  return bad;
}

const shape = (m) => `панель ${m.pane} · полотно ${m.host}×${m.width} · редактор сравнения ${m.view} · строк ${m.lines}`;

/**
 * ПРОВЕРКА 1: полотно сравнения. Второй замер — после полного пути болезни; без него
 * проверка была бы зелёной и на больном коде.
 */
async function checkCanvas(page) {
  const notes = [];

  if (!await page.waitFor("return document.querySelectorAll('#diff-files .diff-file').length > 0;")) {
    return { fatal: 'список изменённых файлов не появился — мерить нечего' };
  }
  await page.ev("document.querySelector('#diff-files .diff-file').click(); return true;");
  if (!await page.waitFor("return !!document.querySelector('#diff-host .monaco-diff-editor');")) {
    return { fatal: 'редактор сравнения не поднялся — мерить нечего' };
  }
  await sleep(600);

  const first = await page.ev(MEASURE);
  out(`  замер после открытия файла: ${shape(first)}`);
  for (const b of judgeCanvas(first)) notes.push(`полотно после открытия: ${b}`);

  // ПУТЬ БОЛЕЗНИ ЦЕЛИКОМ: дифф → другая вкладка → изменение размера окна → назад.
  await page.ev("document.getElementById('tab-terminal').click(); return true;");
  await sleep(200);
  await page.resize(WINDOW_RESIZED);
  await page.ev("document.getElementById('tab-diff').click(); return true;");
  await sleep(800);

  const second = await page.ev(MEASURE);
  out(`  замер после «вкладка → размер окна → назад»: ${shape(second)}`);
  for (const b of judgeCanvas(second)) notes.push(`полотно после пути болезни: ${b}`);

  return { notes };
}

/** ПРОВЕРКА 3: строка про неотслеживаемые под списком диффа. */
async function checkUntracked(page, expected) {
  const notes = [];
  const text = await page.ev("return document.getElementById('diff-files').textContent;");
  const hit = /неотслеж/i.test(text);
  const num = text.match(/(\d+)\s*неотслеж/i);
  out(`  строка под списком: ${hit ? 'есть' : 'НЕТ'}${num ? ` · число ${num[1]} (ожидание ${expected})` : ''}`);
  if (!hit) {
    notes.push('под списком диффа нет строки про неотслеживаемые — список выглядит полным, а он неполон');
    return { notes };
  }
  if (!num || Number(num[1]) !== expected) {
    notes.push(`число неотслеживаемых на странице ${num ? num[1] : '—'}, а git видит ${expected}`);
  }
  return { notes };
}

/** ПРОВЕРКА 2: кнопки редактора и отметка правки. */
async function checkButtons(page, standDir) {
  const notes = [];

  await page.ev("document.getElementById('tab-editor').click(); return true;");
  const opened = await page.ev(`
    const nodes = Array.from(document.querySelectorAll('#tree-root .node'));
    const want = nodes.find((n) => {
      const label = n.querySelector('.label');
      return label && label.textContent === 'b.txt';
    });
    if (!want) return false;
    want.click();
    return true;
  `);
  if (!opened) return { fatal: 'файла b.txt нет в дереве — открывать нечего' };
  if (!await page.waitFor("return document.getElementById('editor-path').textContent === 'b.txt' && !!document.querySelector('#editor-host .monaco-editor');")) {
    return { fatal: 'редактор не открыл файл — мерить нечего' };
  }
  await sleep(400);

  const state = `
    const save = document.getElementById('btn-save');
    const reload = document.getElementById('btn-reload');
    const dirty = document.getElementById('editor-dirty');
    return {
      save: save ? save.disabled : null,
      reload: reload ? reload.disabled : null,
      dirty: dirty ? dirty.hidden : null,
      dirtyExists: !!dirty,
      notice: document.getElementById('editor-notice').textContent,
    };
  `;

  const afterOpen = await page.ev(state);
  out(`  после открытия: «Сохранить» ${afterOpen.save ? 'неактивна' : 'АКТИВНА'}`
    + ` · отметка ${afterOpen.dirtyExists ? (afterOpen.dirty ? 'скрыта' : 'ВИДНА') : 'УЗЛА НЕТ'}`
    + ` · «Перечитать» ${afterOpen.reload ? 'НЕАКТИВНА' : 'активна'}`);
  if (afterOpen.save !== true) notes.push('«Сохранить» активна сразу после открытия файла без единой правки');
  if (!afterOpen.dirtyExists) notes.push('узла отметки правок #editor-dirty на странице нет');
  else if (afterOpen.dirty !== true) notes.push('отметка правок видна на только что открытом файле');
  if (afterOpen.reload !== false) notes.push('«Перечитать» неактивна при открытом файле');

  // ПРАВКА ИДЁТ В МОДЕЛЬ РЕДАКТОРА — тем же событием, что и нажатие клавиши: подписка
  // страницы висит на `onDidChangeModelContent`, и различать эти два пути ей нечем.
  const typed = await page.ev(`
    const list = (window.monaco && monaco.editor.getEditors) ? monaco.editor.getEditors() : [];
    const host = document.getElementById('editor-host');
    const ed = list.find((e) => e.getDomNode() && host.contains(e.getDomNode()));
    if (!ed) return false;
    ed.getModel().applyEdits([{ range: new monaco.Range(1, 1, 1, 1), text: 'X' }]);
    return true;
  `);
  if (!typed) return { fatal: 'редактор не найден среди поднятых — правку внести нечем', notes };
  await sleep(300);

  const afterEdit = await page.ev(state);
  out(`  после правки: «Сохранить» ${afterEdit.save ? 'НЕАКТИВНА' : 'активна'}`
    + ` · отметка ${afterEdit.dirty ? 'СКРЫТА' : 'видна'}`);
  if (afterEdit.save !== false) notes.push('«Сохранить» осталась неактивной после правки');
  if (afterEdit.dirty !== false) notes.push('отметка правок не появилась после правки');

  await page.ev("document.getElementById('btn-save').click(); return true;");
  if (!await page.waitFor("return document.getElementById('editor-notice').textContent.indexOf('сохранено') >= 0;")) {
    notes.push('после нажатия «Сохранить» страница не сказала «сохранено»');
  }
  await sleep(300);

  const afterSave = await page.ev(state);
  out(`  после сохранения: «Сохранить» ${afterSave.save ? 'неактивна' : 'АКТИВНА'}`
    + ` · отметка ${afterSave.dirty ? 'скрыта' : 'ВИДНА'} · ответ «${afterSave.notice}»`);
  if (afterSave.save !== true) notes.push('«Сохранить» осталась активной после сохранения');
  if (afterSave.dirty !== true) notes.push('отметка правок не погасла после сохранения');

  let disk = '';
  try {
    disk = await readFile(path.join(standDir, 'b.txt'), 'utf8');
  } catch {
    disk = '';
  }
  const onDisk = disk.startsWith('X');
  out(`  на диске: ${onDisk ? 'новый текст' : 'ПРЕЖНИЙ ТЕКСТ'} (${JSON.stringify(disk.split('\n')[0] || '')})`);
  if (!onDisk) notes.push('на диске остался прежний текст — сохранение не доехало');

  return { notes };
}

// --- прогон -------------------------------------------------------------------

function parseArgs(argv) {
  const args = { dir: null, negative: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { args.help = true; continue; }
    if (a === '--negative') { args.negative = argv[i + 1] || ''; i += 1; continue; }
    if (a.startsWith('--negative=')) { args.negative = a.slice('--negative='.length); continue; }
    if (a.startsWith('-')) return { ...args, bad: a };
    args.dir = a;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    out('Постоянные машинные проверки страницы пульта:');
    out('  node pult/tools/page-check.mjs [каталог для стендов] [--negative layout|buttons]');
    out('Отрицательные пробы правят ТОЛЬКО копию стенда: layout — прежний вызов размеров');
    out('во вкладке диффов, buttons — прежнее включение «Сохранить».');
    return 0;
  }
  if (args.bad) { err(`неизвестный ключ: ${args.bad}`); return 3; }
  if (args.negative !== null && !PROBES[args.negative]) {
    err('проба бывает только layout или buttons');
    return 3;
  }

  const browser = await findBrowser();
  if (!browser) {
    err('headless-браузера в окружении нет: не найден ни Chrome, ни Edge, ни Chromium');
    err('путь можно указать переменной CCKIT_CHROME; проверка страницы без браузера невозможна');
    return 3;
  }
  if (!await resolveCommand('git')) {
    err('git не разрешился по PATH — стенд-репозиторий не собрать, вкладку диффов мерить нечем');
    return 3;
  }

  const base = args.dir ? path.resolve(args.dir) : os.tmpdir();
  // Стенд внутри этого репозитория запрещён: демон стенда писал бы в рабочее дерево,
  // а копия пульта попадала бы под git и под приёмку.
  if (base === REPO || base.startsWith(`${REPO}${path.sep}`)) {
    err('каталог стендов обязан быть ВНЕ этого репозитория');
    return 3;
  }

  // КАНОНИЗАЦИЯ ОБЯЗАТЕЛЬНА, И ЭТО НЕ ПРИДИРКА. На Windows временный каталог приходит
  // КОРОТКИМ именем (`C:\Users\MANUKY~1\...`), а `findStatic()` в `pult/lib/static.mjs`
  // сверяет `realpath` файла с каталогом страницы — тот возвращает ДЛИННОЕ имя, вложенность
  // не сходится, и демон отвечает 404 на саму страницу. Прогон при этом выглядит как
  // «страница не показала проектов», то есть уводит разбор совсем в другую сторону.
  const parent = await realpath(await mkdtemp(path.join(base, 'pult-page-')));
  const cfg = await realpath(await mkdtemp(path.join(base, 'pult-cfg-')));
  // Реестр прогона СВОЙ: боевой — список проектов человека, и прогон, оборвавшийся посередине,
  // оставил бы в нём запись про временный каталог.
  process.env.APPDATA = cfg;
  process.env.XDG_CONFIG_HOME = cfg;

  const standPult = path.join(parent, 'pult');
  const standProject = path.join(parent, 'project');
  const profile = path.join(parent, 'chrome');

  let daemon = null;
  let chrome = null;
  let cdp = null;
  let code = 0;
  const notes = [];
  const daemonLog = [];

  try {
    out(`браузер: ${browser}`);
    out(`стенды:  ${parent}`);

    const tally = await mirror(PULT, standPult);
    try {
      await symlink(path.join(PULT, 'node_modules'), path.join(standPult, 'node_modules'), 'junction');
    } catch (e) {
      err(`node_modules не подключились к стенду (${(e && e.code) || 'ошибка'}) — демон не поднимется`);
      return 3;
    }
    out(`копия пульта: скопировано ${tally.copied}, жёстких ссылок ${tally.linked}`);

    const port = await freePort();
    const patched = await patchPort(standPult, port);
    if (!patched.ok) {
      err(`строка порта в копии не нашлась (вхождений ${patched.hits}) — прогон ничего не доказывает`);
      return 3;
    }
    out(`порт стенда: ${port} (боевой демон не трогается)`);

    if (args.negative) {
      const probe = PROBES[args.negative];
      const applied = await applyProbe(standPult, args.negative);
      if (!applied.ok) {
        err(`проба «${args.negative}» не наложилась (вхождений ${applied.hits}) — код изменился, проба ничего не докажет`);
        return 3;
      }
      out('');
      out(`ОТРИЦАТЕЛЬНАЯ ПРОБА «${args.negative}»: ${probe.what}`);
      out(`правится только копия: ${probe.file} в стенде; файлы репозитория не трогаются`);
      out('ожидаемый исход прогона — КРАСНЫЙ (код 1). Зелёный здесь означает, что проверка ничего не стережёт.');
      out('');
    }

    const stand = await makeStand(standProject);
    if (!stand.ok) {
      err(`${stand.why} — стенд не собрался`);
      return 3;
    }
    out(`стенд-проект: ${STAND_LINES} строк в a.txt, неотслеживаемых записей ${stand.untracked}`);
    if (stand.untracked !== STAND_UNTRACKED) {
      err(`ожидалось ${STAND_UNTRACKED} неотслеживаемых записи, git видит ${stand.untracked}`);
      return 3;
    }

    const added = await addProject(standProject, 'стенд страницы');
    if (!added.ok) {
      err('стенд не завёлся в реестр прогона');
      return 3;
    }

    daemon = spawn(process.execPath, [path.join(standPult, 'server.mjs')], {
      cwd: standPult,
      env: { ...process.env, APPDATA: cfg, XDG_CONFIG_HOME: cfg },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    daemon.stdout.on('data', (c) => daemonLog.push(c.toString('utf8')));
    daemon.stderr.on('data', (c) => daemonLog.push(c.toString('utf8')));
    if (!await waitHealth(port, Date.now() + DAEMON_START_MS)) {
      err('демон стенда не ответил — прогон ничего не доказывает');
      err(daemonLog.join('').split('\n').slice(0, 6).join('\n'));
      return 3;
    }

    const cdpPort = await freePort();
    chrome = spawn(browser, [
      '--headless=new',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profile}`,
      `--window-size=${WINDOW.width},${WINDOW.height}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-gpu',
      'about:blank',
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    chrome.stdout.on('data', () => {});
    chrome.stderr.on('data', () => {});

    const wsUrl = await browserSocket(cdpPort, Date.now() + BROWSER_START_MS);
    if (!wsUrl) {
      err('браузер не поднял протокол отладчика — прогон ничего не доказывает');
      return 3;
    }
    cdp = await connectCdp(wsUrl);

    const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const targetId = target.result && target.result.targetId;
    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = attached.result && attached.result.sessionId;
    if (!sessionId) {
      err('вкладка браузера не отдала сессию протокола — прогон ничего не доказывает');
      return 3;
    }

    const page = makePage(cdp, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: WINDOW.width, height: WINDOW.height, deviceScaleFactor: 1, mobile: false,
    }, sessionId);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` }, sessionId);

    if (!await page.waitFor("return document.querySelectorAll('#projects-list .project').length > 0;", 30000)) {
      // Диагностика печатается, а не проглатывается: «проектов нет» бывает и от неподнявшейся
      // страницы, и от пустого реестра, и это разные поломки.
      err('страница не показала ни одного проекта — прогон ничего не доказывает');
      try {
        const why = await page.ev(`
          return {
            href: location.href,
            ready: document.readyState,
            daemon: document.getElementById('daemon-text').textContent,
            list: document.getElementById('projects-list').textContent,
            title: document.title,
          };
        `);
        err(`страница: ${JSON.stringify(why)}`);
      } catch (e) {
        err(`страница не отвечает вовсе: ${(e && e.message) || 'без причины'}`);
      }
      const root = await ask(port, 'GET', '/');
      err(`демон на /: ${root.status} ${JSON.stringify(root.text.slice(0, 200))}`);
      const projects = await ask(port, 'GET', '/projects');
      err(`демон на /projects: ${projects.status} ${JSON.stringify(projects.json && projects.json.projects)}`);
      err(daemonLog.join('').split('\n').slice(0, 6).join('\n'));
      return 3;
    }
    await page.ev("document.querySelector('#projects-list .project').click(); return true;");
    if (!await page.waitFor("return document.querySelectorAll('#tree-root .node').length > 0;")) {
      err('дерево проекта не наполнилось — прогон ничего не доказывает');
      return 3;
    }
    out(`окно: ${WINDOW.width}×${WINDOW.height}, проект выбран`);
    out('');

    // 1. ПОЛОТНО СРАВНЕНИЯ.
    out('1. полотно сравнения (мерится редактор ВНУТРИ полотна):');
    await page.ev("document.getElementById('tab-diff').click(); return true;");
    const canvas = await checkCanvas(page);
    if (canvas.fatal) {
      err(canvas.fatal);
      return 3;
    }
    for (const n of canvas.notes) { notes.push(n); code = 1; }
    out(`  итог: ${canvas.notes.length ? 'КРАСНО' : 'зелено'}`);
    out('');

    // 3. СТРОКА ПРО НЕОТСЛЕЖИВАЕМЫЕ — на той же вкладке, пока список перед глазами.
    out('3. строка про неотслеживаемые файлы:');
    const untracked = await checkUntracked(page, stand.untracked);
    for (const n of untracked.notes) { notes.push(n); code = 1; }
    out(`  итог: ${untracked.notes.length ? 'КРАСНО' : 'зелено'}`);
    out('');

    // 2. КНОПКИ РЕДАКТОРА.
    out('2. кнопки редактора и отметка правки:');
    const buttons = await checkButtons(page, standProject);
    for (const n of buttons.notes || []) { notes.push(n); code = 1; }
    if (buttons.fatal) {
      err(buttons.fatal);
      return 3;
    }
    out(`  итог: ${(buttons.notes || []).length ? 'КРАСНО' : 'зелено'}`);
    out('');
  } finally {
    // Уборка: сначала браузер (закрывается по протоколу — иначе его потомки переживут прогон
    // и удержат профиль), потом демон, потом каталоги. Занятость терпится и называется строкой.
    if (cdp) {
      try { await cdp.send('Browser.close', {}); } catch { /* уже закрыт */ }
      cdp.close();
    }
    if (chrome) { try { chrome.kill(); } catch { /* уже мёртв */ } }
    if (daemon) { try { daemon.kill(); } catch { /* уже мёртв */ } }
    await sleep(800);
    for (const dir of [parent, cfg]) {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch (e) {
        out(`стенд занят, удалить вручную: ${dir} (${(e && e.code) || 'ошибка'})`);
      }
    }
  }

  if (notes.length) {
    out('расхождения:');
    for (const n of notes) out(`  • ${n}`);
  } else {
    out('расхождений нет: полотно живо после изменения размера, «Сохранить» включается правкой,');
    out('неполнота списка диффов названа строкой');
  }

  if (args.negative) {
    out('');
    if (code === 0) {
      err(`ПРОБА «${args.negative}» НЕ ПОКРАСНЕЛА — проверка ничего не стережёт`);
      return 2;
    }
    out(`проба «${args.negative}» покраснела, как и обязана: проверка умеет провалиться`);
  }
  return code;
}

main().then((c) => process.exit(c)).catch((e) => {
  err(`прогон не состоялся: ${(e && (e.code || e.name || e.message)) || 'ошибка'}`);
  process.exit(3);
});
