#!/usr/bin/env node
/**
 * ПОСТОЯННЫЕ МАШИННЫЕ ПРОВЕРКИ ОБОЛОЧКИ: значок, выход и процессы после выхода.
 *
 *   node pult/tools/shell-check.mjs [каталог для стендов] [--negative trayicon|trayexit|quitleak]
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ИНСТРУМЕНТ, А НЕ ПРОВЕРКА В `page-check.mjs`. Тот меряет СТРАНИЦУ в обычном
 * браузере и в своей шапке прямо говорит, что об оболочке не сообщает ничего. Здесь другая
 * аппаратура (настоящий процесс Electron, область уведомлений, счёт процессов) и другая модель
 * отказа: нет Electron — прогон невозможен и обязан честно сказать «ничего не доказано»,
 * а страницу при этом мерить можно. Смешать их значило бы сделать проверку страницы
 * зависимой от Electron, которого у человека, поднимающего только демон, нет.
 *
 * ЧТО МЕРИТСЯ И КОГДА КРАСНЕЕТ:
 *
 *   1. ЗНАЧОК И МЕНЮ. Внутри настоящего Electron зовутся `buildIcon()` и `menuTemplate()`
 *      из `pult/shell/tray.mjs`. Краснеет, если картинка не построилась, оказалась ПУСТОЙ
 *      (пустой значок на Windows невидим — это и выглядит как «трея нет»), не того размера,
 *      если `createTray()` вернул `ok: false` или бросил, либо если в меню нет пункта выхода
 *      с обработчиком. Проверка заведена по находке человека 02.09.2026: «трея нет вовсе».
 *
 *   2. ВЫХОД НЕ ЗАВИСИТ ОТ ТРЕЯ. Сценарий воспроизводит худший случай: значок НЕ построился
 *      (правкой копии стенда), окно закрывается — и приложение обязано ЗАВЕРШИТЬСЯ. Краснеет,
 *      если процесс жив после закрытия окна. Раньше он оставался жить невидимым, и убить его
 *      можно было только диспетчером задач. Проверка ждёт ПОКАЗАННОГО окна, а не загруженной
 *      страницы: `WM_CLOSE` доходит только до показанных, и без этого ожидания она краснела
 *      на здоровом коде раз из трёх (находка ревью 02.09.2026).
 *
 *      ОГОВОРКА, БЕЗ КОТОРОЙ ПРОВЕРКА 3 ОБЕЩАЕТ БОЛЬШЕ, ЧЕМ МЕРИТ: на Windows брошенный
 *      ребёнок уходит вместе с родителем сам, и отличить «мы погасили демон» от «его погасила
 *      система» она НЕ МОЖЕТ. Это выяснено пробой: правка, снимавшая вызов останова демона,
 *      проверку не покраснила. Поэтому пробой стережётся то, что проверка действительно
 *      различает, — незавершившееся приложение; а «свой демон гасится нами» держится разбором
 *      кода и пробами `daemon.mjs`, а не этим прогоном.
 *
 *   3. ПОСЛЕ ВЫХОДА НЕ ОСТАЁТСЯ ПРОЦЕССОВ. Оболочка поднимается штатно, гасится штатно, затем
 *      считаются процессы: главный процесс Electron и демон, которого он поднял. Краснеет,
 *      если жив хоть один. Номера берутся не на глаз: главный — это наш ребёнок, номер демона
 *      оболочка печатает сама. Живость проверяется `process.kill(pid, 0)` — без внешних
 *      утилит; переиспользование номера за несколько секунд названо и принято.
 *
 * СТЕНД СВОЙ. Копия пульта в временном каталоге, свой свободный порт (правкой `PORT` в копии),
 * свой каталог настроек через `APPDATA`/`XDG_CONFIG_HOME`. Боевой демон и боевой реестр
 * не трогаются. Каталоги зависимостей подключаются точками соединения: Electron весит сотни
 * мегабайт, копировать его на каждый прогон бессмысленно.
 *
 * ОТРИЦАТЕЛЬНЫЕ ПРОБЫ ВСТРОЕНЫ, потому что «проверка обязана уметь провалиться» — это свойство,
 * которое надо показывать в любой день, а не только в день написания. Правится ТОЛЬКО копия.
 *
 * И ВТОРОЕ ТРЕБОВАНИЕ К СТОРОЖУ, РОВНО ТАКОЕ ЖЕ ПО ВАЖНОСТИ: он не имеет права МИГАТЬ.
 * Мигающий сторож хуже отсутствующего — он создаёт видимость покрытия, и его отключают первым.
 * Проверка 2 этим болела (краснела на здоровом коде раз из трёх) и вылечена ожиданием
 * ПОКАЗАННОГО окна; правя эти проверки, держите в голове оба требования сразу.
 *
 * Коды возврата: 0 — всё зелено; 1 — проверка провалилась (для отрицательной пробы это
 * ожидаемый исход); 2 — проба НЕ покраснела, то есть проверка ничего не стережёт;
 * 3 — прогон ничего не доказывает (нет Electron, стенд не собрался, окно не открылось).
 */

