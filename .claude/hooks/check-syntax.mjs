#!/usr/bin/env node
/**
 * PostToolUse-хук (Claude Agent Kit) — быстрая проверка синтаксиса изменённого файла.
 * Кроссплатформенный, БЕЗ внешних зависимостей: работает сразу после распаковки набора,
 * `npm install` не нужен.
 *
 *   .js .mjs .cjs   → встроенный парсер Node (`node --check`), всегда доступен
 *   .ts .tsx .jsx   → @babel/parser, если он есть в проекте; иначе — проверка баланса
 *                     скобок (предупреждение, не блокирует)
 *   .py             → ast.parse, но только через ПРОВЕРЕННЫЙ интерпретатор
 *                     (заглушка Windows Store отсеивается пробным запуском)
 *   .json .jsonc    → JSON.parse; для tsconfig-подобных файлов допускаются
 *                     комментарии и висящие запятые
 *   .yml .yaml      → структурная проверка (табы в отступах — ошибка YAML)
 *   .md             → YAML-front-matter, если он есть; для файлов агентов и команд
 *                     дополнительно проверяются обязательные поля и совпадение имени
 *   .css .scss .less→ баланс фигурных скобок (предупреждение, не блокирует)
 *
 * Дополнительно для .md и .js/.mjs/.cjs — ссылки на код по имени в явной форме
 * («`analysePlan()` в `task.mjs`»): названный идентификатор обязан быть определён в названном
 * файле. Это помощник, а не гарантия, — границы описаны в докблоке `checkCodeRefs`.
 *
 * Ошибка разбора → exit 2: Claude Code вернёт текст ошибки агенту, и он поправит файл.
 * Если проверить нечем — хук НЕ молчит, а печатает одну строку «пропущено, потому что…»,
 * чтобы неработающая проверка не выглядела как успешная.
 *
 * Ручной запуск:
 *   node .claude/hooks/check-syntax.mjs --selftest      что умеет проверять на этой машине
 *   node .claude/hooks/check-syntax.mjs путь/к/файлу    проверить один файл
 */

import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { fenceMask } from './md-fence.mjs';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const JS_PLAIN = ['.js', '.mjs', '.cjs'];
const JS_DIALECT = ['.ts', '.tsx', '.jsx'];
const STYLES = ['.css', '.scss', '.less'];

