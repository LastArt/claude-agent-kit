#!/usr/bin/env node
/**
 * Stop-хук (Claude Agent Kit) — машинная приёмка: не даёт закончить ход с красными проверками.
 * Кроссплатформенно, БЕЗ внешних зависимостей: только встроенные модули `node:*`.
 *
 * Как это работает. Гейт молчит, пока его не взвели: `implementer` перед первым шагом плана
 * выполняет `gate.mjs --arm "<задача>"`, и это записывает состояние в
 * `.claude/artifacts/GATE_STATE.json`. Дальше на каждом завершении хода гейт:
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
 *   node .claude/hooks/gate.mjs --arm "задача"     взвести приёмку на задачу
 *   node .claude/hooks/gate.mjs --status           что сейчас в состоянии
 *   node .claude/hooks/gate.mjs --dry              посчитать решение, ничего не блокируя
 *   node .claude/hooks/gate.mjs --selftest         состояние, verify.mjs и рычаги для человека
 *   node .claude/hooks/gate.mjs --disarm           снять взвод (действие человека)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
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

const MAX_ATTEMPTS = 3;
const STALE_HOURS = 6;
const VERIFY_TIMEOUT_MS = 870 * 1000;   // меньше таймаута самого хука (900 с) в settings.json
const TAG = '[gate]';

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
// ФАЗА 2 заменит ТОЛЬКО эти две функции на чтение/запись `tasks/<id>/STATE.md`.
// Имена полей выбраны заранее такими же: task, status, attempts, armed_at, updated_at,
// verify, checks_hash. Всё остальное в этом файле трогать не придётся.

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

function modeArm() {
  const i = process.argv.indexOf('--arm');
  const raw = process.argv.slice(i + 1).filter((a) => !a.startsWith('--')).join(' ');
  const task = clean(raw) || 'задача без названия';
  const info = hashInfo();
  const state = {
    task,
    status: 'implementing',
    attempts: 0,
    armed_at: new Date().toISOString(),
    updated_at: null,
    verify: 'none',
    // Хеш набора проверок на момент взвода. null — блок ещё не подтверждён или проверок нет;
    // такой гейт «усыновит» хеш после первого настоящего прогона.
    checks_hash: info && info.accepted ? info.hash : null
  };
  writeState(state);
  say(`гейт взведён на задачу «${task}»`);
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
  say(`статус: ${st.status} · попыток: ${st.attempts} · приёмка: ${st.verify}`);
  say(`взведён: ${st.armed_at}${st.updated_at ? ` · обновлён: ${st.updated_at}` : ''}`);
  say(`набор проверок: ${st.checks_hash ? `${String(st.checks_hash).slice(0, 12)}…` : 'не запомнен'}`);
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
    if (!DRY) writeState({ ...st, status: 'blocked' });
    err(`${TAG} ⛔ набор проверок изменился после взвода гейта (${why}) — нужен человек.`);
    err(`${TAG} Приёмка на этой задаче больше не считается: гейт запомнил один набор команд, а в`);
    err(`${TAG} профиле сейчас другой. Верните блок CCKIT:VERIFY в прежний вид или подтвердите`);
    err(`${TAG} новый: node .claude/hooks/verify.mjs --accept (это действие человека).`);
    summary();
    process.exit(0);
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
  const next = { ...st, checks_hash: info && info.accepted ? info.hash : st.checks_hash };

  // 6.1 Проверять нечего или блок не подтверждён — попытка не засчитывается.
  if (r.status === 3) {
    writeState({ ...st, verify: 'none' });   // прогона не было — checks_hash не трогаем
    const reason = !info || info.count === 0
      ? 'в профиле не настроено ни одной проверки'
      : 'блок проверок не подтверждён — подтвердить его может только человек (verify.mjs --accept)';
    say(`⚠ приёмка не проводилась: ${reason}`);
    say(firstLines(r.stdout, 4));
    summary();
    process.exit(0);
  }

  // 6.2 Прогон состоялся и не упал.
  if (r.status === 0) {
    next.status = 'verified';
    next.attempts = 0;
    if (report && report.status === 'partial') {
      next.verify = 'partial';
      writeState(next);
      say(`приёмка прошла частично: выполнено ${report.passed} из ${report.total}, пропущено ${report.skipped}`);
      const names = (report.checks || []).filter((c) => c.skipped).map((c) => c.name).join(', ');
      if (names) say(`пропущено: ${names}`);
    } else {
      next.verify = 'pass';
      writeState(next);
      say(`проверки зелёные (${report ? report.total : '?'})`);
    }
    summary();
    process.exit(0);
  }

  // 6.3 Красный прогон.
  next.attempts = Number(st.attempts || 0) + 1;
  next.verify = 'fail';
  if (next.attempts >= MAX_ATTEMPTS) {
    next.status = 'blocked';
    writeState(next);
    say(`⛔ три попытки не помогли, нужен человек: приёмка на задаче «${st.task}» так и не стала зелёной`);
    if (report && report.failed) say(`последняя упавшая проверка: ${report.failed}`);
    say('человеку: как снять гейт — см. .claude/CUSTOMIZE.md, раздел «Машинная приёмка»');
    summary();
    process.exit(0);
  }
  writeState(next);
  blockTurn(report, next.attempts);
}

/** Текст, который возвращается агенту вместе с exit 2. Один рецепт: почини и запусти снова. */
function blockTurn(report, attempts) {
  const failed = report && report.failed
    ? (report.checks || []).find((c) => c.name === report.failed)
    : null;
  err(`${TAG} ⛔ ход не завершён: проверки не проходят (попытка ${attempts} из ${MAX_ATTEMPTS}).`);
  if (failed) {
    err(`${TAG} упала проверка: ${failed.name}`);
    err(`${TAG} команда: ${failed.cmd}`);
    err(`${TAG} код возврата: ${failed.code}${failed.reason ? ` (${failed.reason})` : ''}`);
    if (failed.tail) {
      err(`${TAG} последние строки вывода:`);
      for (const l of String(failed.tail).split('\n')) err(`  ${l}`);
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
    say(`гейт заблокировал бы ход: последний прогон красный, упала проверка «${report.failed}»`);
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
  if (withHint) say('взвести приёмку: node .claude/hooks/gate.mjs --arm "<задача>"');
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