import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile,
} from 'node:fs/promises';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PULT = path.resolve(HERE, '..');
const REPO = path.resolve(PULT, '..');

const SHELL_START_MS = 40000;
const WINDOW_WAIT_MS = 40000;
const QUIT_WAIT_MS = 20000;
const DEAD_WAIT_MS = 15000;
const CDP_WAIT_MS = 20000;

const out = (s = '') => process.stdout.write(`${s}\n`);
const err = (s = '') => process.stderr.write(`[pult] ${s}\n`);
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** Жив ли процесс. Без внешних утилит: сигнал 0 ничего не делает, но сообщает о наличии. */
function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// --- стенд --------------------------------------------------------------------

/** Свободный порт: демон стенда не имеет права занимать боевой. */
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

/**
 * Копия пульта под стенд. Оба каталога зависимостей пропускаются: и у демона, и у оболочки
 * они подключаются точками соединения — Electron весит сотни мегабайт.
 */
async function mirror(src, dst, rel = '', tally = { copied: 0 }) {
  await mkdir(dst, { recursive: true });
  for (const name of (await readdir(src)).sort()) {
    if (name === 'node_modules') continue;
    const from = path.join(src, name);
    const to = path.join(dst, name);
    const childRel = rel ? `${rel}/${name}` : name;
    let st;
    try {
      st = await lstat(from);
    } catch {
      continue;
    }
    if (st.isDirectory()) { await mirror(from, to, childRel, tally); continue; }
    if (!st.isFile()) continue;
    await copyFile(from, to);
    tally.copied += 1;
  }
  return tally;
}