// Явная форма ссылки на код: имя функции со скобками и рядом файл, в котором она определена, —
// `analysePlan()` в `task.mjs`. Связка необязательна, но список её закрыт: свободный текст
// между именем и файлом означает предложение, а не ссылку. Так «`emit()` зовёт `events.mjs`»
// (правда о вызове, а не о месте определения) под проверку не попадает и ложным отказом
// не становится. Объявления стоят ЗДЕСЬ, выше точки входа: проверка вызывается из блока ниже,
// а `const` на верхнем уровне модуля до своей строки лежит в мёртвой зоне — рядом с функциями
// они дали бы ReferenceError на первом же файле (тот же капкан описан в `task.mjs`).
const REF_RE = /`([A-Za-z_][A-Za-z0-9_]*)\(\)`(?:\s+(?:в|во|из|внутри|у))?\s+`([^`\s]+\.(?:mjs|js|cjs|ts|py))`/g;

// Рабочие файлы конвейера: план и ревью живут днями, ссылаются на функции, которых ещё нет
// («создать `analysePlan()` в `task.mjs`»), и проверять их этой меркой нельзя.
const REF_SKIP = ['.claude/tasks/', '.claude/explores/', '.claude/artifacts/'];

// Признак «это исходники самого набора» считается один раз и живёт здесь по той же причине,
// что REF_RE: объявление ниже точки входа попало бы в мёртвую зону. Что он решает — в докблоке
// `kitSources()`.
let kitMemo = null;

// --- точка входа ------------------------------------------------------------

const arg = process.argv[2];
if (arg === '--selftest') { selftest(); process.exit(0); }

const file = arg ? resolveFile(arg) : resolveFile(fileFromStdin());
if (!file) process.exit(0);

const ext = path.extname(file).toLowerCase();
const rel = shortPath(file);

/** Путь относительно проекта; если файл вне проекта — абсолютный, без цепочек `..\..\..`. */
function shortPath(full) {
  const r = path.relative(PROJECT_DIR, full);
  return (!r || r.startsWith('..')) ? full : r;
}

if (JS_PLAIN.includes(ext)) checkPlainJs(file, ext, rel);
else if (JS_DIALECT.includes(ext)) checkDialect(file, ext, rel);
else if (ext === '.py') checkPython(file, rel);
else if (ext === '.json' || ext === '.jsonc') checkJson(file, rel);
else if (ext === '.yml' || ext === '.yaml') checkYaml(readFileSync(file, 'utf8'), rel);
else if (ext === '.md') checkFrontMatter(file, rel);
else if (STYLES.includes(ext)) checkStyles(file, rel);
if (ext === '.md' || JS_PLAIN.includes(ext)) checkCodeRefs(file, rel);
process.exit(0);

// --- получение пути ---------------------------------------------------------

/**
 * Claude Code передаёт хуку JSON на stdin. На Windows чтение fd 0 иногда отдаёт
 * EAGAIN на первых попытках — раньше это приводило к тихому пропуску проверки,
 * поэтому здесь короткая серия повторов, а не одна попытка.
 */
function fileFromStdin() {
  let raw = '';
  for (let i = 0; i < 12; i++) {
    try { raw = readFileSync(0, 'utf8'); break; }
    catch (e) {
      if (e.code !== 'EAGAIN') return '';
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); } catch { /* ждать нечем */ }
    }
  }
  if (!raw) return '';
  try {
    const input = (JSON.parse(raw).tool_input) || {};
    return input.file_path || input.notebook_path || '';
  } catch { return ''; }
}

function resolveFile(p) {
  if (!p) return '';
  const full = path.isAbsolute(p) ? p : path.join(PROJECT_DIR, p);
  return existsSync(full) ? full : '';
}

// --- вывод ------------------------------------------------------------------

function fail(msg) { process.stderr.write(msg + '\n'); process.exit(2); }
function warn(msg) { process.stdout.write(msg + '\n'); }
/** Проверить нечем — говорим об этом вслух, но работу не блокируем. */
function skipped(what, why) { warn(`[syntax] пропущено (${what}): ${why}`); }

/**
 * Выполняет fn не чаще раза в 6 часов на связку «проект + повод».
 * Нужно для уведомлений о недоступной проверке: сказать о них важно, но повторять
 * на каждой правке файла — значит превратить полезное предупреждение в шум.
 */
function once(key, fn) {
  const id = createHash('sha1').update(`${PROJECT_DIR}|${key}`).digest('hex').slice(0, 16);
  const stamp = path.join(os.tmpdir(), `cckit-notice-${id}`);
  try {
    if (Date.now() - statSync(stamp).mtimeMs < 6 * 60 * 60 * 1000) return;
  } catch { /* штампа ещё нет — значит, говорим */ }
  fn();
  try { writeFileSync(stamp, ''); } catch { /* временную папку не записать — переживём */ }
}

// --- JS: встроенный парсер Node ---------------------------------------------

/**
 * Запускает `node --check`. Для .js делает до двух повторов на временной копии
 * с расширением .mjs / .cjs: на старых версиях Node автоопределение модуля
 * не работает, и валидный ESM-файл с расширением .js иначе даёт ложную ошибку.
 */
function checkPlainJs(file, ext, rel) {
  const direct = nodeCheck(file, rel);
  if (direct.ok) return;
  if (ext === '.js') {
    for (const probeExt of ['.mjs', '.cjs']) {
      if (copyAndCheck(file, probeExt, rel).ok) return;
    }
  }
  fail(`[syntax] JS: ${rel}\n${direct.err}`);
}

function nodeCheck(target, rel) {
  const r = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
  if (r.error) return { ok: true, err: '' };            // запустить Node нечем — не блокируем
  return { ok: r.status === 0, err: cleanup(r.stderr, target, rel) };
}

function copyAndCheck(file, probeExt, rel) {
  let dir = '';
  try {
    dir = mkdtempSync(path.join(os.tmpdir(), 'cckit-syntax-'));
    const probe = path.join(dir, 'probe' + probeExt);
    writeFileSync(probe, readFileSync(file));
    return nodeCheck(probe, rel);
  } catch {
    return { ok: true, err: '' };                        // временный файл не создался — не блокируем
  } finally {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* уже нет */ } }
  }
}

/** Убирает из вывода Node абсолютные пути (в т.ч. временные) и служебный хвост. */
function cleanup(stderr, target, rel) {
  return String(stderr || '')
    .split(target).join(rel)
    .split('\n')
    .filter((l) => !/^\s*(at |Node\.js v)/.test(l))
    .join('\n')
    .trim();
}

// --- TS / TSX / JSX ---------------------------------------------------------

function checkDialect(file, ext, rel) {
  const parser = loadBabel(file);
  if (!parser) {
    // Полного парсера нет — ловим хотя бы обрыв файла на середине, самую частую поломку.
    const bad = unbalanced(readFileSync(file, 'utf8'), '{}()[]');
    if (bad) warn(`[syntax] ${rel}: похоже на несбалансированные скобки (${bad}) — файл мог обрезаться`);
    else once(ext, () => skipped(ext, 'парсер TS/JSX не найден; поставьте @babel/parser в проект для полной проверки'));
    return;
  }
  const plugins = ['classProperties', 'optionalChaining', 'nullishCoalescingOperator',
    'topLevelAwait', 'decorators-legacy'];
  if (ext === '.tsx') plugins.push('jsx', 'typescript');
  else if (ext === '.ts') plugins.push('typescript');
  else plugins.push('jsx');
  try {
    parser.parse(readFileSync(file, 'utf8'), {
      sourceType: 'module', allowReturnOutsideFunction: true, plugins,
    });
  } catch (e) {
    fail(`[syntax] ${ext.slice(1).toUpperCase()}: ${rel}\n${e.message}`);
  }
}

/** Ищет @babel/parser вверх по дереву от файла и в типичных папках фронта. */
function loadBabel(fromFile) {
  const anchors = [];
  let dir = path.dirname(fromFile);
  for (let i = 0; i < 8; i++) {
    anchors.push(path.join(dir, 'package.json'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const sub of ['', 'frontend', 'web', 'client', 'app', 'ui']) {
    anchors.push(path.join(PROJECT_DIR, sub, 'package.json'));
  }
  for (const anchor of anchors) {
    if (!existsSync(anchor)) continue;
    try { return createRequire(anchor)('@babel/parser'); } catch { /* пробуем дальше */ }
  }
  return null;
}

// --- Python -----------------------------------------------------------------

function checkPython(file, rel) {
  const py = findPython();
  if (!py) { once('.py', () => skipped('.py', 'рабочий интерпретатор Python не найден')); return; }
  const code = 'import ast,sys\nast.parse(open(sys.argv[1],encoding="utf-8").read())\n';
  const r = spawnSync(py.bin, [...py.pre, '-c', code, file], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  if (!r.error && r.status !== 0) fail(`[syntax] Python: ${rel}\n${(r.stderr || '').trim()}`);
}

/**
 * Возвращает первый интерпретатор, который РЕАЛЬНО исполняет код.
 * Проверка обязательна: в Windows на PATH обычно висит заглушка Microsoft Store
 * с именем python.exe — она ничего не выполняет, и проверка «прошла бы» вхолостую.
 */
function findPython() {
  const cands = process.platform === 'win32'
    ? [{ bin: 'py', pre: ['-3'] }, { bin: 'python', pre: [] }, { bin: 'python3', pre: [] }]
    : [{ bin: 'python3', pre: [] }, { bin: 'python', pre: [] }];
  for (const c of cands) {
    const r = spawnSync(c.bin, [...c.pre, '-c', 'print(6*7)'], {
      encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    if (!r.error && r.status === 0 && String(r.stdout).trim() === '42') return c;
  }
  return null;
}

// --- JSON -------------------------------------------------------------------

/**
 * Строгий JSON.parse. Послабление (комментарии, висящие запятые) даётся только файлам,
 * которым оно положено по формату — tsconfig и родня. В обычном .json висящая запятая
 * это ошибка, и хук обязан её заблокировать, а не «простить».
 */
function checkJson(file, rel) {
  const src = readFileSync(file, 'utf8');
  try { JSON.parse(src); return; } catch (strict) {
    if (!allowsJsonc(file)) fail(`[syntax] JSON: ${rel}\n${strict.message}`);
    try { JSON.parse(stripJsonc(src)); }
    catch { fail(`[syntax] JSONC: ${rel}\n${strict.message}`); }
  }
}

function allowsJsonc(file) {
  const name = path.basename(file).toLowerCase();
  return name.endsWith('.jsonc')
    || /^(ts|js)config(\..+)?\.json$/.test(name)
    || path.dirname(file).toLowerCase().endsWith(`${path.sep}.vscode`);
}

function stripJsonc(src) {
  let out = '', inStr = false, esc = false, line = false, block = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (line) { if (c === '\n') { line = false; out += c; } continue; }
    if (block) { if (c === '*' && n === '/') { block = false; i++; } continue; }
    if (inStr) {
      out += c;
      if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && n === '/') { line = true; i++; continue; }
    if (c === '/' && n === '*') { block = true; i++; continue; }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

// --- YAML и front-matter ----------------------------------------------------

/**
 * Структурная проверка YAML без внешнего парсера. Блокирует только на том, что
 * является ошибкой YAML однозначно, — иначе ложное срабатывание встанет поперёк работы.
 * `offset` сдвигает номера строк, когда проверяется front-matter внутри .md.
 */
function checkYaml(src, rel, offset = 0) {
  const lines = src.split(/\r?\n/);
  let inBlockScalar = false, blockIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], no = i + 1 + offset;
    const indent = line.length - line.trimStart().length;

    if (inBlockScalar) {
      if (line.trim() === '' || indent > blockIndent) continue;
      inBlockScalar = false;
    }
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;

    // Таб в отступе — однозначная ошибка: YAML запрещает табуляцию как отступ.
    if (/^[ ]*\t/.test(line)) fail(`[syntax] YAML: ${rel}:${no}\nтабуляция в отступе — YAML запрещает табы, используйте пробелы`);

    // Блочный скаляр (| или >) — его содержимое не разбираем.
    if (/:\s*[|>][-+]?\d*\s*$/.test(line)) { inBlockScalar = true; blockIndent = indent; continue; }

    const flow = unbalanced(line, '[]{}');
    if (flow && !/[|>]\s*$/.test(line)) warn(`[yaml] ${rel}:${no}: не сходятся скобки (${flow})`);
  }
}

/**
 * Проверяет YAML-front-matter в .md. Для агентов и команд Claude Code это не косметика:
 * сломанный или неполный front-matter означает, что агент просто не загрузится, причём молча.
 */
function checkFrontMatter(file, rel) {
  const src = readFileSync(file, 'utf8');
  if (!/^---\r?\n/.test(src)) return;                    // front-matter нет — обычный markdown

  const lines = src.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end === -1) fail(`[syntax] front-matter: ${rel}\nблок открыт \`---\`, но не закрыт — Claude Code не прочитает этот файл`);

  const body = lines.slice(1, end);
  checkYaml(body.join('\n'), rel, 1);

  const fields = new Map();
  body.forEach((line, i) => {
    if (line.trim() === '' || line.trimStart().startsWith('#') || /^\s*-\s/.test(line)) return;
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:(.*)$/);
    if (!m) {
      if (/^\s/.test(line)) return;                      // перенос значения предыдущего ключа
      fail(`[syntax] front-matter: ${rel}:${i + 2}\nстрока не похожа на \`ключ: значение\`: ${line.trim()}`);
    }
    fields.set(m[1], m[2].trim());
  });

  const dir = path.basename(path.dirname(file));
  const base = path.basename(file, '.md');
  if (dir === 'agents') {
    for (const key of ['name', 'description']) {
      if (!fields.get(key)) fail(`[syntax] агент ${rel}\nв front-matter нет обязательного поля \`${key}\` — агент не загрузится`);
    }
    if (fields.get('name') !== base) {
      fail(`[syntax] агент ${rel}\nимя файла (${base}) и поле name (${fields.get('name')}) не совпадают — вызвать такого агента не получится`);
    }
    // Опечатка в модели тихо ломает агента, поэтому лучше сказать. Предупреждение, а не
    // ошибка: список псевдонимов пополняется, и блокировать новый — хуже, чем пропустить.
    const model = fields.get('model');
    const known = ['inherit', 'opus', 'sonnet', 'haiku'];
    if (model && !known.includes(model) && !/^claude-/.test(model)) {
      warn(`[md] ${rel}: model «${model}» не из известных (${known.join(', ')} или claude-*) — проверьте написание`);
    }
  } else if (dir === 'commands' && !fields.get('description')) {
    warn(`[md] ${rel}: у команды нет поля description — она будет без подписи в списке команд`);
  }
}

