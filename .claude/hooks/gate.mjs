#!/usr/bin/env node
/**
 * Stop-хук (Claude Agent Kit) — машинная приёмка: не даёт закончить ход с красными проверками.
 * Кроссплатформенно, БЕЗ внешних зависимостей: только встроенные модули `node:*`.
 *
 * Как это работает. Гейт молчит, пока его не взвели: `implementer` перед первым шагом плана
 * выполняет `gate.mjs --arm` (без аргумента — название берётся из активной задачи), и это
 * записывает состояние в `.claude/artifacts/GATE_STATE.json`. Дальше на каждом завершении
 * хода гейт:
 *   • сверяет набор проверок с тем, что был на момент взвода (`checks_hash`),
 *   • запускает `verify.mjs`,
 *   • на красном результате возвращает ход агенту (`exit 2`) с текстом упавшей проверки.
 * Зелёный прогон снимает взвод сам (`status: verified`). Три неудачи подряд, TTL 6 часов и
 * подмена набора проверок переводят задачу в `blocked` — дальше решает человек.
 *
 * ⚠️ Честно о границах: это рубеж ВИДИМОСТИ, а не непроходимая стена. Обойти гейт можно —
 * но каждый обход остаётся осознанным действием, видимым в логе. Снятие гейта — дело человека,
 * рычаги перечислены в `.claude/CUSTOMIZE.md`, раздел «Машинная приёмка».
 *
 * ⚠️ Любой инфраструктурный сбой (нет `verify.mjs`, таймаут, битый JSON состояния, ошибка
 * внутри хука) — это `exit 0` и одна внятная строка. Блокировать ход можно только честно
 * красной проверкой: сломанный хук, останавливающий работу, отключат в тот же день.
 *
 * stdin НЕ читаем: данные Stop-события хуку не нужны, а чтение fd 0 на Windows отдаёт EAGAIN.
 *
 * Ручной запуск:
 *   node .claude/hooks/gate.mjs                    как из Stop-хука (обычно не нужно руками)
 *   node .claude/hooks/gate.mjs --arm              взвести приёмку на активную задачу
 *   node .claude/hooks/gate.mjs --arm "задача"     то же, но название задать руками (человеку)
 *   node .claude/hooks/gate.mjs --status           что сейчас в состоянии
 *   node .claude/hooks/gate.mjs --dry              посчитать решение, ничего не блокируя
 *   node .claude/hooks/gate.mjs --selftest         состояние, verify.mjs и рычаги для человека
 *   node .claude/hooks/gate.mjs --disarm           снять взвод (действие человека)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const KIT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROJECT_ROOT = path.dirname(KIT_DIR);
const STATE = path.join(KIT_DIR, 'artifacts', 'GATE_STATE.json');
const VERIFY = path.join(KIT_DIR, 'hooks', 'verify.mjs');
const VERIFY_JSON = path.join(KIT_DIR, 'artifacts', 'VERIFY.json');
const GIT_STATUS = path.join(KIT_DIR, 'hooks', 'git-status.mjs');
const TASKS = path.join(KIT_DIR, 'tasks');
const TASKS_ACTIVE = path.join(TASKS, 'ACTIVE');
const TASK_MJS = path.join(KIT_DIR, 'hooks', 'task.mjs');
const EVENTS_MJS = path.join(KIT_DIR, 'hooks', 'events.mjs');

// Форма идентификатора задачи — та же, что в task.mjs. `ACTIVE` правят руками и через
// `echo >`, поэтому доверия к его содержимому ровно столько же, сколько к аргументу.
const TASK_ID_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*$/;
const TASK_ID_MAX = 80;

const MAX_ATTEMPTS = 3;
const STALE_HOURS = 6;
const VERIFY_TIMEOUT_MS = 870 * 1000;   // меньше таймаута самого хука (900 с) в settings.json
const TAG = '[gate]';

// Пределы хвоста упавшей проверки при печати в stderr (см. `cleanTail`). Свои, а не взятые
// на веру из verify.mjs: тот режет вывод до 40 строк и 4 КБ, но `VERIFY.json` — обычный файл.
const TAIL_MAX_LINES = 60;
const TAIL_MAX_COLS = 500;

const DRY = process.argv.includes('--dry');

// --- точка входа ------------------------------------------------------------

try {
  if (process.argv.includes('--arm')) modeArm();
  else if (process.argv.includes('--disarm')) modeDisarm();
  else if (process.argv.includes('--status')) modeStatus();
  else if (process.argv.includes('--selftest')) modeSelftest();
  else decide();
} catch (e) {
  say(`внутренняя ошибка: ${e && e.message ? e.message : e} — ход не блокирую`);
  process.exit(0);
}

// --- состояние --------------------------------------------------------------
//
// Состояний ДВА, и это решение, а не недоделка. Здесь, в `artifacts/GATE_STATE.json`, живёт
// состояние ПРИЁМКИ (task, task_id, status, attempts, armed_at, verify, checks_hash,
// tools_hash); состояние КОНВЕЙЕРА — в `tasks/<id>/STATE.md`, и его ведёт `task.mjs`.
//
// Почему не одно. Проверки из блока CCKIT:VERIFY гоняются по ВСЕМУ рабочему дереву, а дерево
// одно на все задачи — «приёмки по задаче» физически не существует, поэтому вопрос «какую
// задачу проверять» не решается файлом ACTIVE, а отпадает. Плюс checks_hash / tools_hash —
// машинные факты об инструменте приёмки, им нечего делать в человекочитаемом STATE.md,
// который правят руками. И третье: GATE_STATE.json закрыт `deny` по точному пути, а STATE.md —
// шаблоном; даже если правило с `**` где-то не сработает, подделка статуса задачи не станет
// подделкой приёмки. Не сливать эти два состояния обратно в одно.
//
// Связь между ними ровно одна — поле `task_id`: по нему видно, к какой задаче относится взвод.

function readState() {
  try {
    if (!existsSync(STATE)) return null;
    const s = JSON.parse(readFileSync(STATE, 'utf8'));
    return s && typeof s === 'object' ? s : null;
  } catch {
    return null;   // битый JSON состояния — это не повод ломать ход
  }
}

function writeState(state) {
  try {
    mkdirSync(path.dirname(STATE), { recursive: true });
    state.updated_at = new Date().toISOString();
    writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    try { chmodSync(STATE, 0o600); } catch { /* Windows — прав такого вида нет */ }
  } catch (e) {
    say(`не удалось записать состояние: ${e.message}`);
  }
}