/** Точка соединения на каталог зависимостей: разрешение модулей её переживает. */
async function junction(target, link) {
  try {
    await symlink(target, link, 'junction');
    return true;
  } catch {
    try {
      await symlink(target, link, 'dir');
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Правка одной строки в КОПИИ. Замена по строкам, а не `replace()` со строкой: в текстах
 * набора живут `$` и обратные кавычки, а спецпоследовательности замены уже дважды портили файл.
 */
async function patchLine(file, prefix, line) {
  const lines = (await readFile(file, 'utf8')).split('\n');
  let hits = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith(prefix)) { lines[i] = line; hits += 1; }
  }
  if (hits !== 1) return false;
  await writeFile(file, lines.join('\n'), 'utf8');
  return true;
}

/** Замена куска текста в КОПИИ через `split/join`: спецпоследовательностей она не знает. */
async function patchText(file, from, to) {
  const text = await readFile(file, 'utf8');
  const parts = text.split(from);
  if (parts.length !== 2) return { ok: false, hits: parts.length - 1 };
  await writeFile(file, parts.join(to), 'utf8');
  return { ok: true, hits: 1 };
}

/**
 * СЦЕНАРНАЯ ПРАВКА (не проба): сломать построение значка. Проверка 2 меряет именно худший
 * случай — «значка нет», — и наводится он здесь, в копии.
 */
const ICON_BREAK = {
  from: '    const image = nativeImage.createFromBitmap(buf, { width: size, height: size });',
  to: '    const image = null; void buf;',
};

/** ОТРИЦАТЕЛЬНЫЕ ПРОБЫ: вернуть в КОПИЮ прежнюю (больную) форму кода. */
const PROBES = Object.freeze({
  trayblank: {
    file: 'shell/tray.mjs',
    what: 'рисунок не наносится — значок выходит ПОЛНОСТЬЮ ПРОЗРАЧНЫМ, и прежний предикат isEmpty() такой пропускал',
    from: '        if (!color) continue;',
    to: '        continue;',
  },
  trayicon: {
    file: 'shell/tray.mjs',
    what: 'построение значка возвращает пустую картинку — прежняя форма «пустая иконка не беда»',
    from: '    return image.isEmpty() ? null : image;',
    to: '    return nativeImage.createEmpty();',
  },
  trayexit: {
    file: 'shell/main.mjs',
    what: 'закрытие окна прячет его безусловно — прежняя форма обработчика close',
    from: '    if (!trayOk) {',
    to: '    if (false) {',
  },
  quitstuck: {
    file: 'shell/main.mjs',
    what: 'выход не доводится до конца — приложение остаётся жить после «Выхода»',
    from: '  app.exit(code);',
    to: '  void code;',
  },
});

// --- разговор с оболочкой -----------------------------------------------------

/** Найти Electron в каталоге оболочки. Нет — прогон ничего не доказывает. */
async function findElectron(shellDir) {
  const file = path.join(shellDir, 'node_modules', 'electron', 'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron');
  try {
    const st = await lstat(file);
    if (st.isFile()) return file;
  } catch { /* нет */ }
  return null;
}

/**
 * Запуск оболочки стенда. Переменная запуска Electron в режиме Node снимается ЯВНО: она
 * бывает выставлена в окружении редактора, и под ней Electron стартует обычным Node — окна
 * не будет вовсе, а прогон покажет «окно не открылось» и уведёт разбор в сторону.
 */
function startShell(electron, appDir, cfg, cdpPort) {
  const env = { ...process.env, APPDATA: cfg, XDG_CONFIG_HOME: cfg };
  for (const name of Object.keys(env)) {
    if (name.toUpperCase().startsWith('ELECTRON_')) delete env[name];
  }
  const child = spawn(electron, [appDir, `--remote-debugging-port=${cdpPort}`], {
    cwd: appDir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const log = [];
  child.stdout.on('data', (c) => log.push(c.toString('utf8')));
  child.stderr.on('data', (c) => log.push(c.toString('utf8')));
  return { child, log };
}

/** Дождаться строки в журнале оболочки. */
async function waitLog(log, needle, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (log.join('').includes(needle)) return true;
    await sleep(200);
  }
  return false;
}

/** Номер процесса демона оболочка печатает сама — берём оттуда, а не угадываем. */
function daemonPid(log) {
  const m = log.join('').match(/номер процесса (\d+)/);
  return m ? Number(m[1]) : null;
}

/** Список целей протокола отладчика: по нему видно, открылось ли окно. */
function cdpTargets(port) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/json', method: 'GET' }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(text)); } catch { resolve(null); }
      });
    });
    req.setTimeout(3000, () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

/** Дождаться окна с нашей страницей. */
async function waitWindow(port, url, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const list = await cdpTargets(port);
    const page = Array.isArray(list) ? list.find((t) => t.type === 'page' && String(t.url).startsWith(url)) : null;
    if (page) return page;
    await sleep(300);
  }
  return null;
}