// --- ссылки на код по имени -------------------------------------------------

/**
 * Ссылки на код по имени в долгоживущих документах и докблоках: проверяем, что названный
 * идентификатор в названном файле действительно определён.
 *
 * Зачем. Правило «ссылаться по имени функции, а не по номеру строки» введено ради
 * самопроверки: переименовали функцию — ссылка перестала находиться. Первая же партия ссылок
 * оказалась битой целиком (`plannedPaths` — четыре ссылки, ни одного определения), то есть
 * правило без машинной проверки не работает.
 *
 * ЧЕСТНО ПРО ГРАНИЦЫ. Это ПОМОЩНИК, а не гарантия, и ошибается он В ОБЕ СТОРОНЫ.
 *
 * ЧТО ПРОПУСКАЕТ. Хук висит на `PostToolUse`, а тот срабатывает не в каждой сессии —
 * наблюдалось и записано в плане фазы 0. Проверяется только явная форма (см. `REF_RE`):
 * ссылка «`decide()` … (`gate.mjs`)» через полстроки текста под неё не подходит, как и имя
 * не латиницей. Файл, которого нет на диске, пропускается молча: документ вправе называть
 * файлы чужого проекта. Ограждённые блоки маскируются целиком — ссылка внутри примера
 * не проверяется вовсе, и строка из трёх кавычек внутри шаблонной строки `.js` замаскирует
 * хвост файла. Рабочие файлы конвейера (`REF_SKIP`) не проверяются: план законно называет
 * функции, которых ещё нет.
 *
 * ГДЕ ОТКАЗЫВАЕТ ЛОЖНО — это дороже пропуска, потому что блокирует правку ВЕРНОГО текста
 * и толкает агента «починить» правильную документацию. Первое: `definedIn()` знает
 * перечисленные в нём формы определения и только их — `Object.defineProperty(obj, 'name', …)`,
 * имя, собранное из кусков, и определение, уехавшее в другой файл, дадут «ссылка никуда
 * не ведёт» на верной ссылке. Второе: голое имя файла без каталога ищется среди хуков набора
 * (`resolveRef()`), поэтому документ САМОГО набора, назвавший `map.mjs`, сверяется с хуком
 * набора, даже если имелся в виду другой файл. Получив такой отказ, сверьте определение
 * глазами; верный текст под проверку не подгоняют.
 */
