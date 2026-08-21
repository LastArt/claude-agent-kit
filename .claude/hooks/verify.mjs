#!/usr/bin/env node
/**
 * Машинная приёмка (Claude Agent Kit) — единая точка прогона проверок проекта.
 * Кроссплатформенно, БЕЗ внешних зависимостей: только встроенные модули `node:*`.
 *
 * Что делает: читает машиночитаемый блок `CCKIT:VERIFY` из §2 `PROJECT_PROFILE.md`,
 * выполняет перечисленные там команды по порядку (останов на первой упавшей) и пишет
 * результат в `.claude/artifacts/VERIFY.json`. По этому файлу Stop-хук `gate.mjs` решает,
 * можно ли закончить ход, а `reviewer` — начинать ли ревью.
 *
 * ⚠️ ВАЖНО: команды из профиля исполняются КАК ЕСТЬ, с правами текущего пользователя.
 * Профиль — обычный markdown, который может приехать вместе с чужим репозиторием, поэтому
 * действует «доверие при первой встрече»: пока набор команд не подтверждён
 * (`--accept` → `.claude/artifacts/VERIFY.lock`), хук печатает команды и НЕ выполняет ни одной.
 * Подтверждается не текст файла, а результат разбора: правка отступа или комментария
 * подтверждение не сбрасывает, правка `cmd`/`name` — сбрасывает.
 *
 * ⚠️ Слепая зона свежести: отпечаток дерева (`fingerprint`) считается по git, поэтому правки
 * в ИГНОРИРУЕМЫХ путях приёмку не устаревают. В проекте пользователя это весь `.claude/**`.
 * Обойти это без обхода всего дерева нельзя — зона названа честно, а не закрыта.
 *
 * ⚠️ Маскирование секретов ловит типовые формы и гарантией не является. Не вписывайте секреты
 * в `cmd`: строка команды печатается перед каждым прогоном и попадает в `VERIFY.json`.
 *
 * Коды возврата:
 *   0 — прошло всё (`pass`)
 *   1 — упала проверка (`fail`)
 *   3 — проверять нечего, блок не подтверждён, блок повреждён, профиль не найден,
 *       неизвестное имя в `--only` или внутренняя ошибка (тексты разные)
 *   4 — прошло не всё (`partial`): часть проверок пропущена или прогон был частичным
 *
 * Четвёрка заведена отдельно намеренно. «Проверки не прошли» и «проверки выполнились не все» —
 * разные ситуации с разными действиями, и вызывающая сторона обязана их различать. Ноль при
 * пропусках означал бы тихий ложный зелёный.
 *
 * Ручной запуск:
 *   node .claude/hooks/verify.mjs                 полный прогон, пишет VERIFY.json
 *   node .claude/hooks/verify.mjs --only test     одна проверка (никогда не даёт pass)
 *   node .claude/hooks/verify.mjs --dry           показать, что будет запущено
 *   node .claude/hooks/verify.mjs --selftest      что настроено, доступно и подтверждено
 *   node .claude/hooks/verify.mjs --fresh         свежая ли последняя приёмка
 *   node .claude/hooks/verify.mjs --show          показать команды и хеш, ничего не записывая
 *   node .claude/hooks/verify.mjs --accept        подтвердить набор команд — ТОЛЬКО из терминала:
 *                                                 спрашивает «да» с клавиатуры, без TTY отказывает
 *   node .claude/hooks/verify.mjs --init          вставить пустой блок в §2 профиля
 *   node .claude/hooks/verify.mjs --hash          служебный: {hash, accepted, count} одной строкой
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

// Корень набора берём от расположения самого хука, а не от process.cwd():
// хук зовут и из подпапки, и из другого процесса.
const KIT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROJECT_ROOT = path.dirname(KIT_DIR);
const PROFILE = path.join(KIT_DIR, 'PROJECT_PROFILE.md');
const OUT = path.join(KIT_DIR, 'artifacts', 'VERIFY.json');
const LOCK = path.join(KIT_DIR, 'artifacts', 'VERIFY.lock');

const DEFAULT_TIMEOUT = 300;   // секунд на команду, если в блоке не сказано иначе
const TAIL_LINES = 40;
const TAIL_BYTES = 4096;
const MAX_BUFFER = 8 * 1024 * 1024;

const OPEN = '<!-- CCKIT:VERIFY -->';
const CLOSE = '<!-- /CCKIT:VERIFY -->';
const TAG = '[verify]';
const MASK = '***';

// `where`/`which` не знают о встроенных командах шелла, а `node` есть по определению —
// про них пробу доступности не делаем, чтобы не выдумать ложное «пропущено».
const NO_PROBE = new Set(['node', 'cd', 'echo', 'set', 'export', 'call', 'source', '.']);

// --- точка входа ------------------------------------------------------------

try {
  if (process.argv.includes('--hash')) modeHash();
  else if (process.argv.includes('--init')) modeInit();
  else if (process.argv.includes('--show')) modeShow();
  else if (process.argv.includes('--accept')) {
    // единственный асинхронный режим: ждёт ответа человека с клавиатуры
    modeAccept().catch((e) => { say(`внутренняя ошибка: ${e && e.message ? e.message : e}`); process.exit(3); });
  }
  else if (process.argv.includes('--fresh')) modeFresh();
  else if (process.argv.includes('--selftest')) modeSelftest();
  else if (process.argv.includes('--dry')) modeDry();
  else modeRun();
} catch (e) {
  say(`внутренняя ошибка: ${e && e.message ? e.message : e}`);
  process.exit(3);
}

// --- разбор блока -----------------------------------------------------------

/**
 * Разбирает блок `CCKIT:VERIFY`. Возвращает
 * `{ present, broken, error, timeout, checks: [{name, cmd, timeout}], warnings }`.
 * Формат намеренно плоский: это не YAML вообще, а два уровня, читаемые построчно —
 * внешняя библиотека набору запрещена.
 */