/** Одна команда протокола отладчика по адресу сокета. */
function cdpCall(wsUrl, method, params = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      finish(false);
      return;
    }
    const timer = setTimeout(() => { try { ws.close(); } catch { /* уже закрыт */ } finish(false); }, CDP_WAIT_MS);
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method, params })));
    ws.addEventListener('message', () => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* уже закрыт */ }
      finish(true);
    });
    ws.addEventListener('error', () => { clearTimeout(timer); finish(false); });
  });
}

/**
 * Одно выражение на странице; наружу — ЗНАЧЕНИЕ, а не факт ответа.
 *
 * Нужно ровно для одного: спросить окно, показано ли оно. Отдельная функция, потому что
 * `cdpCall()` возвращает «ответ пришёл», а здесь важно, ЧТО в ответе.
 */
function cdpEval(wsUrl, expression) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      finish(null);
      return;
    }
    const timer = setTimeout(() => { try { ws.close(); } catch { /* уже закрыт */ } finish(null); }, CDP_WAIT_MS);
    ws.addEventListener('open', () => ws.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true },
    })));
    ws.addEventListener('message', (e) => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* уже закрыт */ }
      let value = null;
      try {
        const m = JSON.parse(e.data);
        value = m.result && m.result.result ? m.result.result.value : null;
      } catch { value = null; }
      finish(value);
    });
    ws.addEventListener('error', () => { clearTimeout(timer); finish(null); });
  });
}

/**
 * ДОЖДАТЬСЯ ПОКАЗАННОГО ОКНА, А НЕ ЗАГРУЖЕННОЙ СТРАНИЦЫ.
 *
 * Находка ревью 02.09.2026: проверка 2 краснела на здоровом коде один раз из трёх. Механизм —
 * строку «окно открыто» оболочка печатает СРАЗУ ПОСЛЕ `loadURL`, до того как окно показано
 * (`ready-to-show`), а `WM_CLOSE` доходит только до показанных окон. То есть проверка стреляла
 * в окно, которого ещё нет на экране, и результат зависел от гонки.
 *
 * Признак взят у самой страницы: `visibilityState` браузер держит `hidden`, пока окно скрыто.
 * Мигающий сторож хуже отсутствующего — его отключают.
 */
async function waitVisible(wsUrl, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const state = await cdpEval(wsUrl, 'document.visibilityState');
    if (state === 'visible') return true;
    if (Date.now() >= deadline) return false;
    await sleep(300);
  }
}

/** Ждём смерти процессов; вернули `true` — все ушли. */
async function waitDead(pids, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const live = pids.filter((p) => alive(p));
    if (!live.length) return { dead: true, live };
    if (Date.now() >= deadline) return { dead: false, live };
    await sleep(300);
  }
}

// --- проверка 1: значок и меню ------------------------------------------------

/**
 * Пробник кладётся В КОПИЮ и запускается настоящим Electron: только так можно позвать
 * `buildIcon()` и `createTray()` — вне Electron их нет.
 */