// --- режимы -----------------------------------------------------------------

/**
 * Хеш самого инструмента приёмки: `verify.mjs`, `gate.mjs` и исходный текст блока проверок.
 *
 * Зачем. Отпечаток свежести считается по git, а в проекте пользователя весь `.claude/`
 * игнорируется — значит правку хуков он не замечает. Подделывать `VERIFY.json` не нужно:
 * достаточно переписать измеритель так, чтобы он всегда возвращал «прошло».
 *
 * ⚠️ Это **видимость, а не защита**. Расхождение отмечается в состоянии и печатается, но хода
 * не останавливает: правка хуков — законное занятие (в самом наборе они и есть прод-код),
 * и превращать её в блокировку значило бы мешать работе. К тому же за пределы конвейера хеш
 * не достаёт: команды блока вызывают чужой код (`npm test` и прочее), и подмена тестов
 * приёмку отбелит, не тронув ни одного из трёх хешируемых кусков.
 */
function toolsHash(blockText) {
  const parts = [];
  for (const name of ['verify.mjs', 'gate.mjs']) {
    try { parts.push(readFileSync(path.join(KIT_DIR, 'hooks', name))); }
    catch { parts.push(Buffer.from(`нет:${name}`)); }
  }
  parts.push(Buffer.from(String(blockText || ''), 'utf8'));
  return createHash('sha256').update(Buffer.concat(parts)).digest('hex');
}