function parseBlock(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const opens = [];
  const closes = [];
  lines.forEach((l, i) => {
    const t = l.trim();
    if (t === OPEN) opens.push(i);
    else if (t === CLOSE) closes.push(i);
  });

  if (opens.length === 0) return { present: false, broken: false, lines, eol };
  if (opens.length > 1) {
    return { present: true, broken: true, lines, eol,
      error: `открывающих маркеров ${OPEN} найдено ${opens.length}, а должен быть ровно один` };
  }
  const close = closes.find((i) => i > opens[0]);
  if (close === undefined) {
    return { present: true, broken: true, lines, eol,
      error: `нет закрывающего маркера ${CLOSE}` };
  }
  if (closes.length > 1) {
    return { present: true, broken: true, lines, eol,
      error: `закрывающих маркеров ${CLOSE} найдено ${closes.length}, а должен быть ровно один` };
  }

  const body = lines.slice(opens[0] + 1, close);
  const checks = [];
  const warnings = [];
  let timeout = DEFAULT_TIMEOUT;
  let inChecks = false;
  let cur = null;

  for (const raw of body) {
    const line = raw.replace(/\s+$/, '');
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('```')) continue;   // ограждение markdown
    if (t.startsWith('#')) continue;     // комментарий: в хеш не попадает

    if (/^timeout:/.test(line)) {        // нулевой отступ — общий таймаут
      const n = Number(unquote(line.slice('timeout:'.length).trim()));
      if (Number.isFinite(n) && n > 0) timeout = n;
      else warnings.push(`общий timeout не число: ${t}`);
      continue;
    }
    if (/^checks:/.test(line)) {
      inChecks = true;
      const v = line.slice('checks:'.length).trim();
      if (v && v !== '[]') warnings.push(`инлайн-значение checks не поддерживается: ${v}`);
      continue;
    }
    if (!inChecks) { warnings.push(`строка вне checks пропущена: ${t}`); continue; }

    let m = t.match(/^-\s*name:\s*(.+)$/);
    if (m) {
      if (cur) pushCheck(checks, cur, warnings);
      cur = { name: unquote(m[1]), cmd: null, timeout: null };
      continue;
    }
    m = t.match(/^-\s*cmd:\s*(.+)$/);
    if (m) {
      if (cur) pushCheck(checks, cur, warnings);
      cur = { name: null, cmd: unquote(m[1]), timeout: null };
      continue;
    }
    if (!cur) { warnings.push(`строка без элемента списка пропущена: ${t}`); continue; }

    m = t.match(/^cmd:\s*(.+)$/);
    if (m) { cur.cmd = unquote(m[1]); continue; }
    m = t.match(/^timeout:\s*(.+)$/);   // с отступом — таймаут элемента
    if (m) {
      const n = Number(unquote(m[1]));
      if (Number.isFinite(n) && n > 0) cur.timeout = n;
      else warnings.push(`timeout проверки не число: ${t}`);
      continue;
    }
    m = t.match(/^name:\s*(.+)$/);
    if (m) { cur.name = unquote(m[1]); continue; }
    warnings.push(`непонятная строка пропущена: ${t}`);
  }
  if (cur) pushCheck(checks, cur, warnings);

  return { present: true, broken: false, timeout, checks, warnings, lines, eol,
    open: opens[0], close };
}