const PROBE_MAIN = [
  "const { app, Menu } = require('electron');",
  "const path = require('node:path');",
  'const NL = String.fromCharCode(10);',
  "const say = (o) => process.stdout.write('ICONCHECK ' + JSON.stringify(o) + NL);",
  "process.on('uncaughtException', (e) => { say({ ошибка: String(e && e.message).slice(0, 200) }); app.exit(1); });",
  'setTimeout(() => { say({ ошибка: NL }); app.exit(2); }, 20000);',
  'app.whenReady().then(async () => {',
  "  const url = 'file:///' + path.join(__dirname, 'tray.mjs').split(String.fromCharCode(92)).join('/');",
  '  const tray = await import(url);',
  '  const icon = typeof tray.buildIcon === function_check ? tray.buildIcon() : null;',
  '  const size = icon ? icon.getSize() : null;',
  '  let created = null;',
  '  let error = null;',
  '  try {',
  '    const r = tray.createTray({ onShow: () => {}, onQuit: () => {} });',
  '    created = r && r.ok === true && r.tray && !r.tray.isDestroyed();',
  '    if (r && r.error) error = String(r.error).slice(0, 160);',
  '  } catch (e) { error = String(e && e.message).slice(0, 160); }',
  "  const tpl = typeof tray.menuTemplate === function_check ? tray.menuTemplate() : [];",
  "  const quit = tpl.find((i) => String(i.label || '').indexOf('Выход') >= 0);",
  '  say({',
  '    построена: Boolean(icon),',
  '    пуста: icon ? icon.isEmpty() : null,',
  '    размер: size,',
  '    трей: created,',
  '    ошибка: error,',
  '    пунктов: tpl.filter((i) => i.label).length,',
  '    выход: Boolean(quit && typeof quit.click === function_check),',
  '  });',
  '  setTimeout(() => app.exit(0), 300);',
  '});',
].join('\n').split('function_check').join("'function'");

async function checkIcon(electron, standShell, cfg) {
  const notes = [];
  const probeDir = path.join(standShell, 'iconcheck');
  await mkdir(probeDir, { recursive: true });
  await writeFile(path.join(probeDir, 'main.cjs'), PROBE_MAIN, 'utf8');
  await writeFile(path.join(probeDir, 'package.json'), '{ "name": "iconcheck", "private": true, "version": "0.0.0", "main": "main.cjs" }\n', 'utf8');
  // Пробник лежит ВНУТРИ каталога оболочки стенда, чтобы `require('electron')` разрешился
  // через ту же точку соединения, и импортирует `../tray.mjs` — настоящий, не копию копии.
  await patchText(path.join(probeDir, 'main.cjs'), "path.join(__dirname, 'tray.mjs')", "path.join(__dirname, '..', 'tray.mjs')");

  const env = { ...process.env, APPDATA: cfg, XDG_CONFIG_HOME: cfg };
  for (const name of Object.keys(env)) {
    if (name.toUpperCase().startsWith('ELECTRON_')) delete env[name];
  }
  const text = await new Promise((resolve) => {
    const child = spawn(electron, [probeDir], { cwd: probeDir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let buf = '';
    child.stdout.on('data', (c) => { buf += c.toString('utf8'); });
    child.stderr.on('data', (c) => { buf += c.toString('utf8'); });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* мёртв */ } }, 40000);
    child.on('close', () => { clearTimeout(timer); resolve(buf); });
    child.on('error', () => { clearTimeout(timer); resolve(buf); });
  });

  const line = text.split('\n').find((l) => l.startsWith('ICONCHECK '));
  if (!line) return { fatal: `пробник значка ничего не сказал: ${text.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 200)}` };
  let r;
  try { r = JSON.parse(line.slice('ICONCHECK '.length)); } catch { return { fatal: 'ответ пробника значка не разобрался' }; }

  out(`  картинка: построена ${r.построена ? 'да' : 'НЕТ'} · пуста ${r.пуста === null ? '—' : (r.пуста ? 'ДА' : 'нет')}`
    + ` · размер ${r.размер ? `${r.размер.width}×${r.размер.height}` : '—'}`);
  out(`  трей: создан ${r.трей ? 'да' : 'НЕТ'}${r.ошибка ? ` · ошибка «${r.ошибка}»` : ''} · пунктов меню ${r.пунктов} · выход ${r.выход ? 'есть' : 'НЕТ'}`);

  if (!r.построена) notes.push('значок не построился — на Windows это невидимая иконка, то есть «трея нет»');
  if (r.пуста) notes.push('значок построился ПУСТЫМ — на Windows он невидим');
  if (r.размер && (r.размер.width < 16 || r.размер.height < 16)) notes.push(`значок ${r.размер.width}×${r.размер.height} — мельче, чем нужно области уведомлений`);
  if (!r.трей) notes.push(`трей не создан${r.ошибка ? `: ${r.ошибка}` : ''}`);
  if (r.пунктов < 4) notes.push(`в меню трея ${r.пунктов} пунктов, а обещано четыре`);
  if (!r.выход) notes.push('в меню трея нет пункта выхода с обработчиком — приложение стало бы незакрываемым');
  return { notes };
}