function modeArm() {
  const i = process.argv.indexOf('--arm');
  const raw = process.argv.slice(i + 1).filter((a) => !a.startsWith('--')).join(' ');
  const taskId = activeTaskId();
  // Без аргумента название берётся из активной задачи, и это основная форма: свободный текст
  // человека больше не ездит в командной строке, а шаблон `--arm:*` убран из `allow`.
  // Аргумент остаётся для человека — из терминала и из `gate.bat`, где слоя прав нет вовсе.
  const task = clean(raw) || activeTaskTitle(taskId) || 'задача без названия';
  const info = hashInfo();
  const state = {
    task,
    // К какой задаче относится взвод. Пусто — гейт взвели вручную или активной задачи нет;
    // это нормально: приёмка считается по дереву и работает в проекте без задач.
    task_id: taskId,
    status: 'implementing',
    attempts: 0,
    armed_at: new Date().toISOString(),
    updated_at: null,
    verify: 'none',
    // Хеш набора проверок на момент взвода. null — блок ещё не подтверждён или проверок нет;
    // такой гейт «усыновит» хеш после первого настоящего прогона.
    checks_hash: info && info.accepted ? info.hash : null,
    // Хеш самого инструмента приёмки. Третьей частью берём канонический хеш блока, а не сырой
    // текст: разница в отступах и комментариях на исполнение не влияет и уже покрыта checks_hash.
    tools_hash: toolsHash(info ? info.hash : '')
  };
  writeState(state);
  say(`гейт взведён на задачу «${task}»`);
  if (taskId) say(`id задачи: ${taskId}`);
  if (!info || info.count === 0) say('проверок в профиле нет — приёмке нечего запускать');
  else if (!info.accepted) say('блок проверок ещё не подтверждён (`verify.mjs --accept` делает человек)');
  else say(`набор проверок запомнен: ${info.count} шт., hash ${String(info.hash).slice(0, 12)}…`);
  process.exit(0);
}

function modeDisarm() {
  if (!existsSync(STATE)) { say('гейт не взведён — снимать нечего'); process.exit(0); }
  try { rmSync(STATE); say('взвод снят'); } catch (e) { say(`не удалось снять взвод: ${e.message}`); }
  process.exit(0);
}

function modeStatus() {
  const st = readState();
  if (!st) { say('гейт не взведён'); process.exit(0); }
  say(`задача: ${st.task}`);
  // Строка намеренно НЕ начинается со слова «задача:»: меню gate-menu.mjs выдёргивает название
  // регэкспом /задача:\s*(.+)/ и подхватило бы вместо заголовка идентификатор.
  if (st.task_id) say(`id задачи: ${clean(st.task_id)}`);
  say(`статус: ${st.status} · попыток: ${st.attempts} · приёмка: ${st.verify}`);
  say(`взведён: ${st.armed_at}${st.updated_at ? ` · обновлён: ${st.updated_at}` : ''}`);
  say(`набор проверок: ${st.checks_hash ? `${String(st.checks_hash).slice(0, 12)}…` : 'не запомнен'}`);
  say(`инструмент приёмки: ${st.tools_hash ? `${String(st.tools_hash).slice(0, 12)}…` : 'не запомнен'}`
    + (st.tools_changed ? ' · ⚠ менялся после взвода' : ''));
  if (stale(st)) say(`⚠ взвод старше ${STALE_HOURS} ч — следующий ход его снимет`);
  process.exit(0);
}

function modeSelftest() {
  const st = readState();
  say(st ? `состояние: ${st.status}, задача «${st.task}», попыток ${st.attempts}` : 'состояние: гейт не взведён');
  if (!existsSync(VERIFY)) {
    say(`⚠ ${rel(VERIFY)} не найден — гейт всегда будет пропускать ход`);
  } else {
    say(`verify.mjs на месте: ${rel(VERIFY)}`);
    const r = spawnSync(process.execPath, [VERIFY, '--selftest'], {
      cwd: PROJECT_ROOT, stdio: 'inherit', timeout: 60000
    });
    if (r.error) say(`⚠ не удалось запустить verify.mjs --selftest: ${r.error.message}`);
  }
  // Перечень рычагов снятия гейта — для человека, а не для агента: `--selftest` лежит
  // в `allow` и автоодобрен, поэтому список печатается только живому терминалу.
  if (process.stdin.isTTY) {
    say('рычаги человека, если гейт мешает (все четыре — действия человека, не агента):');
    say('  1. node .claude/hooks/gate.mjs --disarm — снять взвод');
    say('  2. пустой `checks: []` в блоке CCKIT:VERIFY профиля — проверок нет, гейт молчит');
    say('  3. CCKIT_GATE=off (значения off/0/false) — отключить на сессию');
    say('  4. аварийно: .claude/settings.local.json с {"disableAllHooks": true} + перезапуск');
    say('подробности — .claude/CUSTOMIZE.md, раздел «Машинная приёмка»');
  } else {
    say('рычаги для человека — .claude/CUSTOMIZE.md, раздел «Машинная приёмка»');
  }
  process.exit(0);
}