function pushCheck(checks, cur, warnings) {
  if (!cur.cmd) {
    warnings.push(`элемент «${cur.name || 'без имени'}» без cmd пропущен`);
    return;
  }
  if (!cur.name) cur.name = `check-${checks.length + 1}`;
  checks.push(cur);
}

function unquote(v) {
  const s = String(v).trim();
  if (s.length > 1 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Канонический вид набора проверок и его sha256. Хешируется РЕЗУЛЬТАТ РАЗБОРА,
 * собранный полем за полем в порядке следования (порядок значим: прогон останавливается
 * на первой упавшей). Регистр не складываем и Unicode не нормализуем — иначе `RM -rf`
 * и `rm -rf` дали бы один хеш.
 */
function canonical(block) {
  const obj = {
    timeout: Number(block.timeout) || DEFAULT_TIMEOUT,
    checks: block.checks.map((c) => ({
      name: String(c.name),
      cmd: String(c.cmd),
      timeout: c.timeout === null || c.timeout === undefined ? null : Number(c.timeout)
    }))
  };
  const json = JSON.stringify(obj);
  return { obj, json, hash: createHash('sha256').update(json, 'utf8').digest('hex') };
}

/** Профиль + разобранный блок + состояние подтверждения. Ничего не печатает. */
function load() {
  if (!existsSync(PROFILE)) {
    return { fatal: `профиль не найден: ${rel(PROFILE)}` };
  }
  const text = readFileSync(PROFILE, 'utf8');
  const block = parseBlock(text);
  if (block.broken) return { block, fatal: `блок проверок повреждён: ${block.error}` };
  if (!block.present) return { block, empty: `в профиле нет блока ${OPEN} — проверять нечего` };
  const canon = canonical(block);
  const lock = readLock();
  const accepted = !!(lock && lock.hash === canon.hash);
  return { block, canon, lock, accepted, text };
}

function readLock() {
  try {
    if (!existsSync(LOCK)) return null;
    return JSON.parse(readFileSync(LOCK, 'utf8'));
  } catch {
    return null;   // битый lock = подтверждения нет, а не падение
  }
}

// --- режимы -----------------------------------------------------------------

function modeHash() {
  const st = load();
  const out = st.canon
    ? { hash: st.canon.hash, accepted: st.accepted, count: st.block.checks.length }
    : { hash: null, accepted: false, count: 0 };
  console.log(JSON.stringify(out));
  process.exit(0);
}

function modeDry() {
  const st = load();
  if (st.fatal) { say(st.fatal); process.exit(3); }
  if (st.empty) { say(st.empty); process.exit(3); }
  printPlan(st);
  if (st.block.checks.length === 0) {
    say('в блоке нет ни одной проверки — прогонять нечего');
    process.exit(3);
  }
  say(st.accepted
    ? 'блок подтверждён — прогон выполнит эти команды'
    : 'блок НЕ подтверждён: прогон ничего не выполнит, пока человек не сделает --accept');
  process.exit(0);
}

// Показать, что предлагается исполнять, НИЧЕГО не записывая. Отдельный режим нужен потому,
// что смотреть и принимать — разные действия: раньше единственным способом увидеть команды
// был `--accept`, то есть чтобы прочитать, приходилось согласиться.
function modeShow() {
  const st = load();
  if (st.fatal) { say(st.fatal); process.exit(3); }
  if (st.empty) { say(st.empty); process.exit(3); }
  if (st.block.checks.length === 0) {
    say('в блоке нет команд — показывать нечего');
    process.exit(0);
  }
  printPlan(st);
  say(`hash: ${st.canon.hash}`);
  say(st.accepted
    ? 'подтверждение: есть — этот набор уже принят'
    : 'подтверждение: нет. Принять может только человек из терминала: --accept');
  process.exit(0);
}

async function modeAccept() {
  const st = load();
  if (st.fatal) { say(st.fatal); process.exit(3); }
  if (st.empty) { say(st.empty); process.exit(3); }
  if (st.block.checks.length === 0) {
    say('в блоке нет команд — подтверждать нечего');
    process.exit(0);
  }
  // Команды печатаются ДО записи подтверждения: подтверждать не глядя нечего.
  printPlan(st);

  // Без терминала приёма нет — и это не придирка. Печать команд имеет смысл ровно тогда,
  // когда у человека есть возможность ответить «нет»; если ответить некому, печать
  // превращается в декорацию, а подтверждение — в формальность, которую выполнит кто угодно.
  // Права («нет в allow» = «спросить») закрывают этот путь слабее: человек подтверждает строку
  // запуска, а не пять команд внутри блока — их он увидит уже после согласия.
  if (!process.stdin.isTTY) {
    say('принять набор команд можно только с клавиатуры: нет терминала — нет подтверждения.');
    say(`посмотреть, что предлагается, можно без записи: node ${rel(path.join(KIT_DIR, 'hooks', 'verify.mjs'))} --show`);
    process.exit(3);
  }

  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let answer = '';
  try {
    answer = (await rl.question(`${TAG} принять этот набор команд? введите «да»: `)).trim().toLowerCase();
  } finally {
    rl.close();
  }
  if (answer !== 'да' && answer !== 'yes' && answer !== 'y') {
    say(`не принято (введено: «${answer || 'пусто'}») — ${rel(LOCK)} не тронут`);
    process.exit(3);
  }

  writeSecure(LOCK, {
    hash: st.canon.hash,
    accepted_at: new Date().toISOString(),
    names: st.canon.obj.checks.map((c) => c.name)
  });
  say(`блок подтверждён: команд ${st.block.checks.length}, hash ${st.canon.hash.slice(0, 12)}…`);
  say(`подтверждение записано в ${rel(LOCK)} (изменятся команды — спросим заново)`);
  process.exit(0);
}

function modeInit() {
  if (!existsSync(PROFILE)) { say(`профиль не найден: ${rel(PROFILE)}`); process.exit(3); }
  const text = readFileSync(PROFILE, 'utf8');
  const block = parseBlock(text);
  if (block.present) {
    say(`блок ${OPEN} в профиле уже есть — ничего не меняю`);
    process.exit(0);
  }
  const tpl = emptyBlockLines();
  const lines = block.lines;
  const head = lines.findIndex((l) => /^##\s*2\./.test(l.trim()));
  if (head < 0) {
    say('в профиле нет заголовка «## 2.» — вставьте блок руками, вот он:');
    for (const l of tpl) console.log(l);
    process.exit(0);
  }
  // Вставляем после заголовка и вводной цитаты — только ДОБАВЛЯЕМ, ничего не переписывая.
  let at = head + 1;
  while (at < lines.length && !lines[at].trim()) at++;
  while (at < lines.length && lines[at].trim().startsWith('>')) at++;
  while (at < lines.length && !lines[at].trim()) at++;
  const next = lines.slice(0, at).concat(tpl, [''], lines.slice(at));
  writeFileSync(PROFILE, next.join(block.eol), 'utf8');
  say(`пустой блок ${OPEN} добавлен в §2 профиля — впишите команды и подтвердите: --accept`);
  process.exit(0);
}

function emptyBlockLines() {
  return [
    OPEN,
    '```yaml',
    `timeout: ${DEFAULT_TIMEOUT}`,
    'checks: []',
    '# - name: тесты',
    '#   cmd: npm test',
    '```',
    CLOSE
  ];
}

function modeSelftest() {
  const st = load();
  if (st.fatal) {
    say(st.fatal);
    console.log(`${TAG} итог: настроено проверок: 0 · подтверждение: нет`);
    process.exit(0);
  }
  if (st.empty) {
    say(st.empty);
    say(`создать пустой блок: node ${rel(path.join(KIT_DIR, 'hooks', 'verify.mjs'))} --init`);
    console.log(`${TAG} итог: настроено проверок: 0 · подтверждение: нет`);
    process.exit(0);
  }
  say(`профиль: ${rel(PROFILE)}`);
  say(`общий таймаут: ${st.block.timeout} с на команду`);
  for (const w of st.block.warnings || []) say(`⚠️ ${w}`);
  for (const c of st.block.checks) {
    const miss = unavailable(c.cmd);
    const state = miss ? `↷ ${miss}` : '✓ будет выполнена';
    say(`  ${c.name}: ${mask(c.cmd)} — ${state}`);
  }
  say(st.accepted
    ? `подтверждение: есть (${rel(LOCK)})`
    : 'подтверждение: нет — первый прогон потребует --accept от человека');
  say('маскирование секретов ловит типовые формы и гарантией не является');
  console.log(`${TAG} итог: настроено проверок: ${st.block.checks.length} · подтверждение: ${st.accepted ? 'есть' : 'нет'}`);
  process.exit(0);
}

function modeFresh() {
  let data;
  try {
    if (!existsSync(OUT)) { say('приёмки нет: VERIFY.json отсутствует'); process.exit(3); }
    data = JSON.parse(readFileSync(OUT, 'utf8'));
  } catch {
    say('приёмки нет: VERIFY.json не читается');
    process.exit(3);
  }
  const now = fingerprint();
  if (!now || !data.fingerprint) {
    say('свежесть приёмки не подтверждена: отпечаток недоступен (папка не под git)');
    process.exit(3);
  }
  if (JSON.stringify(now) !== JSON.stringify(data.fingerprint)) {
    say('приёмка устарела: файлы менялись после прогона');
    process.exit(1);
  }
  if (data.status === 'fail') {
    say(`приёмка свежая, но красная: упала проверка «${data.failed}»`);
    process.exit(1);
  }
  if (String(data.scope || '').startsWith('only:')) {
    say(`приёмка частичная: прогон --only (${data.scope})`);
    process.exit(1);
  }
  if (Number(data.skipped) > 0) {
    say(`приёмка частичная: пропущено ${data.skipped}`);
    process.exit(1);
  }
  say('приёмка свежая');
  process.exit(0);
}

function modeRun() {
  const st = load();
  if (st.fatal) { say(st.fatal); process.exit(3); }
  if (st.empty) { say(st.empty); process.exit(3); }

  const only = onlyName();
  if (only && !st.block.checks.some((c) => c.name === only)) {
    say(`нет проверки с именем «${only}». Есть: ${st.block.checks.map((c) => c.name).join(', ') || '—'}`);
    process.exit(3);
  }
  const list = only ? st.block.checks.filter((c) => c.name === only) : st.block.checks;

  printPlan(st, list);
  if (list.length === 0) { say('в блоке нет ни одной проверки — прогонять нечего'); process.exit(3); }

  if (!st.accepted) {
    say('блок проверок не подтверждён — команды не выполнены');
    say('прочитайте список выше глазами и, если он ваш, подтвердите:');
    say(`  node ${rel(path.join(KIT_DIR, 'hooks', 'verify.mjs'))} --accept`);
    process.exit(3);
  }

  const results = [];
  let failed = null;
  for (const c of list) {
    const r = runCheck(c, st.block.timeout);
    results.push(r);
    if (r.skipped) { say(`↷ ${r.name} пропущено: ${r.skipped}`); continue; }
    if (r.code === 0) { say(`✓ ${r.name} ${(r.ms / 1000).toFixed(1)} с`); continue; }
    say(`✗ ${r.name} (${r.reason || `код ${r.code}`})`);
    failed = r.name;
    break;   // порядок значим: дальше не идём
  }

  const skipped = results.filter((r) => r.skipped).length;
  const passed = results.filter((r) => !r.skipped && r.code === 0).length;
  const failedCount = failed ? 1 : 0;
  const scope = only ? `only:${only}` : 'full';
  let status = 'pass';
  if (failedCount) status = 'fail';
  else if (skipped > 0 || scope !== 'full') status = 'partial';

  writeSecure(OUT, {
    ts: new Date().toISOString(),
    status,
    scope,
    total: list.length,
    passed,
    skipped,
    failed_count: failedCount,
    failed,
    checks_hash: st.canon.hash,
    fingerprint: fingerprint(),
    checks: results.map((r) => {
      const item = { name: r.name, cmd: mask(r.cmd), code: r.code, ms: r.ms };
      if (r.skipped) item.skipped = r.skipped;
      if (r.timeout) item.timeout = r.timeout;
      if (r.reason) item.reason = r.reason;
      if (r.tail) item.tail = r.tail;
      return item;
    })
  });

  const tail = [`итог: ${passed} из ${list.length}`];
  if (skipped) tail.push(`пропущено ${skipped}`);
  if (failed) tail.push(`упало ${failed}`);
  say(`${tail.join(', ')} → ${status}`);
  if (status !== 'pass') say(`подробности: ${rel(OUT)}`);
  // Коды различают три разных исхода, а не два. Ноль при пропущенных проверках был бы тихим
  // ложным зелёным: вызывающая сторона идёт дальше, человек ничего не замечает.
  process.exit(status === 'fail' ? 1 : status === 'partial' ? 4 : 0);
}

function onlyName() {
  const i = process.argv.indexOf('--only');
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith('--only='));
  if (eq) return eq.slice('--only='.length);
  if (i >= 0) { say('после --only нужно имя проверки'); process.exit(3); }
  return null;
}

// --- прогон -----------------------------------------------------------------

/**
 * Один прогон. Возвращает `{name, cmd, code, ms, skipped?, timeout?, reason?, tail?}`.
 * Неопределённости не оставляем: превышение буфера, таймаут и завершение без кода —
 * это провал с внятным текстом, а не «ну как-то так».
 */
function runCheck(c, globalTimeout) {
  const seconds = Number(c.timeout) || Number(globalTimeout) || DEFAULT_TIMEOUT;
  const miss = unavailable(c.cmd);
  if (miss) return { name: c.name, cmd: c.cmd, code: null, ms: 0, skipped: miss };

  const opts = {
    cwd: PROJECT_ROOT,
    shell: true,
    encoding: 'utf8',
    timeout: seconds * 1000,
    maxBuffer: MAX_BUFFER
  };
  if (process.platform !== 'win32') opts.detached = true;   // свой ID группы — чтобы убить всё дерево

  const started = Date.now();
  const r = spawnSync(c.cmd, opts);
  const ms = Date.now() - started;
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const res = { name: c.name, cmd: c.cmd, code: r.status === undefined ? null : r.status, ms };

  const code = r.error && r.error.code;
  if (code === 'ETIMEDOUT') {
    killTree(r.pid);
    res.code = res.code === null || res.code === undefined ? 124 : res.code;
    res.timeout = seconds;
    res.reason = `таймаут ${seconds} с`;
  } else if (code === 'ENOBUFS') {
    res.code = res.code || 1;
    res.reason = `вывод превысил ${Math.round(MAX_BUFFER / 1024 / 1024)} МБ — считаем провалом`;
  } else if (r.error) {
    res.code = res.code || 1;
    res.reason = `не удалось запустить: ${r.error.message}`;
  } else if (r.status === null) {
    res.code = 1;
    res.reason = `процесс завершился без кода возврата${r.signal ? ` (сигнал ${r.signal})` : ''}`;
  }
  if (res.code !== 0) res.tail = tailOf(out);
  return res;
}

/**
 * Убийство дерева процессов — best effort. На POSIX бьём группу (её даёт `detached`),
 * на Windows — `taskkill /T /F`. Если шелл уже умер, внуки могут осиротеть: тогда честно
 * говорим об этом, а не делаем вид, что всё чисто.
 */
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { encoding: 'utf8', timeout: 10000 });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    say('⚠️ дочерние процессы могли остаться — проверьте диспетчер задач');
  }
}