// --- проверки 2 и 3: выход и процессы -----------------------------------------

/**
 * ПРОВЕРКА 2: выход не зависит от трея.
 *
 * Сценарий — худший случай: значок НЕ построился (правка копии), окно закрывается. Приложение
 * обязано завершиться. Раньше оно пряталось в несуществующий значок и жило дальше невидимым.
 */
async function checkExitWithoutTray(electron, standShell, cfg, url, cdpPort) {
  const notes = [];
  const { child, log } = startShell(electron, standShell, cfg, cdpPort);
  const pid = child.pid;

  if (!await waitLog(log, 'окно открыто', SHELL_START_MS)) {
    try { child.kill(); } catch { /* мёртв */ }
    return { fatal: `оболочка со сломанным значком не открыла окно: ${log.join('').split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 220)}` };
  }
  const negodenSaid = log.join('').includes('трей негоден (');
  out(`  оболочка сказала про негодный трей: ${negodenSaid ? 'да' : 'НЕТ'}`);
  if (!negodenSaid) notes.push('значок сломан, а оболочка о негодном трее не сказала ни строкой');

  /**
   * ЖДЁМ ПОКАЗАННОГО ОКНА, А НЕ СТРОКИ В ЖУРНАЛЕ.
   *
   * Находка ревью 02.09.2026: проверка краснела на здоровом коде раз из трёх. Строку
   * «окно открыто» оболочка печатает СРАЗУ ПОСЛЕ `loadURL`, до `ready-to-show`, а `WM_CLOSE`
   * доходит только до показанных окон — то есть выстрел уходил в окно, которого ещё нет
   * на экране, и исход зависел от гонки. Мигающий сторож хуже отсутствующего.
   */
  const page = await waitWindow(cdpPort, url, WINDOW_WAIT_MS);
  if (!page) {
    try { child.kill(); } catch { /* мёртв */ }
    return { fatal: 'окно не отдало цель протокола отладчика — закрывать нечего', notes };
  }
  if (!await waitVisible(page.webSocketDebuggerUrl, WINDOW_WAIT_MS)) {
    try { child.kill(); } catch { /* мёртв */ }
    return { fatal: 'окно так и не стало показанным — крестиком его не закрыть', notes };
  }
  out('  окно показано (страница сообщает visible) — закрываю крестиком');

  /**
   * ЗАКРЫВАЕМ ИМЕННО ОКНО И ИМЕННО ТАК, КАК ЧЕЛОВЕК КРЕСТИКОМ, — то есть сообщением WM_CLOSE.
   *
   * Это выяснено пробой, а не взято из документации: `window.close()` со страницы через
   * протокол отладчика обработчик `close` окна НЕ ПОДНИМАЕТ вовсе — окно уходит мимо него,
   * и проверка меряла бы совсем другой путь (в первой редакции она из-за этого не краснела
   * на заведомо больном коде). WM_CLOSE посылает `taskkill` БЕЗ ключа принуждения.
   */
  const kill = spawn('taskkill', ['/PID', String(pid)], { windowsHide: true, stdio: 'ignore' });
  await new Promise((r) => { kill.on('close', r); kill.on('error', r); });

  const gone = await waitDead([pid], DEAD_WAIT_MS);
  out(`  после закрытия окна процесс оболочки ${gone.dead ? 'ушёл' : 'ЖИВ'} (номер ${pid})`);
  if (!gone.dead) {
    notes.push('окно закрыто, значка нет, а приложение живо — закрыть его можно только диспетчером задач');
    try { process.kill(pid); } catch { /* мёртв */ }
    await sleep(1500);
  }
  return { notes };
}