// --- решение ----------------------------------------------------------------

function decide() {
  // 1. Переменная окружения. Сравнение точное: «любое непустое» отключало бы гейт случайно.
  const env = String(process.env.CCKIT_GATE || '').trim().toLowerCase();
  if (env === 'off' || env === '0' || env === 'false') {
    say('⚠ гейт отключён переменной окружения CCKIT_GATE — приёмка не проводится');
    summary();
    process.exit(0);
  }

  const st = readState();

  // 2. Взвод протух. TTL применяется к ЛЮБОМУ состоянию, а не только к `implementing`:
  // забытый `verified` или `blocked` иначе глушил бы и приёмку, и строку о её отсутствии.
  if (st && stale(st)) {
    if (!DRY) { try { rmSync(STATE); } catch { /* уже нет — и хорошо */ } }
    emitGate(st, { status: 'stale', hours: STALE_HOURS });
    noAcceptance(`взвод протух (старше ${STALE_HOURS} ч)`, false);
    summary();
    process.exit(0);
  }

  // 3. Состояния нет или задача уже закрыта — не блокируем, но и не молчим: невидимость
  // здесь хуже всего, потому что неотличима от «в проекте нет проверок».
  if (!st || st.status !== 'implementing') {
    if (!st) {
      const info = hashInfo();
      if (info && info.count > 0 && info.accepted && dirty()) {
        noAcceptance('гейт не был взведён', true);
      }
    } else if (st.status === 'blocked') {
      say(`⚠ задача «${st.task}» в состоянии blocked: приёмка так и не пройдена`);
      say('человеку: как снять гейт — см. .claude/CUSTOMIZE.md, раздел «Машинная приёмка»');
    } else if (st.status === 'verified') {
      say(`приёмка по задаче «${st.task}» уже пройдена (${st.verify}) — прогон не повторяю`);
    }
    summary();
    process.exit(0);
  }

  // 4. Нечем проверять.
  if (!existsSync(VERIFY)) {
    say(`${rel(VERIFY)} не найден — приёмку пропускаю, ход не блокирую`);
    summary();
    process.exit(0);
  }

  // 5. Сверка набора проверок: подмена блока при взведённом гейте — не «проверок нет».
  const info = hashInfo();
  if (st.checks_hash && info && (!info.accepted || info.hash !== st.checks_hash)) {
    const why = info.accepted ? 'команды стали другими' : 'подтверждение блока пропало';
    if (!DRY) {
      writeState({ ...st, status: 'blocked' });
      noteInTask(st, `приёмка: набор проверок изменился после взвода (${why}) — blocked`);
      emitGate(st, { status: 'blocked', reason: 'checks-changed' });
    }
    err(`${TAG} ⛔ набор проверок изменился после взвода гейта (${why}) — нужен человек.`);
    err(`${TAG} Приёмка на этой задаче больше не считается: гейт запомнил один набор команд, а в`);
    err(`${TAG} профиле сейчас другой. Верните блок CCKIT:VERIFY в прежний вид или подтвердите`);
    err(`${TAG} новый: node .claude/hooks/verify.mjs --accept (это действие человека).`);
    summary();
    process.exit(0);
  }

  // 5.1 Сверка самого инструмента приёмки. В отличие от пункта 5 это НЕ блокировка и не повод
  // остановить работу: правка хуков законна, а в самом наборе она и есть основная работа.
  // Смысл только в том, чтобы подмена измерителя не прошла молча — отметка остаётся в состоянии
  // и печатается человеку. Защитой это не является, см. комментарий к toolsHash().
  const toolsNow = toolsHash(info ? info.hash : '');
  const toolsMoved = st.tools_hash && st.tools_hash !== toolsNow;
  if (toolsMoved) {
    say('⚠ инструмент приёмки изменился после взвода гейта (verify.mjs / gate.mjs или блок проверок).');
    say('  Это отметка, а не блокировка: если правка ваша — всё в порядке, если нет — посмотрите diff.');
  }

  // 6. Прогон.
  if (DRY) {
    dryRun(st, info);
    summary();
    process.exit(0);
  }

  const r = spawnSync(process.execPath, [VERIFY], {
    cwd: PROJECT_ROOT, encoding: 'utf8', timeout: VERIFY_TIMEOUT_MS
  });
  if (r.error || r.status === null) {
    const why = r.error && r.error.code === 'ETIMEDOUT'
      ? `приёмка не уложилась в ${Math.round(VERIFY_TIMEOUT_MS / 1000)} с`
      : `не удалось выполнить приёмку: ${r.error ? r.error.message : 'без кода возврата'}`;
    say(`${why} — ход не блокирую`);
    summary();
    process.exit(0);
  }

  const report = readReport();
  // Хеш «усыновляется» только после СОСТОЯВШЕГОСЯ прогона (коды 0/1) и только если блок
  // подтверждён. Иначе гейт запомнил бы хеш ещё не подтверждённого блока и на следующем же
  // ходе обвинил задачу в подмене проверок, которой не было.
  const next = {
    ...st,
    checks_hash: info && info.accepted ? info.hash : st.checks_hash,
    tools_changed: !!toolsMoved   // отметка живёт в состоянии, а не только в выводе одного хода
  };

  // 6.1 Проверять нечего или блок не подтверждён — попытка не засчитывается.
  if (r.status === 3) {
    writeState({ ...st, verify: 'none' });   // прогона не было — checks_hash не трогаем
    // Пишем и этот случай: молчаливый пропуск неотличим от «гейта не было», а главный вопрос
    // к журналу — какая доля ходов вообще проверялась.
    emitGate(st, { status: 'none', reason: (!info || info.count === 0) ? 'no-checks' : 'not-accepted' });
    const reason = !info || info.count === 0
      ? 'в профиле не настроено ни одной проверки'
      : 'блок проверок не подтверждён — подтвердить его может только человек (verify.mjs --accept)';
    say(`⚠ приёмка не проводилась: ${reason}`);
    say(firstLines(r.stdout, 4));
    summary();
    process.exit(0);
  }

  // 6.2 Прогон состоялся и не упал: 0 — прошло всё, 4 — прошло не всё (partial).
  // Четвёрку обязательно ловить здесь же: иначе частичный прогон провалится в ветку 6.3
  // и станет красным вместо жёлтого — ровно та ошибка, наоборот.
  if (r.status === 0 || r.status === 4) {
    next.status = 'verified';
    next.attempts = 0;
    if (report && report.status === 'partial') {
      next.verify = 'partial';
      writeState(next);
      say(`приёмка прошла частично: выполнено ${report.passed} из ${report.total}, пропущено ${report.skipped}`);
      const names = (report.checks || []).filter((c) => c.skipped).map((c) => clean(c.name)).join(', ');
      if (names) say(`пропущено: ${names}`);
    } else {
      next.verify = 'pass';
      writeState(next);
      say(`проверки зелёные (${report ? report.total : '?'})`);
    }
    noteInTask(next, next.verify === 'partial'
      ? `приёмка: прошла частично${report ? ` (${report.passed} из ${report.total})` : ''}`
      : 'приёмка: проверки зелёные');
    emitGate(next, { status: next.verify, passed: report ? report.passed : '', total: report ? report.total : '' });
    summary();
    process.exit(0);
  }

  // 6.3 Красный прогон.
  next.attempts = Number(st.attempts || 0) + 1;
  next.verify = 'fail';
  if (next.attempts >= MAX_ATTEMPTS) {
    next.status = 'blocked';
    writeState(next);
    noteInTask(next, `приёмка: ${MAX_ATTEMPTS} попытки не помогли — blocked`);
    emitGate(next, { status: 'blocked', attempt: next.attempts, failed: report && report.failed ? report.failed : '' });
    say(`⛔ три попытки не помогли, нужен человек: приёмка на задаче «${st.task}» так и не стала зелёной`);
    if (report && report.failed) say(`последняя упавшая проверка: ${clean(report.failed)}`);
    say('человеку: как снять гейт — см. .claude/CUSTOMIZE.md, раздел «Машинная приёмка»');
    summary();
    process.exit(0);
  }
  writeState(next);
  // Точка, которой в файле не было вовсе: промежуточная неудача приёмки не писала никуда, и
  // след двух первых попыток исчезал вместе с ходом. Единственная из шести с СОБСТВЕННЫМ
  // таймаутом, и вот почему: только здесь после best-effort вызова остаётся обязательное
  // действие — `blockTurn(...)` с exit 2, единственный способ вернуть ход агенту красным.
  // Бюджет Stop-хука (900 с в settings.json) уже расписан между `hashInfo()` (30 с) и прогоном
  // приёмки (VERIFY_TIMEOUT_MS = 870 с), поэтому десять секунд поверх сузили бы и без того
  // узкий запас. В пяти остальных точках дальше только `exit 0`, и потеря вызова стоит строчки
  // в сводке, а не приёмки — там 10 с по умолчанию.
  emitGate(next, { status: 'fail', attempt: next.attempts, failed: report && report.failed ? report.failed : '' }, 2500);
  blockTurn(report, next.attempts);
}