function checkCodeRefs(file, rel) {
  const posix = rel.split('\\').join('/');
  if (REF_SKIP.some((p) => posix.includes(p))) return;

  const src = readFileSync(file, 'utf8');
  // Ограждённый блок — пример, а не утверждение: битую ссылку в нём цитируют намеренно
  // («так писать НЕ надо»), и блокировать это значит запрещать документировать собственную
  // находку. Маска общая с полом класса риска (`fenceMask()` в `md-fence.mjs`): две проверки
  // одного набора обязаны понимать markdown одинаково. Замаскированные строки заменяются
  // пробелами ТОЙ ЖЕ ДЛИНЫ — смещения не съезжают, и номер строки в сообщении остаётся верным.
  const lines = src.split('\n');
  const { inside } = fenceMask(lines);
  const scan = lines.map((line, i) => (inside[i] ? ' '.repeat(line.length) : line)).join('\n');

  REF_RE.lastIndex = 0;
  let m;
  while ((m = REF_RE.exec(scan)) !== null) {
    const [, name, named] = m;
    const target = resolveRef(file, named);
    if (!target) continue;                               // файла нет — молча мимо, см. докблок
    if (definedIn(target, name)) continue;
    const line = scan.slice(0, m.index).split('\n').length;
    fail([
      `[syntax] ссылка на код: ${rel}:${line}`,
      `в файле ${named} нет определения \`${name}\` — ссылка никуда не ведёт.`,
      'Проверьте имя (функцию могли переименовать) или назовите тот файл, где она определена.',
    ].join('\n'));
  }
}