/**
 * ПРОВЕРКА 3: после штатного выхода не остаётся процессов.
 *
 * Считаются двое: главный процесс Electron (наш ребёнок) и демон, которого оболочка подняла, —
 * его номер она печатает сама. Живость меряется сигналом 0: внешних утилит не нужно.
 * Оговорка принята и названа: номер процесса система переиспользует, но не за те секунды,
 * что проходят между выходом и замером.
 */
async function checkNoLeftovers(electron, standShell, cfg, url, cdpPort) {
  const notes = [];
  const { child, log } = startShell(electron, standShell, cfg, cdpPort);
  const pid = child.pid;

  if (!await waitLog(log, 'окно открыто', SHELL_START_MS)) {
    try { child.kill(); } catch { /* мёртв */ }
    return { fatal: `оболочка не открыла окно: ${log.join('').split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 220)}` };
  }
  const dpid = daemonPid(log);
  out(`  поднято: оболочка ${pid}, демон ${dpid || 'номер не назван'}`);
  if (!dpid) return { fatal: 'оболочка не назвала номер процесса демона — считать нечего' };
  if (!alive(dpid)) return { fatal: 'демон стенда умер до выхода — прогон ничего не доказывает' };

  const page = await waitWindow(cdpPort, url, WINDOW_WAIT_MS);
  if (!page) {
    try { child.kill(); } catch { /* мёртв */ }
    return { fatal: 'окно не отдало цель протокола отладчика' };
  }

  // Штатный выход: та же дорога, что у пункта «Выход» в меню трея, — `app.quit()`.
  await cdpCall(page.webSocketDebuggerUrl, 'Browser.close', {});
  await sleep(1000);

  const gone = await waitDead([pid, dpid], QUIT_WAIT_MS);
  out(`  после выхода живых процессов: ${gone.live.length}${gone.live.length ? ` (${gone.live.join(', ')})` : ''}`);
  if (!gone.dead) {
    const who = gone.live.map((p) => (p === pid ? 'оболочка' : 'демон')).join(' и ');
    notes.push(`после выхода остались процессы: ${who} (${gone.live.join(', ')})`);
    for (const p of gone.live) { try { process.kill(p); } catch { /* мёртв */ } }
    await sleep(1500);
  }
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
    out('Постоянные машинные проверки оболочки пульта:');
    out(`  node pult/tools/shell-check.mjs [каталог для стендов] [--negative ${Object.keys(PROBES).join('|')}]`);
    out('Отрицательные пробы правят ТОЛЬКО копию стенда и возвращают прежнюю (больную) форму:');
    for (const [name, p] of Object.entries(PROBES)) out(`  ${name.padEnd(10)} ${p.what}`);
    return 0;
  }
  if (args.bad) { err(`неизвестный ключ: ${args.bad}`); return 3; }
  if (args.negative !== null && !PROBES[args.negative]) {
    err(`проба бывает только: ${Object.keys(PROBES).join(', ')}`);
    return 3;
  }

  const electronReal = await findElectron(path.join(PULT, 'shell'));
  if (!electronReal) {
    err('Electron не установлен: нет pult/shell/node_modules/electron/dist');
    err('поставить — npm ci в pult/shell, затем node node_modules/electron/install.js');
    return 3;
  }

  const base = args.dir ? path.resolve(args.dir) : os.tmpdir();
  if (base === REPO || base.startsWith(`${REPO}${path.sep}`)) {
    err('каталог стендов обязан быть ВНЕ этого репозитория');
    return 3;
  }

  const parent = await realpath(await mkdtemp(path.join(base, 'pult-shell-')));
  const cfg = await realpath(await mkdtemp(path.join(base, 'pult-cfg-')));
  const stand = path.join(parent, 'pult');
  const standShell = path.join(stand, 'shell');

  let code = 0;
  const notes = [];
  try {
    const tally = await mirror(PULT, stand);
    out(`стенд: ${parent}`);
    out(`копия пульта: файлов ${tally.copied}`);
    if (!await junction(path.join(PULT, 'node_modules'), path.join(stand, 'node_modules'))) {
      err('не подключились зависимости демона — прогон ничего не доказывает');
      return 3;
    }
    if (!await junction(path.join(PULT, 'shell', 'node_modules'), path.join(standShell, 'node_modules'))) {
      err('не подключились зависимости оболочки — прогон ничего не доказывает');
      return 3;
    }

    const port = await freePort();
    if (!await patchLine(path.join(stand, 'config.mjs'), 'export const PORT = ', `export const PORT = ${port};`)) {
      err('строка порта в копии не нашлась — стенд занял бы боевой порт, прогон отменён');
      return 3;
    }
    out(`порт стенда: ${port} (боевой демон не трогается)`);

    const electron = await findElectron(standShell);
    if (!electron) { err('Electron не виден через точку соединения стенда'); return 3; }
    const url = `http://127.0.0.1:${port}/`;

    if (args.negative) {
      const probe = PROBES[args.negative];
      const r = await patchText(path.join(stand, ...probe.file.split('/')), probe.from, probe.to);
      if (!r.ok) {
        err(`проба «${args.negative}» не наложилась (вхождений ${r.hits}) — код изменился, доказывать нечего`);
        return 3;
      }
      out(`ОТРИЦАТЕЛЬНАЯ ПРОБА «${args.negative}»: ${probe.what}`);
    }
    out('');

    out('1. значок и меню трея:');
    const icon = await checkIcon(electron, standShell, cfg);
    if (icon.fatal) { err(icon.fatal); return 3; }
    for (const n of icon.notes) { notes.push(n); code = 1; }
    out(`  итог: ${icon.notes.length ? 'КРАСНО' : 'зелено'}`);
    out('');

    out('3. после штатного выхода не остаётся процессов:');
    const left = await checkNoLeftovers(electron, standShell, cfg, url, await freePort());
    if (left.fatal) { err(left.fatal); return 3; }
    for (const n of left.notes) { notes.push(n); code = 1; }
    out(`  итог: ${left.notes.length ? 'КРАСНО' : 'зелено'}`);
    out('');

    // Проверка 2 идёт последней: она ломает значок в копии, и после неё стенд «больной».
    out('2. выход не зависит от трея (значок сломан намеренно):');
    const broke = await patchText(path.join(stand, 'shell', 'tray.mjs'), ICON_BREAK.from, ICON_BREAK.to);
    if (!broke.ok) { err(`сценарную правку значка наложить не удалось (вхождений ${broke.hits})`); return 3; }
    const exitOk = await checkExitWithoutTray(electron, standShell, cfg, url, await freePort());
    if (exitOk.fatal) { err(exitOk.fatal); return 3; }
    for (const n of exitOk.notes) { notes.push(n); code = 1; }
    out(`  итог: ${exitOk.notes.length ? 'КРАСНО' : 'зелено'}`);
    out('');
  } finally {
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
    out('расхождений нет: значок строится непустым, меню несёт выход, после выхода процессов');
    out('не остаётся, а закрытие окна без годного трея завершает приложение');
  }

  if (args.negative) {
    out('');
    if (code === 0) {
      err(`ПРОБА «${args.negative}» НЕ ПОКРАСНЕЛА — проверка ничего не стережёт`);
      return 2;
    }
    out(`проба «${args.negative}» покраснела — проверка стережёт то, что обещает`);
    return 1;
  }
  return code;
}

main().then((c) => process.exit(c)).catch((e) => {
  err(`не отработал: ${(e && e.stack) || 'ошибка'}`);
  process.exit(3);
});