/**
 * Текст, который возвращается агенту вместе с exit 2. Один рецепт: почини и запусти снова.
 *
 * Всё, что пришло из `VERIFY.json`, чистится ЗДЕСЬ, на печати: файл собирается из вывода команд
 * проекта, то есть из чужого текста, а stderr Stop-хука возвращается агенту вместе с кодом 2 —
 * то есть попадает в контекст модели. Короткие значения — общей `clean`, многострочный хвост —
 * `cleanTail` (почему для него не годится `clean` — см. комментарий к ней).
 */
function blockTurn(report, attempts) {
  const failed = report && report.failed
    ? (report.checks || []).find((c) => c.name === report.failed)
    : null;
  err(`${TAG} ⛔ ход не завершён: проверки не проходят (попытка ${attempts} из ${MAX_ATTEMPTS}).`);
  if (failed) {
    err(`${TAG} упала проверка: ${clean(failed.name)}`);
    err(`${TAG} команда: ${clean(failed.cmd)}`);
    // String() перед clean: код возврата — число, а местная `clean` написана как
    // `String(s || '')` и превратила бы его в пустую строку на нуле.
    const reason = failed.reason ? ` (${clean(failed.reason)})` : '';
    err(`${TAG} код возврата: ${clean(String(failed.code))}${reason}`);
    if (failed.tail) {
      err(`${TAG} последние строки вывода:`);
      for (const l of cleanTail(failed.tail)) err(`  ${l}`);
    }
  } else {
    err(`${TAG} подробности: ${rel(VERIFY_JSON)}`);
  }
  err(`${TAG} почини и запусти снова: node .claude/hooks/verify.mjs`);
  err(`${TAG} человеку: как снять гейт — см. .claude/CUSTOMIZE.md, раздел «Машинная приёмка»`);
  process.exit(2);
}