/**
 * Проба доступности. Делается ТОЛЬКО для простой команды: без `=`, кавычек и шелл-операторов,
 * с именем без разделителей пути. Всё остальное (`TOKEN=x npm test`, `cd sub && …`, билтины,
 * `npx`) честно запускается — ложное «пропущено» опаснее лишнего запуска.
 */
function unavailable(cmd) {
  const s = String(cmd);
  if (/[=|;&<>"']/.test(s)) return null;
  const first = s.trim().split(/\s+/)[0];
  if (!first || NO_PROBE.has(first)) return null;
  if (first.includes('/') || first.includes('\\')) return null;
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(finder, [first], { encoding: 'utf8', timeout: 10000 });
  if (r.error) return null;   // нет самого where/which — не выдумываем пропуск
  return r.status === 0 ? null : `команда не найдена: ${first}`;
}

// --- отпечаток дерева -------------------------------------------------------

/**
 * Отпечаток ПО СОДЕРЖИМОМУ: `--porcelain` описывает состояние, а не содержимое, поэтому
 * повторная правка уже изменённого файла его бы не сдвинула. Три дешёвых вызова git.
 * Не git-папка → null (это не ошибка). Слепая зона — игнорируемые пути (см. шапку).
 */
function fingerprint() {
  const inside = git(['rev-parse', '--is-inside-work-tree']);
  if (inside === null) return null;
  const head = git(['rev-parse', 'HEAD']);
  const diff = git(['diff', 'HEAD']);
  const untracked = git(['status', '--porcelain', '-uall']);
  if (diff === null || untracked === null) return null;
  return {
    head: head === null ? 'no-commits' : head.trim(),
    diff: sha256(diff),
    untracked: sha256(untracked)
  };
}

function git(args) {
  const r = spawnSync('git', args, {
    cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024
  });
  if (r.error || r.status !== 0) return null;
  return r.stdout || '';
}

function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// --- маскирование -----------------------------------------------------------

/**
 * Одна маска и на хвост вывода, и на строку команды. Ловит типовые формы; ГАРАНТИЕЙ НЕ ЯВЛЯЕТСЯ.
 * Лишняя звёздочка предпочтительнее пропущенного токена. Исполняется команда, разумеется,
 * неизменённой — маска только для печати и для JSON.
 */
function mask(text) {
  if (!text) return text;
  let s = String(text);
  s = s.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, MASK);
  s = s.replace(
    /(token|secret|password|passwd|pwd|pass|api[-_]?key|key|credential|cookie|session|authorization)(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    (m, word, sep) => `${word}${sep}${MASK}`
  );
  s = s.replace(/Bearer\s+\S+/gi, `Bearer ${MASK}`);
  s = s.replace(/:\/\/[^/\s:@]+:[^/\s@]+@/g, `://${MASK}@`);
  s = s.replace(/AKIA[0-9A-Z]{16}/g, MASK);
  s = s.replace(/ghp_[A-Za-z0-9]{20,}/g, MASK);
  s = s.replace(/github_pat_[A-Za-z0-9_]{20,}/g, MASK);
  s = s.replace(/xox[baprs]-[A-Za-z0-9-]{10,}/g, MASK);
  s = s.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK);
  return s;
}

function tailOf(out) {
  let cut = false;
  let lines = mask(out).split('\n');
  if (lines.length > TAIL_LINES) { lines = lines.slice(-TAIL_LINES); cut = true; }
  let s = lines.join('\n');
  if (Buffer.byteLength(s, 'utf8') > TAIL_BYTES) {
    // срез по байтам может разрубить символ UTF-8 — убираем «битый» хвостик в начале
    s = Buffer.from(s, 'utf8').subarray(-TAIL_BYTES).toString('utf8').replace(/^\uFFFD+/, '');
    cut = true;
  }
  return cut ? `… (обрезано)\n${s}` : s;
}

// --- вывод и файлы ----------------------------------------------------------

/** Список команд печатается ВСЕГДА, а не только в --dry: что запускается — должно быть видно. */
function printPlan(st, list) {
  const checks = list || st.block.checks;
  say(`будут выполнены команды из ${rel(PROFILE)} (порядок значим, останов на первой упавшей):`);
  if (checks.length === 0) return;
  checks.forEach((c, i) => {
    const t = c.timeout ? ` [таймаут ${c.timeout} с]` : '';
    console.log(`${TAG}   ${i + 1}. ${c.name}: ${mask(c.cmd)}${t}`);
  });
  for (const w of st.block.warnings || []) say(`⚠️ ${w}`);
}

function writeSecure(file, obj) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* Windows — прав такого вида нет, это не ошибка */ }
}

function rel(p) {
  const r = path.relative(PROJECT_ROOT, p);
  return (!r || r.startsWith('..')) ? p : r.split(path.sep).join('/');
}

function say(line) {
  console.log(`${TAG} ${line}`);
}