/**
 * Файл из ссылки: рядом с документом, от корня проекта или — с оговоркой ниже — среди хуков
 * набора по голому имени.
 *
 * Третий вариант СУЖЕН намеренно. Раньше он склеивал `.claude/hooks` с `basename(named)`,
 * то есть отбрасывал каталог: ссылка на свой `own/map.mjs` в чужом проекте сверялась
 * с `map.mjs` набора — ложный отказ, а при совпадении имён ложное подтверждение, что хуже.
 * Теперь вариант работает, только если в ссылке нет разделителя каталогов И документ
 * принадлежит набору: лежит под `.claude/` либо это исходники самого набора (`kitSources()`).
 * Совсем убрать его нельзя — `PROJECT_PROFILE.md` и `CHANGELOG.md` называют `task.mjs` без
 * каталога, и без третьего варианта десять таких ссылок остались бы непроверенными.
 *
 * Остаток риска назван вслух: `.claude/CLAUDE.md` — законное место и для инструкций чужого
 * проекта, и голое имя оттуда по-прежнему сверится с хуком набора.
 */
function resolveRef(from, named) {
  const tries = [
    path.join(path.dirname(from), named),
    path.join(PROJECT_DIR, named),
  ];
  const doc = path.relative(PROJECT_DIR, from).split('\\').join('/');
  const ofKit = (doc && !doc.startsWith('..') && doc.startsWith('.claude/')) || kitSources();
  const bare = !named.includes('/') && !named.includes('\\');
  if (ofKit && bare) tries.push(path.join(PROJECT_DIR, '.claude', 'hooks', named));
  for (const t of tries) {
    try { if (statSync(t).isFile()) return t; } catch { /* следующий вариант */ }
  }
  return '';
}