/** Что было бы, без последствий. Прогон в --dry не запускается: он может идти минутами. */
function dryRun(st, info) {
  say(`гейт взведён на задачу «${st.task}», попыток ${st.attempts} из ${MAX_ATTEMPTS}`);
  if (!info || info.count === 0) {
    say('проверок в профиле нет — гейт пропустил бы ход');
    return;
  }
  if (!info.accepted) {
    say('блок проверок не подтверждён — гейт пропустил бы ход с предупреждением');
    return;
  }
  const report = readReport();
  if (report && report.status === 'fail') {
    say(`гейт заблокировал бы ход: последний прогон красный, упала проверка «${clean(report.failed)}»`);
  } else {
    say(`гейт запустил бы node ${rel(VERIFY)}; красный результат вернул бы ход агенту (код 2)`);
  }
  say(`ещё ${MAX_ATTEMPTS - Number(st.attempts || 0)} неудачных прогона — и задача уйдёт в blocked`);
}

/**
 * Одна и та же строка для двух случаев: гейт не взводили и взвод протух. Она не блокирует —
 * только делает видимым, что ход завершается без машинной приёмки.
 */
function noAcceptance(reason, withHint) {
  say(`⚠ ход завершается без приёмки: ${reason}`);
  if (withHint) say('взвести приёмку: node .claude/hooks/gate.mjs --arm');
}

// --- задача ------------------------------------------------------------------

/**
 * Идентификатор задачи → путь. Единственное место в этом файле, где такой путь строится:
 * `id` приходит из обычного текстового файла `tasks/ACTIVE`, который правят руками, поэтому
 * проверяются и форма, и длина, и то, что результат лежит внутри `tasks/`.
 * Не разобрали — null, и никаких попыток «починить» строку.
 */
function taskDir(id) {
  const s = String(id == null ? '' : id);
  if (s.length > TASK_ID_MAX || !TASK_ID_RE.test(s)) return null;
  const dir = path.resolve(TASKS, s);
  return dir.startsWith(TASKS + path.sep) ? dir : null;
}

/** id активной задачи или пустая строка. Best-effort: нет файла — значит задач нет. */
function activeTaskId() {
  try {
    const raw = String(readFileSync(TASKS_ACTIVE, 'utf8')).split(/\r?\n/)[0].trim();
    return taskDir(raw) ? raw : '';
  } catch {
    return '';
  }
}

/** Заголовок задачи из её STATE.md — для `--arm` без аргумента. Не нашли — пустая строка. */
function activeTaskTitle(id) {
  const dir = taskDir(id);
  if (!dir) return '';
  try {
    const front = readFileSync(path.join(dir, 'STATE.md'), 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const title = front && front[1].match(/^title:(.*)$/m);
    return title ? clean(title[1]) : '';
  } catch {
    return '';
  }
}

/**
 * Строка в журнал задачи на терминальных переходах — best-effort и молча.
 *
 * Вызов массивом и БЕЗ `shell: true` намеренно: текст в конечном счёте приходит от человека
 * (заголовок задачи, имя упавшей проверки), а Stop-хук не ограничен слоем прав вовсе — здесь
 * некому спросить подтверждения. Пишем только если гейт следит за той же задачей, что сейчас
 * активна: иначе вердикт лёг бы в чужой журнал. Любая ошибка глотается — журнал задачи
 * не повод ломать завершение хода.
 */
function noteInTask(state, text) {
  try {
    if (DRY) return;
    const id = state && state.task_id;
    if (!id || id !== activeTaskId()) return;
    if (!existsSync(TASK_MJS)) return;
    spawnSync(process.execPath, [TASK_MJS, 'log', clean(text)], {
      cwd: PROJECT_ROOT, timeout: 10000, stdio: 'ignore'
    });
  } catch { /* молча: это заметка, а не приёмка */ }
}

/**
 * Вердикт приёмки в машинный журнал `.claude/artifacts/events.jsonl` — best-effort и молча,
 * той же дисциплиной, что `noteInTask`.
 *
 * Отдельным процессом, а не импортом: статический импорт ESM нельзя обернуть в `try/catch`,
 * и сломанный или недоехавший `events.mjs` уронил бы загрузку gate.mjs целиком — то есть
 * выключил бы машинную приёмку ради журнала. Любой инфраструктурный сбой здесь стоит строчки
 * в журнале, а не хода.
 *
 * Значения чистятся ЗДЕСЬ, до `args.push`, и причина острее, чем в task.mjs: `report.failed`
 * и `report.checks` приходят из `VERIFY.json`, а его пишет `Bash` беспрепятственно. JSON умеет
 * пронести нулевой байт внутри строкового значения (в файле он лежит escape-последовательностью,
 * а после `JSON.parse` снова становится байтом), Node отвергнет такой `argv` целиком,
 * исключение уйдёт в пустой `catch`, и событие пропадёт молча ровно в ветке промежуточной
 * неудачи приёмки — в единственном месте, ради которого журнал и заводился.
 *
 * `String(v)` перед `clean` обязателен: местная `clean` написана как `String(s || '')`, и без
 * него пара `passed: 0` («не прошло ни одной проверки») стала бы пустой строкой и выпала бы
 * из события — а это самый интересный для журнала случай.
 *
 * В отличие от `noteInTask` сверки с активной задачей нет: журнал общий для проекта, а не для
 * одной задачи, и пустой `task_id` — законное значение (гейт взводят и без задачи).
 *
 * Третий параметр нужен ради ОДНОЙ точки: 10 с по умолчанию годятся там, где после вызова
 * идёт только `exit 0` и потеря стоит строчки в сводке; там, где после вызова остаётся
 * обязательное действие, вызывающий передаёт меньше.
 */
function emitGate(state, payload, timeoutMs = 10000) {
  try {
    if (DRY) return;   // сухой прогон не пишет никуда
    if (!existsSync(EVENTS_MJS)) return;
    const args = [EVENTS_MJS, '--emit', 'gate_result', '--task', String((state && state.task_id) || '')];
    for (const [k, v] of Object.entries(payload || {})) {
      if (v === undefined || v === null) continue;   // нет значения — нет пары
      const sv = clean(String(v));                   // String() обязателен: см. комментарий выше
      if (!sv) continue;                             // после чистки пусто — пары нет
      args.push('--set', `${k}=${sv}`);
    }
    spawnSync(process.execPath, args, { cwd: PROJECT_ROOT, timeout: timeoutMs, stdio: 'ignore' });
  } catch { /* молча: журнал не повод ломать завершение хода */ }
}

// --- вспомогательное --------------------------------------------------------

/** `verify.mjs --hash` → {hash, accepted, count}. Любой сбой → null (не блокируем). */
function hashInfo() {
  try {
    if (!existsSync(VERIFY)) return null;
    const r = spawnSync(process.execPath, [VERIFY, '--hash'], {
      cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 30000
    });
    if (r.error || r.status !== 0) return null;
    const line = String(r.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean).pop();
    if (!line) return null;
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function readReport() {
  try {
    if (!existsSync(VERIFY_JSON)) return null;
    return JSON.parse(readFileSync(VERIFY_JSON, 'utf8'));
  } catch {
    return null;
  }
}

function dirty() {
  const r = spawnSync('git', ['status', '--porcelain', '-uall'], {
    cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024
  });
  if (r.error || r.status !== 0) return false;   // не git-папка — считаем, что новостей нет
  return String(r.stdout || '').trim() !== '';
}

function stale(st) {
  const t = Date.parse(st.armed_at || '');
  if (!Number.isFinite(t)) return false;
  return Date.now() - t > STALE_HOURS * 3600 * 1000;
}

/** Сводка правок — тем же `git-status.mjs`, что стоял в Stop раньше. Нет файла — молча мимо. */
function summary() {
  if (!existsSync(GIT_STATUS)) return;
  spawnSync(process.execPath, [GIT_STATUS], { cwd: PROJECT_ROOT, stdio: 'inherit', timeout: 30000 });
}

/** Текст задачи печатается в терминал — управляющие символы оттуда убираем. */
function clean(s) {
  // управляющие символы (в т. ч. перевод строки) заменяем пробелом
  return String(s || '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Хвост вывода упавшей проверки — чистка ПОСТРОЧНО. Возвращает массив готовых к печати строк.
 *
 * Почему не `clean`, хотя чистить надо то же самое. `clean` схлопывает `\s+` в один пробел и
 * режет результат до 200 знаков: пропустить через неё `tail` целиком — значит превратить
 * многострочный вывод в однострочный огрызок ровно там, куда человек смотрит, чтобы понять,
 * ЧТО сломалось. Поэтому здесь разбиение на строки и отступы сохраняются, а управляющие
 * символы (ANSI-escape, возврат каретки, нулевой байт) снимаются в каждой строке отдельно —
 * тем же классом, что и в `clean`, чтобы правило чистки в наборе оставалось одно.
 *
 * Пределы свои, хотя `verify.mjs` уже режет хвост до 40 строк и 4 КБ: `VERIFY.json` — обычный
 * файл, его пишет `Bash` беспрепятственно, и доверие к чужой обрезке — это отсутствие обрезки.
 * Обрезку отмечаем строкой, а не молчанием: молча укороченный вывод хуже длинного.
 */
function cleanTail(s) {
  const all = String(s == null ? '' : s).split('\n');
  const kept = all.length > TAIL_MAX_LINES ? all.slice(-TAIL_MAX_LINES) : all;
  const lines = kept.map((l) => {
    const text = l.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+$/, '');
    return text.length > TAIL_MAX_COLS ? `${text.slice(0, TAIL_MAX_COLS)} …` : text;
  });
  if (all.length > TAIL_MAX_LINES) lines.unshift('… (обрезано)');
  return lines;
}

function firstLines(text, n) {
  return String(text || '').split('\n').filter(Boolean).slice(0, n).join('\n');
}

function rel(p) {
  const r = path.relative(PROJECT_ROOT, p);
  return (!r || r.startsWith('..')) ? p : r.split(path.sep).join('/');
}

function say(line) {
  console.log(`${TAG} ${line}`);
}

function err(line) {
  process.stderr.write(`${line}\n`);
}