/**
 * Исходники самого набора? Признак содержательный и тот же, что в `update.mjs`: оба
 * установщика в корне И `.claude/CLAUDE.md`, первая строка которого называет набор
 * (у пользователя `.claude/CLAUDE.md` — законное место для инструкций его проекта).
 * Решает признак ровно одно — искать ли голое имя файла среди хуков набора, — поэтому цена
 * ошибки мала в обе стороны. Считается один раз за запуск, память — `kitMemo` выше.
 */
function kitSources() {
  if (kitMemo !== null) return kitMemo;
  let named = false;
  try {
    const first = readFileSync(path.join(PROJECT_DIR, '.claude', 'CLAUDE.md'), 'utf8').split('\n')[0];
    named = (first || '').includes('Claude Agent Kit');
  } catch { named = false; }
  kitMemo = named
    && existsSync(path.join(PROJECT_DIR, 'install.ps1'))
    && existsSync(path.join(PROJECT_DIR, 'install.sh'));
  return kitMemo;
}

/**
 * Определение, а не упоминание: объявление функции, переменной, класса, свойства-функции или
 * метода. Вызов `name(...)` определением не считается — иначе проверка соглашалась бы сама
 * с собой.
 *
 * ПЕРЕКОС ВЫБРАН В СТОРОНУ «признать определением». Пропущенная битая ссылка стоит замечания
 * в ревью, а ложный отказ блокирует правку верного текста в чужом проекте и толкает агента
 * «починить» правильную документацию — это дороже. Поэтому формы широкие: `function`/`class`/
 * `const`, деструктуризация (`const { name } = …`), импорт и реэкспорт
 * (`export { name } from …`), свойство-функция (`name: () => …`, `name: function …`), метод
 * объекта и класса, присваивание в любой форме (`X.prototype.name = …`) и `def` из Python.
 * Прежние шесть форм были якорены на начало строки, и на пяти из перечисленных проверка
 * отказывала ВЕРНЫМ ссылкам.
 *
 * ЯКОРЯ `^` НЕТ НИ У ОДНОЙ ФОРМЫ намеренно: в минифицированном или собранном файле
 * (`function alpha(){}function beta(){}`) определение стоит посреди строки. Вместо якоря —
 * граница слева, и точка в ней запрещена: `obj.name` упоминанием быть не перестаёт.
 * Исключение — присваивание, где точка слева и есть определение метода
 * (`X.prototype.name = …`); `=>` и `==` из него исключены, чтобы стрелочный параметр
 * и сравнение не сходили за объявление.
 */
function definedIn(target, name) {
  let src = '';
  try { src = readFileSync(target, 'utf8'); } catch { return true; }   // не прочитали — не блокируем
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);
  const b = '(?:^|[^\\w$.])';                            // слева не буква, не $ и не точка
  const forms = [
    `${b}(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s+${n}\\b`,
    `${b}(?:export\\s+)?(?:abstract\\s+)?class\\s+${n}\\b`,
    `${b}(?:export\\s+)?(?:const|let|var)\\s+${n}\\b`,
    `(?:const|let|var|import)\\b\\s*[{[][^}\\]]*\\b${n}\\b[^}\\]]*[}\\]]\\s*(?:=|from\\b)`,
    `export\\s*{[^}]*\\b${n}\\b[^}]*}`,
    `${b}${n}\\s*:\\s*(?:async\\s+)?(?:function\\b|\\(|[A-Za-z_$][\\w$]*\\s*=>)`,
    `${b}(?:static\\s+)?(?:async\\s+)?(?:get\\s+|set\\s+)?${n}\\s*\\([^)]*\\)\\s*{`,
    `(?:^|[^\\w$])${n}\\s*=(?![=>])`,
    `(?:^|[^\\w$])(?:async\\s+)?def\\s+${n}\\s*\\(`,
  ];
  return forms.some((re) => new RegExp(re, 'm').test(src));
}

// --- CSS --------------------------------------------------------------------

function checkStyles(file, rel) {
  // Только фигурные: круглые в CSS живут внутри url() и calc() и дают ложные срабатывания.
  const bad = unbalanced(readFileSync(file, 'utf8'), '{}');
  if (bad) warn(`[css] ${rel}: несбалансированные скобки (${bad})`);
}

/**
 * Считает скобки указанных видов вне строк и комментариев. Возвращает описание перекоса
 * или '' если всё сходится. Запасная проверка там, где полноценного парсера нет, поэтому
 * только предупреждает и никогда не блокирует: регулярные выражения здесь не разбираются
 * и теоретически могут дать ложный перекос.
 */
function unbalanced(src, kinds) {
  const tally = new Map();
  for (let i = 0; i < kinds.length; i += 2) tally.set(kinds[i], { close: kinds[i + 1], o: 0, c: 0 });
  const closers = new Map([...tally].map(([o, v]) => [v.close, o]));

  let inStr = '', esc = false, line = false, block = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i], next = src[i + 1];
    if (line) { if (ch === '\n') line = false; continue; }
    if (block) { if (ch === '*' && next === '/') { block = false; i++; } continue; }
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === inStr) inStr = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '/' && next === '/') { line = true; i++; continue; }
    if (ch === '/' && next === '*') { block = true; i++; continue; }
    if (tally.has(ch)) tally.get(ch).o++;
    else if (closers.has(ch)) tally.get(closers.get(ch)).c++;
  }
  for (const [open, v] of tally) {
    if (v.o !== v.c) return `${open} ${v.o} / ${v.close} ${v.c}`;
  }
  return '';
}

// --- самопроверка -----------------------------------------------------------

function selftest() {
  const rows = [
    ['.js / .mjs / .cjs', 'встроенный парсер Node ' + process.version, true],
    ['.json / .jsonc', 'встроенный JSON.parse', true],
    ['.yml / .yaml', 'структурная проверка (табы в отступах)', true],
    ['.md (front-matter)', 'поля агентов и команд, совпадение имени', true],
    ['.md / .js — ссылки', 'явная форма «`имя()` в `файл.mjs`»: имя определено в файле', true],
    ['.css / .scss / .less', 'баланс скобок (предупреждение)', true],
  ];
  const py = findPython();
  rows.push(['.py', py ? `${[py.bin, ...py.pre].join(' ')} — ast.parse` : 'НЕТ рабочего интерпретатора', !!py]);
  const babel = loadBabel(path.join(PROJECT_DIR, 'probe.ts'));
  rows.push(['.ts / .tsx / .jsx', babel ? '@babel/parser' : 'парсера нет — только баланс скобок', !!babel]);

  process.stdout.write('Проверка синтаксиса — что доступно в этом проекте:\n');
  for (const [what, how, ok] of rows) {
    process.stdout.write(`  ${ok ? '+' : '-'} ${what.padEnd(22)} ${how}\n`);
  }
  process.stdout.write('\nБлокирующая проверка работает для JS, JSON и Python (если он есть).\n');
}
