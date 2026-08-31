#!/usr/bin/env node
/**
 * Задачи с идентификаторами (Claude Agent Kit): всё про одну задачу лежит в
 * `.claude/tasks/<ГГГГ-ММ-ДД-имя>/` — STATE.md, PLAN.md, SECURITY.md, REVIEW.md, DONE.md.
 * Какая задача идёт прямо сейчас, говорит однострочный `.claude/tasks/ACTIVE`.
 * Кроссплатформенно, БЕЗ внешних зависимостей: только встроенные модули `node:*`.
 *
 *   node .claude/hooks/task.mjs new "<название>"   завести задачу и сделать её активной
 *   node .claude/hooks/task.mjs status <статус>    сменить статус активной задачи
 *   node .claude/hooks/task.mjs log "<строка>"     дописать строку в журнал
 *   node .claude/hooks/task.mjs close              закрыть задачу и снять указатель
 *   node .claude/hooks/task.mjs list               все задачи: id, дата, статус, заголовок
 *   node .claude/hooks/task.mjs path               абсолютный путь активной задачи, и только он
 *   node .claude/hooks/task.mjs class              класс риска по PLAN.md → поле class в STATE.md
 *   node .claude/hooks/task.mjs stop <kind>        тип вопроса человеку: product|technical|security
 *
 * Про журнал. Обязательные записи делают `status` (смена статуса) и Stop-хук `gate.mjs`
 * (вердикт приёмки) — специально логировать ничего не нужно. `log` остаётся редким ручным
 * инструментом: он несёт произвольный текст человека, поэтому в `permissions.allow`
 * не попадает никогда и спрашивает подтверждения намеренно.
 *
 * Три границы доверия — из-за них хук устроен строже, чем «создать папку»:
 *   • название задачи — текст человека. Берётся ТОЛЬКО первый позиционный аргумент и чистится
 *     повторно (`clean`), даже если его уже чистил тот, кто звал хук;
 *   • идентификатор становится путём только через `taskDir()` — с проверкой формы, потолком
 *     длины и сверкой, что путь лежит внутри `tasks/`. `ACTIVE` — обычный текстовый файл,
 *     его правят руками и через `echo >`, поэтому доверия к нему ровно столько же, сколько
 *     к аргументу командной строки;
 *   • испорченный `ACTIVE` не должен давать примитив записи: `status`, `log` и `close` ничего
 *     не создают — нет папки или нет `STATE.md`, значит сообщение и код 3.
 *
 * Хук не бросает исключений и не «чинит» кривые данные: непонятная запись при перечислении —
 * строка «пропускаю» и продолжение, непонятный запрос — сообщение в stderr и код 3.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { fenceMask } from './md-fence.mjs';

const KIT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROJECT_ROOT = path.dirname(KIT_DIR);
const TASKS = path.join(KIT_DIR, 'tasks');
const ACTIVE = path.join(TASKS, 'ACTIVE');
const STUBS = path.join(KIT_DIR, 'assets', 'stubs');
const GATE_STATE = path.join(KIT_DIR, 'artifacts', 'GATE_STATE.json');
const EVENTS_MJS = path.join(KIT_DIR, 'hooks', 'events.mjs');
const GATE_MJS = path.join(KIT_DIR, 'hooks', 'gate.mjs');
const TAG = '[task]';

// Форма идентификатора — дата и строчное латинское имя. Регэксп проверяет ФОРМУ, а не
// календарь: `2026-13-99-x` он принимает, и это правильно — безопасным именем каталога такая
// строка быть не перестаёт, а проверка календаря к безопасности отношения не имеет.
const ID_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*$/;
const ID_MAX = 80;

// Порядок статусов — тот же, что в эталоне assets/stubs/STATE.md.
const STATUSES = [
  'exploring', 'planning', 'awaiting_approval', 'implementing',
  'reviewing', 'reworking', 'awaiting_acceptance', 'done', 'blocked',
];

// Потолок итераций ревью, контракт §3.2: без него связка «ревьюер придирается — исполнитель
// правит» крутится, пока не кончится контекст.
const REVIEW_LIMIT = 3;

// Тот же потолок для кругов аудита плана: «аудитор возражает — планировщик правит» крутится
// ровно так же. Считается на ВХОДЕ в awaiting_approval, см. cmdStatus().
const AUDIT_LIMIT = 3;

// Закрытый словарь типов вопроса человеку (§5.5). Свободного текста подкоманда `stop` не несёт
// именно поэтому — её место в permissions.allow.
const STOP_KINDS = ['product', 'technical', 'security'];

// Три класса риска по возрастанию. Порядок в массиве — и есть отношение «больше»:
// сравнение идёт по индексу, отдельной таблицы весов нет.
const CLASSES = ['cosmetic', 'standard', 'elevated'];

// Форма шага плана и маркер файлов в нём. Обе формы — часть контракта с планировщиком,
// он же записан в assets/stubs/PLAN.md и в промте planner.
const STEP_RE = /^\s*-\s*\[[ xX]\]\s*\*\*(\d+)\./;
const MARK_RE = /_Файлы?:_/;

// Правила пола по таблице §5.1 спецификации, см. floorFor().
const CODE_EXT = ['.py', '.mjs', '.js', '.ts', '.jsx', '.tsx', '.go', '.rs', '.java', '.php', '.rb', '.sql'];
const DATA_EXT = ['.yml', '.yaml', '.json', '.toml', '.ini', '.env', '.conf', '.sql'];
const RISKY_WORDS = ['config', 'conf', 'settings', 'template', 'schema', 'migrations', 'routes', 'auth', 'secrets'];
const TEST_DIR = /(^|\/)(tests?|__tests__|spec|specs|fixtures)\//;

// Сколько строк с чужим текстом печатать, прежде чем сказать «и ещё N». Ограничение ПЕЧАТИ,
// а не разбора: в разборе учитываются все пути до единого.
const PRINT_MAX = 10;

const PROFILE = path.join(KIT_DIR, 'PROJECT_PROFILE.md');

// Событие, которое уже заслужено записью на диск, но ещё не доехало до журнала: между
// `writeFileSync` и `emit(...)` есть код, и он может упасть. Выставляет `pend()` сразу после
// удавшейся записи, обнуляет `emit()` первым же действием, а из верхнеуровневого `catch`
// незаписанное досылает `flushPending()` с парой `crashed=yes`.
//
// Объявление стоит ЗДЕСЬ, выше точки входа, а не внизу рядом с `emit`: `let` на верхнем уровне
// модуля до своей строки лежит в мёртвой зоне, а команды выполняются из блока ниже — перенос
// объявления к остальному коду журнала дал бы ReferenceError на первой же команде.
let pending = null;

// --- точка входа ------------------------------------------------------------

// Позиционные аргументы — всё, что не начинается с `--`: так же, как в gate.mjs.
const argv = process.argv.slice(2);
const cmd = argv[0];
const args = argv.slice(1).filter((a) => !a.startsWith('--'));

try {
  if (cmd === 'new') cmdNew(args[0]);
  else if (cmd === 'status') cmdStatus(args);
  else if (cmd === 'log') cmdLog(args);
  else if (cmd === 'close') cmdClose();
  else if (cmd === 'list') cmdList();
  else if (cmd === 'path') cmdPath();
  else if (cmd === 'class') cmdClass();
  else if (cmd === 'stop') cmdStop(args);
  else usage();
} catch (e) {
  // Действие могло состояться, а событие — не доехать: между записью на диск и `emit(...)`
  // стоит код, и падает именно он. Досылаем незаписанное ДО `die`, потому что `die` уходит
  // через `process.exit(3)` и возврата из него нет. Собственный `try/catch` — чтобы падение
  // самого досыла не подменило собой исходное сообщение об ошибке, ради которого человек
  // сюда и смотрит.
  //
  // Отказы через `die()` (исчерпанный лимит ревью, неизвестный статус, испорченный ACTIVE)
  // событий не пишут и писать не должны: отказ — не падение, а запись о несостоявшемся
  // действии была бы враньём. Держится это механически, а не по договорённости: `die()`
  // уходит через `process.exit(3)` и сюда не попадает, а во всех точках отказа `pending`
  // ещё пуст — запись до них не дошла. Не «чините» это, добавляя событие в `die()`.
  try { flushPending(); } catch { /* журнал не повод потерять сообщение об ошибке */ }
  die(`внутренняя ошибка: ${e && e.message ? e.message : e}`);
}

// --- подкоманды -------------------------------------------------------------

/** Завести задачу: папка с формами, заполненный STATE.md, указатель ACTIVE. */
function cmdNew(rawTitle) {
  if (rawTitle === undefined) die('нужно название: node .claude/hooks/task.mjs new "<название>"');
  const title = clean(rawTitle);
  const base = `${today()}-${slug(title)}`;

  // Корень tasks/ создаётся ЗАРАНЕЕ и с recursive: его может не быть вовсе (свежий клон, где
  // не отрабатывал stubs.mjs), и первая же задача падала бы с ENOENT.
  mkdirSync(TASKS, { recursive: true });

  // А папка САМОЙ задачи создаётся БЕЗ recursive — и это не небрежность. Без него mkdir
  // падает с EEXIST на существующей папке, и именно этот отказ превращает гонку двух сессий
  // в безобидную коллизию имён (-2, -3). Верните сюда recursive: true — и вторая сессия молча
  // получит чужую папку и перезапишет чужой PLAN.md. Не «чинить» при первом ENOENT: ENOENT
  // лечится строкой выше, а не флагом здесь.
  let id = base;
  let dir = taskDir(id);
  if (!dir) die(`не смог собрать идентификатор из названия «${title}»`);
  for (let n = 1; ; n += 1) {
    try {
      mkdirSync(dir);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') die(`не смог создать папку задачи: ${e.message}`);
      if (n > 99) die('слишком много задач с таким названием за один день — назовите иначе');
      id = `${base}-${n + 1}`;
      dir = taskDir(id);
      if (!dir) die(`не смог подобрать свободный идентификатор для «${title}»`);
    }
  }

  // Про перехват указателя говорим вслух: незакрытая задача никуда не делась, но активной
  // стала новая, и человек должен заметить это сейчас, а не обнаружить потом.
  const prev = activeId();
  if (prev && prev !== id) {
    const fm = frontMatter(readOr(path.join(TASKS, prev, 'STATE.md'), ''));
    const status = fm ? clean(fm.get('status')) : '';
    if (!['done', 'blocked'].includes(status)) {
      say(`⚠ активной была ${prev}${status ? ` (${status})` : ''} — переключаю на ${id}`);
    }
  }
  const gate = readGate();
  if (gate && gate.task_id && gate.task_id !== id) {
    say(`⚠ гейт взведён на задачу ${clean(gate.task_id)} — приёмка считается по ней, пока её не перевзведут`);
  }

  placeStub('STATE.md', path.join(dir, 'STATE.md'), (src) => fillState(src, id, title));
  placeStub('PLAN.md', path.join(dir, 'PLAN.md'));
  placeStub('SECURITY.md', path.join(dir, 'SECURITY.md'));
  placeStub('REVIEW.md', path.join(dir, 'REVIEW.md'));
  placeStub('DONE.md', path.join(dir, 'DONE.md'));

  try {
    writeFileSync(ACTIVE, `${id}\n`, 'utf8');
    pend('task_opened', id, { title });   // указатель на диске — событие заслужено
  } catch (e) {
    say(`⚠ не смог записать указатель ACTIVE: ${e.message} — задача создана, но активной не стала`);
  }
  emit('task_opened', id, { title });
  say(`задача заведена: ${id}`);
  say(`папка: ${dir}`);
}

/** Сменить статус активной задачи. Ровно один аргумент и ровно из списка. */
function cmdStatus(list) {
  if (list.length !== 1) die(`нужен ровно один статус\nдопустимые: ${STATUSES.join(', ')}`);
  const value = list[0];
  if (!STATUSES.includes(value)) {
    die(`не знаю статус «${clean(value)}»\nдопустимые: ${STATUSES.join(', ')}`);
  }
  const { id, dir } = requireActive();
  const file = path.join(dir, 'STATE.md');
  // Читаем файл ОТДЕЛЬНО от правки: старое значение статуса нужно журналу событий, а
  // `editFront` его не возвращает — переход «из чего во что» иначе терялся бы.
  const src = readOr(file, '');
  const fm = frontMatter(src);
  const from = fm ? clean(fm.get('status')) : '';

  // Лимит итераций ревью держит КОД, а не текст промта. Раньше на этом месте стоял человек,
  // и заменять его абзацем в промте оркестратора значило бы не заменять вовсе: промт можно
  // не дочитать, а отказ команды не обойти. Поэтому механизм — отказ ДО какой-либо записи,
  // а печатная строка «итерация N из 3» ниже осталась диагностикой, и только.
  //
  // Счётчик растёт только на ВХОДЕ в статус (`from !== 'reworking'`): оркестратор, дёрнувший
  // команду дважды подряд, не теряет и не удваивает круг. И он не сбрасывается нигде — ни
  // возвратом в `reviewing`, ни закрытием задачи: он считает ВОЗВРАТЫ на доработку, а не
  // текущее состояние, и сброс превратил бы лимит в формальность — его обходили бы
  // переключением статусов туда-обратно. Единственный законный сброс — новая задача.
  //
  // У аудита плана счётчик СВОЙ и устроен так же (`audit_iterations`), но считает он ПОДАЧУ
  // плана на аудит, а не возврат: `grew = from !== 'awaiting_approval'`. Почему вход в статус,
  // а не переход `awaiting_approval → planning`: аудитор зовётся именно при этом статусе,
  // обойти его нельзя, а привязка к источнику перехода оставляла бы маршрут
  // `awaiting_approval → exploring → planning`, который не стоил бы ни одного круга.
  // Предусловие перехода в `awaiting_acceptance` — ДВЕРЬ, а не табличка, и проверяется оно
  // ДО `editFront()` и до любой записи. Разрешён вход только из `reviewing` и только при
  // `verdict: approved` в шапке `REVIEW.md` этой задачи. Не выполнено любое из двух — отказ
  // кодом 3, и не происходит НИЧЕГО: ни смены статуса, ни журнала, ни события, ни снятия взвода.
  //
  // Без обещаний, которых механизм не даёт. Предусловие отсекает переход из любого другого
  // статуса и при любом другом вердикте — и только это. Сам `REVIEW.md` правилами `deny`
  // не закрыт и закрыт быть не может: его ведёт ревьюер. Поэтому подделка вердикта остаётся
  // возможной, путь лишь дорожает на две операции; машинную приёмку она больше не снимает —
  // это держит условие `unverified` внутри `gate.mjs` (`modeDisarm`), — и видно в журнале
  // парами `gate_was` / `gate_verify`. Вариант «пустить, но взвод не снимать никогда» отклонён
  // человеком: он превращал снятие в декорацию.
  //
  // Повторный вызов из самого `awaiting_acceptance` тоже отказывает, и это законно: взвод
  // к этому моменту уже снят, повторять нечего.
  if (value === 'awaiting_acceptance') {
    const verdict = reviewVerdict(dir);
    if (from !== 'reviewing' || verdict !== 'approved') {
      die([
        'в awaiting_acceptance пускаю только из reviewing и только при verdict: approved',
        `  сейчас статус «${from || 'не разобран'}», вердикт в REVIEW.md «${verdict || 'не разобран'}»`,
        '  ничего не изменено: ни статус, ни взвод приёмки',
      ].join('\n'));
    }
  }

  const fields = { status: value, updated: stamp() };
  let grew = false;          // счётчик увеличился именно сейчас
  let iteration = null;      // номер итерации для вывода; null — статус без счётчика
  let counter = '';          // какой именно счётчик вырос — для строк человеку
  if (value === 'reworking') {
    const n = iters(fm, 'review_iterations');
    if (n === null) {
      die(`⚠ review_iterations в STATE.md не разобран («${clean(fm && fm.get('review_iterations'))}») — считаю лимит исчерпанным`);
    }
    grew = from !== 'reworking';
    if (grew && n + 1 > REVIEW_LIMIT) {
      die([
        `лимит итераций ревью исчерпан (${n} из ${REVIEW_LIMIT}): дальше`,
        '  node .claude/hooks/task.mjs status blocked, решает человек',
      ].join('\n'));
    }
    iteration = grew ? n + 1 : n;
    counter = 'итерация ревью';
    if (grew) fields.review_iterations = String(iteration);
  } else if (value === 'awaiting_approval') {
    const n = iters(fm, 'audit_iterations');
    if (n === null) {
      die(`⚠ audit_iterations в STATE.md не разобран («${clean(fm && fm.get('audit_iterations'))}») — считаю лимит исчерпанным`);
    }
    grew = from !== 'awaiting_approval';
    if (grew && n + 1 > AUDIT_LIMIT) {
      die([
        `лимит кругов аудита плана исчерпан (${n} из ${AUDIT_LIMIT}): дальше`,
        '  node .claude/hooks/task.mjs status blocked, решает человек',
      ].join('\n'));
    }
    iteration = grew ? n + 1 : n;
    counter = 'подача плана на аудит';
    if (grew) fields.audit_iterations = String(iteration);
  }

  const next = editFront(src, fields);
  if (!next) die(`в ${rel(file)} нет front-matter — статус записать некуда, ничего не меняю`);
  // Payload собирается ДО записи намеренно: между `writeFileSync` и `pend` не должно стоять
  // ничего, что умеет упасть, — иначе окно «действие состоялось, события нет» останется
  // открытым ровно там, где его и закрывают.
  const payload = { from, to: value };
  if (grew) payload.iteration = String(iteration);   // ключ только на переходе — новых событий не заводим
  writeFileSync(file, next, 'utf8');
  pend('status_changed', id, payload);               // статус на диске — событие заслужено
  journal(file, grew ? `статус → ${value} · ${counter} ${iteration}` : `статус → ${value}`);
  // Снятие взвода стоит ПОСЛЕ удавшейся записи и `pend(...)`, но ДО `emit(...)`: слово исхода
  // едет в том же событии `status_changed`, новых имён событий не заводим (§0.2 контракта).
  if (value === 'awaiting_acceptance') {
    const g = disarmGate(id);
    payload.gate = g.word;
    payload.gate_was = g.was;
    payload.gate_verify = g.verify;
    if (g.word !== 'disarmed' && g.word !== 'none') {
      say(`⚠ взвод НЕ снят — ${g.line}`);
      journal(file, `взвод НЕ снят: ${g.word}`);
    }
  }
  emit('status_changed', id, payload);
  const limit = value === 'reworking' ? REVIEW_LIMIT : AUDIT_LIMIT;
  say(iteration === null
    ? `${id}: статус ${value}`
    : `${id}: статус ${value} · ${counter} ${iteration} из ${limit}`);
}

/** Дописать строку в журнал активной задачи. Ручной инструмент — см. шапку файла. */
function cmdLog(list) {
  if (!list.length) die('нужна строка: node .claude/hooks/task.mjs log "<строка>"');
  const text = clean(list[0]);
  if (!text) die('строка пустая — записывать нечего');
  const { id, dir } = requireActive();
  journal(path.join(dir, 'STATE.md'), text);
  say(`${id}: записано в журнал`);
}

/**
 * Закрыть задачу: статус done и пустой указатель. Испорченный ACTIVE — отказ, а не «починка».
 *
 * Штатный вход сюда — из `awaiting_acceptance`: работа закончена, `DONE.md` написан, и человек
 * принял результат. Требованием это не сделано намеренно: `close` остаётся способом закрыть
 * задачу из любого состояния (передумали, задача отменена, память до 1.17 без нового статуса).
 */
function cmdClose() {
  const { id, dir } = requireActive();
  const file = path.join(dir, 'STATE.md');
  // То же чтение, что в cmdStatus, плюс `created`: полное время жизни задачи считается
  // только здесь и только один раз. Не разобралось (старая задача из миграции, чужой
  // формат) — поля просто не будет, ноль вместо факта не выдумываем.
  const src = readOr(file, '');
  const fm = frontMatter(src);
  const from = fm ? clean(fm.get('status')) : '';
  const started = fm ? parseStamp(fm.get('created')) : null;
  const next = editFront(src, { status: 'done', updated: stamp() });
  if (!next) die(`в ${rel(file)} нет front-matter — закрывать нечего, ничего не меняю`);
  // Как в cmdStatus: payload собран до записи, чтобы `pend` стоял к ней вплотную.
  const payload = {
    from,
    duration_min: started ? Math.max(0, Math.round((Date.now() - started) / 60000)) : '',
  };
  writeFileSync(file, next, 'utf8');
  pend('task_closed', id, payload);   // статус done на диске — событие заслужено
  journal(file, 'задача закрыта');
  emit('task_closed', id, payload);
  try {
    writeFileSync(ACTIVE, '\n', 'utf8');
  } catch (e) {
    say(`⚠ не смог очистить указатель ACTIVE: ${e.message}`);
  }
  say(`${id}: закрыта, активной задачи больше нет`);
  // Гейт переживает закрытие задачи намеренно — молчать об этом нельзя.
  // Условие «состояние есть и оно не verified», а не «implementing»: blocked (три неудачи
  // или подмена набора проверок) — как раз то состояние, где человек нужен обязательно,
  // и промолчать о нём было бы хуже всего.
  // Рецепт снятия печатаем только живому терминалу: `task.mjs close` лежит в allow
  // (settings.json), выполняется без вопроса, и его stdout попадает прямо в контекст модели.
  // Та же дисциплина, что в gate.mjs (--selftest, строки 215–226).
  try {
    const g = readGate();
    const gs = g ? clean(g.status) : '';
    if (g && clean(g.task_id) === id && gs && gs !== 'verified') {
      say(`⚠ гейт остался на задаче ${id}, состояние «${gs}» — приёмка не пройдена`);
      if (process.stdin.isTTY) {
        say('  снимаете взвод здесь вы: node .claude/hooks/gate.mjs --disarm');
        say('  зелёный прогон приёмки снимает взвод сам');
      } else {
        say('  как снять — .claude/CUSTOMIZE.md, раздел «Машинная приёмка»');
      }
    }
  } catch { /* подсказка best-effort: ломать закрытие задачи она не имеет права */ }
}

/** Список задач. Что считается задачей — правило Р11, см. taskDir() + hasState(). */
function cmdList() {
  const active = activeId();
  const gate = readGate();
  let entries;
  try {
    entries = readdirSync(TASKS, { withFileTypes: true });
  } catch {
    say('папки .claude/tasks/ ещё нет — задач пока нет');
    return;
  }

  const rows = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = taskDir(e.name);
    if (!dir || !hasState(dir)) continue;   // Р11: всё прочее пропускается молча
    const fm = frontMatter(readOr(path.join(dir, 'STATE.md'), ''));
    if (!fm) { say(`${e.name}: STATE.md не разобрал — пропускаю`); continue; }
    rows.push({
      id: e.name,
      date: e.name.slice(0, 10),
      // Заголовок мог приехать миграцией из чужого markdown, поэтому чистим и на выводе тоже.
      title: clean(fm.get('title')) || '(без названия)',
      status: clean(fm.get('status')).slice(0, 20) || '?',
      iters: iters(fm, 'review_iterations'),
    });
  }
  if (!rows.length) { say('задач пока нет'); return; }

  rows.sort((a, b) => (a.id < b.id ? 1 : -1));   // новые сверху: id начинается с даты
  const wId = Math.max(...rows.map((r) => r.id.length));
  const wStatus = Math.max(...rows.map((r) => r.status.length));
  say(`задач: ${rows.length}`);
  const gateStopped = gate && clean(gate.status) === 'blocked';
  let unparsed = false;
  for (const r of rows) {
    const mark = r.id === active ? '→' : ' ';
    // Итерации ревью показываем, только когда они были: «0/3» у каждой свежей задачи — шум.
    // Неразобранное значение отмечаем вопросом, а объясняем ОДНОЙ строкой после таблицы:
    // шуметь предупреждением на каждой строке списка ни к чему.
    let iters = '';
    if (r.iters === null) { iters = '  · ревью: ?'; unparsed = true; }
    else if (r.iters > 0) iters = `  · ревью: ${r.iters}/${REVIEW_LIMIT}`;
    // Приёмка — из GATE_STATE.json и только при совпадении task_id: проверки гоняются по всему
    // рабочему дереву, и приписать чужой вердикт соседней задаче было бы прямой ложью.
    let verdict = '';
    if (gate && gate.task_id === r.id) {
      const where = `по дереву на ${clean(gate.armed_at) || '?'}`;
      verdict = gateStopped
        ? `  · приёмка: остановлена (${clean(gate.verify) || 'нет'}) — ${where}`
        : `  · приёмка: ${clean(gate.verify) || 'нет'} (${where})`;
    }
    out(`  ${mark} ${r.id.padEnd(wId)}  ${r.date}  ${r.status.padEnd(wStatus)}  ${r.title}${iters}${verdict}`);
  }
  if (unparsed) {
    say('⚠ у задач с «ревью: ?» поле review_iterations в STATE.md не разобрано — status reworking по ним откажет');
  }

  // Памятка про два разных «blocked». Слово одно, смыслов два, и стоят они рядом в одном
  // выводе — перепутать их проще всего именно здесь.
  if (gateStopped || rows.some((r) => r.status === 'blocked')) {
    say('`blocked` у задачи и «приёмка остановлена» — разное: первое про итерации ревью, второе про красные прогоны проверок');
  }

  // Расхождение показываем строкой, а не пустой ячейкой: пустая ячейка читается как
  // «приёмки не было», хотя гейт в это время следит за другой задачей.
  if (gate && gate.task_id && gate.task_id !== active) {
    say(`⚠ гейт взведён на задачу ${clean(gate.task_id)}, а активная — ${active || 'нет'}: приёмка считается по гейту`);
  } else if (gate && !gate.task_id) {
    say('⚠ гейт взведён без id задачи (взводили руками или до перехода на tasks/) — с задачами его не сопоставляю');
  }
}

/** Только путь и ничего кроме: команду зовут как `$(task.mjs path)`. */
function cmdPath() {
  const { dir } = requireActive();
  out(dir);
}

/**
 * Класс риска задачи: `PLAN.md` → поле `class` в `STATE.md`. Аргументов нет вовсе — команда
 * не несёт свободного текста и поэтому может лежать в `permissions.allow`.
 *
 * Итог = БОЛЬШИЙ из двух: объявленного планировщиком в разделе `## Класс риска` и машинного
 * пола по путям, которые план трогает. Понизить объявленное значение планировщик не может —
 * в этом весь смысл: самооценка страхуется полом.
 *
 * ЧТО СЧИТАЕТСЯ ОГРАЖДЁННЫМ БЛОКОМ. Маска — `fenceMask()` в `md-fence.mjs`, общая
 * с проверкой именных ссылок на код; правила ниже — несущая деталь разбора. Открывающий
 * токен — строка, где после НЕ БОЛЕЕ ТРЁХ ведущих пробелов идут три и более подряд символа
 * ``` либо три и более `~`; остаток строки (info string) игнорируется. Закрывающий — строка
 * с тем же символом, длиной НЕ МЕНЬШЕ открывающего, после не более трёх пробелов и без другого
 * текста. Вложенности нет: пока блок открыт, всё, кроме подходящего закрывающего токена, —
 * содержимое (поэтому ````markdown тройкой кавычек не закрывается). Фенс с отступом четыре
 * пробела и больше ограждённым блоком НЕ считается, и направление ошибки выбрано осознанно:
 * лишний разобранный текст поднимает пол и печатает замечание, а «умный» разбор отступов дал бы
 * способ спрятать шаг отступом.
 *
 * ПОЧЕМУ РАЗБОР СВОЙ, а не `filesFromPlan()` из `map.mjs`. У карты и у пола разные цели: карта
 * показывает человеку до двенадцати путей (`.slice(0, 12)` там законен), а пол обязан увидеть
 * ВСЕ. Функции ссылаются друг на друга по имени в докблоках; расхождение форм плана ищется
 * grep-ом по именам `analysePlan()` в `task.mjs` и `filesFromPlan()` в `map.mjs`.
 *
 * FAIL-CLOSED. Ноль распознанных путей → пол не ниже `standard`, и `cosmetic` не выдаётся
 * НИКОГДА: непонятый план — это не безопасный план. Ноль путей И неразобранный объявленный
 * класс → отказ кодом 3 до какой-либо записи, поле `class` остаётся `-`. Сюда же общее
 * правило учёта: ЛЮБОЕ расхождение между увиденным и разобранным — замечание, а любое
 * замечание поднимает пол до `standard`; путь, увиденный вне шага, поднимает пол до своего
 * класса. Семь видов расхождений перечислены в докблоке `analysePlan`.
 *
 * Пути остаются СТРОКАМИ: ни `existsSync`, ни чтения, ни запуска — иначе `../` и управляющие
 * символы из чужого текста получают смысл. Печать — через `clean()` и не более десяти строк.
 *
 * События в `events.jsonl` эта команда не пишет: класс — состояние, а не переход, а заводить
 * имя события без пишущего кода запрещено §0.2 контракта.
 */
function cmdClass() {
  const { id, dir } = requireActive();
  const file = path.join(dir, 'PLAN.md');
  const src = readOr(file, '');
  if (!clean(src)) die(`в ${rel(file)} плана нет (файла нет или он пуст) — класс считать не по чему`);

  const r = analysePlan(src);
  const acl = aclPrefixes();
  for (const line of acl.notes) say(`форма плана: ${line}`);

  // Пол по путям. У каждого поднявшего запоминается ИМЯ сработавшего правила — без него
  // строка «пол elevated» не проверяется и не оспаривается.
  let floor = 'cosmetic';
  const raised = [];
  for (const p of r.paths) {
    const hit = floorFor(p.path, acl.tokens);
    if (hit.cls === 'cosmetic') continue;
    raised.push({ where: `шаг ${clean(String(p.step))}`, path: p.path, ...hit });
    floor = maxClass(floor, hit.cls);
  }

  const notes = r.notes.slice();
  if (!r.paths.length) notes.push('путей не распознано ни одного — пол принудительно не ниже standard');
  // Любое замечание формы поднимает пол: непонятый план косметическим не бывает.
  if (notes.length) floor = maxClass(floor, 'standard');

  // Седьмое расхождение из докблока `analysePlan`: путь, который разбор увидел, но к шагу
  // не отнёс. Поднимает пол и становится замечанием, если его класс ВЫШЕ уже посчитанного, —
  // ошибка разбора идёт в дорогую сторону, а не в дешёвую. Сравнение с полом, уже поднятым
  // замечаниями, намеренно: пол, поднятый выше, второй раз тем же поводом не поднимается.
  const outside = [];
  for (const s of r.strays) {
    const hit = floorFor(s.path, acl.tokens);
    if (maxClass(floor, hit.cls) === floor) continue;
    outside.push({ line: s.line, where: `строка ${s.line}, вне шага`, path: s.path, ...hit });
  }
  for (const s of outside) floor = maxClass(floor, s.cls);
  if (outside.length) {
    raised.push(...outside);
    notes.push(`путей вне шагов, поднимающих пол: ${outside.length} (строки ${listCut(outside.map((s) => s.line))}) — разбор их увидел, но к шагу не отнёс`);
  }

  if (!r.paths.length && !r.declared) {
    for (const line of notes) say(`форма плана: ${line}`);
    die([
      'в плане не разобрано ни одного пути и не разобран раздел «Класс риска» —',
      `  класс не записан, поле class осталось прежним. Правит план ${rel(file)} планировщик`,
    ].join('\n'));
  }

  const result = maxClass(r.declared || 'cosmetic', floor);

  const next = editFront(readOr(path.join(dir, 'STATE.md'), ''), { class: result });
  if (!next) die(`в ${rel(path.join(dir, 'STATE.md'))} нет front-matter — класс записать некуда, ничего не меняю`);
  writeFileSync(path.join(dir, 'STATE.md'), next, 'utf8');
  journal(path.join(dir, 'STATE.md'), `класс риска → ${result} (объявлено ${r.declared || 'нет'}, пол ${floor})`);

  say(`${id}: класс ${result}`);
  say(`объявлено: ${r.declared || 'не разобрано'} · пол по путям: ${floor} · итог: ${result}`);
  say(`учтено путей: ${r.paths.length}`);
  if (raised.length) {
    say('пол подняли:');
    for (const p of raised.slice(0, PRINT_MAX)) {
      say(`  ${p.where}: ${clean(p.path)} → ${p.cls} (${p.rule})`);
    }
    if (raised.length > PRINT_MAX) say(`  и ещё ${raised.length - PRINT_MAX}`);
  }
  say(`форма плана: шагов ${r.steps.length}, с маркером ${r.withMarker}, путей ${r.paths.length}`);
  for (const line of notes) say(`форма плана: ${line}`);
  say(`форма плана: замечаний ${notes.length}`);
}

/**
 * Тип вопроса человеку перед `[СТОП]`: `product` / `technical` / `security`, и ничего кроме.
 * Ровно один аргумент из закрытого словаря — свободного текста подкоманда не несёт, поэтому
 * её место в `permissions.allow`, а сам вопрос человеку задаёт оркестратор словами в чате.
 */
function cmdStop(list) {
  if (list.length !== 1) die(`нужен ровно один тип: ${STOP_KINDS.join(', ')}`);
  const kind = list[0];
  if (!STOP_KINDS.includes(kind)) {
    die(`не знаю тип стопа «${clean(kind)}»\nдопустимые: ${STOP_KINDS.join(', ')}`);
  }
  const { id, dir } = requireActive();
  const file = path.join(dir, 'STATE.md');
  const next = editFront(readOr(file, ''), { stop_kind: kind, updated: stamp() });
  if (!next) die(`в ${rel(file)} нет front-matter — тип стопа записать некуда, ничего не меняю`);
  writeFileSync(file, next, 'utf8');
  journal(file, `стоп: ${kind}`);
  say(`${id}: стоп типа ${kind}`);
}

function usage() {
  die([
    'подкоманды:',
    '  new "<название>"   завести задачу и сделать её активной',
    `  status <статус>    ${STATUSES.join(', ')}`,
    '  log "<строка>"     дописать строку в журнал',
    '  close              закрыть задачу и снять указатель',
    '  list               все задачи',
    '  path               абсолютный путь активной задачи',
    '  class              класс риска по PLAN.md → поле class в STATE.md',
    `  stop <тип>         тип вопроса человеку: ${STOP_KINDS.join(', ')}`,
  ].join('\n'));
}

// --- приёмка ----------------------------------------------------------------

/**
 * Вердикт из шапки `REVIEW.md` задачи. Читается тем же `frontMatter()`, что и `STATE.md`:
 * блок обязан начинаться первой строкой файла, `verdict:` ниже закрывающего `---` управляющей
 * логикой игнорируется. Нет файла, нет шапки, нет поля — пустая строка, и вызывающий отказывает.
 *
 * Задача с ревью, но без шапки (память до 1.15, ручная правка) в `awaiting_acceptance` не
 * пройдёт, и это законный отказ: строка называет прочитанный вердикт, человек дописывает шапку
 * либо закрывает задачу через `close`.
 */
function reviewVerdict(dir) {
  const fm = frontMatter(readOr(path.join(dir, 'REVIEW.md'), ''));
  return fm ? clean(fm.get('verdict')) : '';
}

/**
 * Снять взвод гейта от имени задачи. Возвращает `{ word, was, verify, line }`, где `word` —
 * слово из ЗАКРЫТОГО словаря: `disarmed`, `none`, `no_task_id`, `foreign`, `blocked`,
 * `unverified`, `disarm_failed`.
 *
 * Отдельным процессом, а не импортом — ровно тем же приёмом, каким `emit()` зовёт
 * `events.mjs`: статический импорт ESM нельзя обернуть в `try/catch`, и сломанный `gate.mjs`
 * отнял бы у человека смену статуса. `permissions.allow` для этого не нужен: это не вызов
 * инструмента `Bash`, а дочерний процесс Node. `gate.mjs --disarm` в `allow` не добавляется,
 * и ключ `--if-task` этого не меняет.
 *
 * ДОКЛАД О ФАКТЕ, А НЕ О НАМЕРЕНИИ. Решение принимает `gate.mjs` (`modeDisarm`), здесь только
 * называется исход:
 *   • предчтение нужно ТОЛЬКО ради строки человеку и payload (`gate_was`, `gate_verify`):
 *     после удаления файла их восстановить неоткуда. При расхождении верны код возврата
 *     дочернего процесса и повторное чтение, а не предчтение;
 *   • наличие взвода — по `existsSync`, а не по успеху разбора: `readGate()` возвращает `null`
 *     и на отсутствующем файле, и на битом JSON, и доклад `none` про лежащий на диске взвод
 *     был бы неправдой. Файл есть, а JSON не читается — это `disarm_failed`;
 *   • после вызова состояние ПЕРЕЧИТЫВАЕТСЯ: файла нет → `disarmed`; файл на месте и код 3 →
 *     слово выбирается по предчтению в ТОМ ЖЕ ПОРЯДКЕ, что проверки в `modeDisarm()`;
 *     предчтение отказ не объясняет (состояние сменилось между чтениями) → `disarm_failed`;
 *     файл на месте и код не 3 → `disarm_failed`.
 */
function disarmGate(id) {
  const none = { word: 'none', was: '', verify: '', line: '' };
  if (!existsSync(GATE_STATE)) return none;   // взвода нет — дочерний процесс не запускается

  const pre = readGate();
  const was = pre ? clean(pre.status) : '';
  const verify = pre ? clean(pre.verify) : '';
  const done = (word, line) => ({ word, was, verify, line });

  let code = null;
  try {
    if (!existsSync(GATE_MJS)) return done('disarm_failed', `нет ${rel(GATE_MJS)} — снимать нечем`);
    const r = spawnSync(process.execPath, [GATE_MJS, '--disarm', '--if-task', id], {
      cwd: PROJECT_ROOT, timeout: 10000, stdio: 'ignore',
    });
    code = r.status;
  } catch (e) {
    return done('disarm_failed', `не удалось запустить снятие взвода: ${e && e.message ? e.message : e}`);
  }

  if (!existsSync(GATE_STATE)) return { word: 'disarmed', was, verify, line: '' };

  const hint = 'снимает человек из терминала: node .claude/hooks/gate.mjs --disarm';
  if (code === 3) {
    if (!pre) return done('disarm_failed', `состояние приёмки не читается (битый JSON) — ${hint}`);
    const owner = clean(pre.task_id);
    if (!owner) return done('no_task_id', `взвод ничей (task_id пуст) — ${hint}`);
    if (owner !== id) return done('foreign', `взвод стоит на другой задаче (${owner}) — ${hint}`);
    if (was === 'blocked') return done('blocked', `приёмка остановлена (blocked) — ${hint}`);
    if (was !== 'verified' && verify !== 'none') {
      return done('unverified', `приёмка не пройдена (статус ${was || 'нет'}, приёмка ${verify || 'нет'}, попыток ${clean(String(pre.attempts ?? '?'))}) — почини проверки или ${hint}`);
    }
    return done('disarm_failed', `состояние приёмки изменилось между чтениями — ${hint}`);
  }
  return done('disarm_failed', `снятие не удалось (код ${clean(String(code))}) — ${hint}`);
}

// --- класс риска ------------------------------------------------------------

/**
 * Разбор плана: шаги, пути, объявленный класс, замечания формы. Возвращает
 * `{ paths, strays, steps, withMarker, declared, notes }` и НИЧЕГО не пишет.
 *
 * УЧЁТ РАЗБОРА: «увидено» против «разобрано». Правило общее В ПРЕДЕЛАХ ТОГО, ЧТО РАЗБОР
 * ВИДИТ (граница видимости — отдельным разделом ниже, и она не гарантия, а принятый риск):
 * всё, что разбор УВИДЕЛ, но не сумел отнести к шагу, обязано удорожать класс, а не
 * удешевлять его. Предохранитель находили открытым трижды — обрезка `.slice(0, 12)`, шаги
 * внутри ограждённых блоков, шаг без маркера вместе с путём на строке-продолжении, — поэтому
 * здесь сравниваются СЧЁТЧИКИ, а не проверяется отдельно взятый способ спрятать путь.
 * Расхождением считается каждое из семи:
 *
 *   1. строк, похожих на шаг, по всему файлу больше, чем разобрано (шаг внутри фенса);
 *   2. разобранных шагов больше, чем шагов с маркером `_Файл:_` / `_Файлы:_`;
 *   3. шагов с маркером больше, чем шагов, у которых после маркера нашёлся путь;
 *   4. токен после маркера не проходит по печатаемому ASCII (омоглиф);
 *   5. номера шагов не дают 1…N подряд — пропуск, повтор или номер вне диапазона;
 *   6. ограждённый блок открыт и не закрыт — хвост файла не разобран;
 *   7. путь разобран ВНЕ шага: на строке-продолжении, до маркера, в прозе или в хвосте
 *      файла после последнего шага (поле `strays`).
 *
 * Первые шесть — замечания формы, и любое из них поднимает пол до `standard` (см. `cmdClass`).
 * Седьмое считается там же и по своему правилу: путь вне шага поднимает пол, ЕСЛИ его класс
 * выше уже посчитанного, и тогда же становится замечанием. Условие «выше» — не поблажка,
 * а условие существования косметической ветки: план, честно трогающий только `.md`, называет
 * свои же пути в прозе, и без условия `cosmetic` не выдавался бы никогда.
 *
 * ЧТО РАЗБОР ВИДИТ, А ЧЕГО НЕ ВИДИТ ВОВСЕ. Путь опознаётся только в ОГРАЖДЁННЫХ РАЗМЕТКОЙ
 * формах, их две: токен в обратных кавычках и адрес markdown-ссылки `](путь)` — см.
 * `delimited()` ниже. Обе разделены синтаксисом, а не догадкой, и потому разбираются
 * одинаково: и в шаге, и вне шага. Всё остальное разбор НЕ ВИДИТ, и счётчики «увидено
 * против разобрано» про это ничего не знают — голый путь в прозе (`Заодно правим
 * db/migrations/009.sql` без кавычек), адрес ссылки-сноски вида `[метка]: путь`, `<a href>`,
 * путь, разрезанный на два токена. ЭТО ПРИНЯТЫЙ РИСК, а не недосмотр: разбирать любой
 * похожий на путь токен в свободном тексте — шум, а пол, срабатывающий на всём подряд,
 * отключат руками. Цена риска называется прямо: план, который называет опасный файл ТОЛЬКО
 * в невидимой форме, получит `cosmetic`, а с ним пропуск аудита и первого `[СТОП]`.
 * Прикрыто это не разбором, а требованием формы в промте планировщика (`planner.md`)
 * и тем, что класс планировщик объявляет сам.
 *
 * ЧЕГО ЗДЕСЬ НЕТ НАМЕРЕННО. «Хвост файла после последнего шага» сам по себе расхождением
 * не считается: после шагов в плане законно идут «Что НЕ входит», «Риски», «Контрольные
 * точки» и «Класс риска». Хвост закрыт пунктом 7 — опасный путь в нём поднимает пол и назван
 * вслух. Не-ASCII токен ВНЕ шага замечанием тоже не считается: в прозе плана русский текст
 * в обратных кавычках — норма, и правило утопило бы полезный сигнал в шуме.
 *
 * Про непрерывность номеров и про счётчик строк шагов — честно, без обещаний, которых
 * механизм не даёт. Непрерывность 1…N ловит ПРОПУСК В СЕРЕДИНЕ и ПОВТОР. Обрезку с ХВОСТА
 * она поймать не может математически: оставшиеся 1…N−k — такая же безупречная
 * последовательность, и ограждённый блок, открытый после шага M и закрытый перед концом
 * файла, унёс бы хвост молча. Поэтому рядом стоит второй, независимый от разбора фенсов
 * счётчик: строки, похожие на шаг, считаются ПО ВСЕМУ ФАЙЛУ, включая ограждённые блоки,
 * и сравниваются с числом разобранных. Расходятся — замечание. Инвариант законен, потому что
 * форма плана требует не держать в примерах строк вида `- [ ] **N.**` (см. assets/stubs/PLAN.md).
 * На намеренно искалеченную форму пол не рассчитан и рассчитан быть не может — это записано
 * и в промте планировщика, и в разделе рисков плана фазы 5.
 */
function analysePlan(src) {
  const lines = String(src).split(/\r?\n/);
  const { inside, unclosedFrom } = fenceMask(lines);
  const notes = [];
  const paths = [];
  const strays = [];
  const steps = [];
  const noPath = [];
  const noMarker = [];
  const nonAscii = [];
  let withMarker = 0;
  let allStepLines = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = line.match(STEP_RE);
    if (m) allStepLines += 1;          // считаем ВЕЗДЕ, включая фенсы: см. докблок
    if (inside[i]) continue;
    // Не шаг — по этой строке разбор путей не ведётся, значит всё найденное на ней идёт
    // в `strays`. Так же поступаем с шагом без маркера и с началом строки шага до маркера:
    // «не разобрано» обязано быть учтено отдельно, а не пропущено молча.
    if (!m) { strayPaths(line, i + 1, strays); continue; }
    const num = Number(m[1]);
    steps.push(num);
    const mark = line.match(MARK_RE);
    if (!mark) { noMarker.push(num); strayPaths(line, i + 1, strays); continue; }
    withMarker += 1;
    const cut = mark.index + mark[0].length;
    strayPaths(line.slice(0, cut), i + 1, strays);
    let found = 0;
    let bad = false;
    for (const raw of delimited(line.slice(cut))) {
      const tok = pathToken(raw);
      if (tok.kind === 'nonascii') { bad = true; continue; }
      if (tok.kind !== 'path') continue;
      paths.push({ step: num, path: tok.value });
      found += 1;
    }
    if (bad) nonAscii.push(num);
    if (!found) noPath.push(num);
  }

  if (unclosedFrom !== null) {
    notes.push(`хвост плана не разобран: незакрытый ограждённый блок со строки ${unclosedFrom}`);
  }
  // Числовой баланс разбора. Ровно эти числа печатает строка «форма плана: шагов N,
  // с маркером M, путей K» — теперь они не только печатаются, но и решают: каждое
  // расхождение становится замечанием, а замечание поднимает пол (см. `cmdClass`).
  if (allStepLines !== steps.length) {
    notes.push(`строк шагов в файле ${allStepLines}, разобрано ${steps.length} — часть шагов внутри ограждённых блоков`);
  }
  if (noMarker.length) {
    notes.push(`шагов ${steps.length}, с маркером _Файл:_/_Файлы:_ ${withMarker} — без маркера: ${listCut(noMarker)}`);
  }
  const gaps = numbering(steps);
  if (gaps) notes.push(gaps);
  if (noPath.length) notes.push(`маркер есть, а пути не распознано у шагов: ${listCut(noPath)}`);
  if (nonAscii.length) notes.push(`не-ASCII в токене пути у шагов: ${listCut(nonAscii)} — токен нераспознан`);

  const declared = declaredClass(lines, inside, notes);
  return { paths, strays, steps, withMarker, declared, notes };
}

/**
 * Токены, ограждённые разметкой, — единственный вход разбора путей. Форм ровно две, и обе
 * заданы синтаксисом, а не догадкой: содержимое обратных кавычек и адрес markdown-ссылки
 * `](путь)`. Вторая добавлена потому, что «правим [права доступа](.claude/settings.json)» —
 * форма, которую планировщик пишет естественно, а пол её не видел и выдавал `cosmetic`
 * на плане, трогающем `settings.json`. Что за этими двумя формами разбор не видит вовсе —
 * записано в докблоке `analysePlan()` разделом «ЧТО РАЗБОР ВИДИТ».
 *
 * Ошибка разбора здесь идёт в дорогую сторону: лишний увиденный путь поднимает пол
 * и печатает замечание, пропущенный — молча удешевляет задачу.
 */
function delimited(text) {
  const out = [];
  for (const t of String(text).matchAll(/`([^`]*)`/g)) out.push(t[1]);
  for (const t of String(text).matchAll(/\]\(([^)]*)\)/g)) {
    const dest = linkTarget(t[1]);
    if (dest) out.push(dest);
  }
  return out;
}

/**
 * Адрес markdown-ссылки как кандидат в пути. Схема (`https:`, `mailto:`) и якорь (`#раздел`)
 * путями не являются: без этого отсева ссылка на страницу с `.js` в адресе поднимала бы пол,
 * а кириллический якорь читался бы как не-ASCII токен и давал замечание на ровном месте.
 * Заголовок ссылки после пробела и угловые скобки — оформление, а не путь.
 */
function linkTarget(raw) {
  let dest = String(raw).trim().split(/\s+/)[0];
  if (dest.startsWith('<')) dest = dest.slice(1);
  if (dest.endsWith('>')) dest = dest.slice(0, -1);
  dest = dest.split('#')[0];
  if (!dest || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(dest)) return '';
  return dest;
}

/**
 * Классификатор ограждённого разметкой токена — ОДИН на весь разбор: и для путей шага, и для
 * учёта того, что разбор увидел вне шага, и для обеих форм ограждения (обратные кавычки,
 * адрес markdown-ссылки). Общий классификатор здесь не украшение: «увидено» и «разобрано»
 * сравнимы только тогда, когда считаны одной меркой.
 *
 * Обрамляющие пробелы снимаются: токен с ведущим пробелом глазом неотличим от обычного пути,
 * а раньше уходил в «текст в кавычках», то есть был способом спрятать путь от пола. Пробел
 * ВНУТРИ по-прежнему означает фразу, а не путь.
 */
function pathToken(raw) {
  const tok = String(raw).trim();
  if (!tok || /\s/.test(tok)) return { kind: 'text' };        // текст в кавычках, а не путь
  if (!/^[\x20-\x7E]+$/.test(tok)) return { kind: 'nonascii' };
  if (!tok.includes('/') && !tok.includes('.')) return { kind: 'text' };  // имя функции или слово
  const value = tok.split('\\').join('/').replace(/^\.\//, '').replace(/\*+$/, '');
  return value ? { kind: 'path', value } : { kind: 'text' };
}

/**
 * Пути из текста, который разбор шага НЕ разбирал: строка-продолжение, начало строки шага
 * до маркера, проза, хвост файла. Седьмое расхождение из докблока `analysePlan`; решение,
 * что с ними делать, принимает `cmdClass`, здесь только сбор. Не-ASCII тут не отмечается —
 * причина в том же докблоке.
 */
function strayPaths(text, lineNo, out) {
  for (const raw of delimited(text)) {
    const tok = pathToken(raw);
    if (tok.kind === 'path') out.push({ line: lineNo, path: tok.value });
  }
}

/** Список чисел с тем же потолком печати, что у путей: PRINT_MAX и «и ещё N». */
function listCut(items) {
  const head = items.slice(0, PRINT_MAX).join(', ');
  return items.length > PRINT_MAX ? `${head} и ещё ${items.length - PRINT_MAX}` : head;
}

/**
 * Номера разобранных шагов обязаны дать ровно 1, 2, … N — без пропусков и без повторов,
 * и первый обязан быть 1. Проверка машинная и от аккуратности разбора не зависит: дырка
 * в нумерации видна без всякого понимания текста. Что она НЕ ловит — обрезку с хвоста;
 * это закрывает счётчик строк шагов в `analysePlan()`.
 *
 * ПОТОЛОК. Диапазон перебора задаёт ЧИСЛО РАЗОБРАННЫХ ШАГОВ, а не число, написанное в плане.
 * Иначе шаг `**20000000.**` означал двадцать миллионов итераций и 189 МБ одной строкой
 * в stdout хука (то есть прямо в контекст оркестратора), а `**900000000.**` — падение
 * `Invalid array length`. Номер вне диапазона 1…N — сам по себе расхождение и печатается
 * отдельным списком; печать каждого списка обрезается по `PRINT_MAX`, как печать путей.
 * Это та же дисциплина потолков, что и в остальном разборе: чужой текст не управляет
 * ни объёмом работы, ни объёмом вывода.
 */
function numbering(steps) {
  if (!steps.length) return 'ни одной строки шага не разобрано';
  const seen = new Set();
  const dup = [];
  for (const n of steps) {
    if (seen.has(n)) dup.push(n);
    seen.add(n);
  }
  const top = steps.length;
  const miss = [];
  for (let n = 1; n <= top; n += 1) if (!seen.has(n)) miss.push(n);
  const over = [...seen].filter((n) => !(n >= 1 && n <= top)).sort((a, b) => a - b);
  if (!dup.length && !miss.length && !over.length) return '';
  const parts = [];
  if (miss.length) parts.push(`пропущены ${listCut(miss)}`);
  if (dup.length) parts.push(`повторены ${listCut(dup)}`);
  if (over.length) parts.push(`вне диапазона ${listCut(over.map((n) => clean(String(n))))}`);
  return `номера шагов идут не подряд 1…${top}: ${parts.join('; ')}`;
}

/**
 * Объявленный класс: заголовок `## Класс риска` ЯКОРЕМ на начало строки и вне ограждённых
 * блоков, по ВСЕМ вхождениям; в каждом — первый токен в обратных кавычках до следующего
 * `## `. Принимается только одно из трёх слов, итог — максимум валидных.
 *
 * Умолчания `cosmetic` здесь нет и не будет ни при каких условиях: раздела нет или токен
 * не из трёх — это замечание и отсутствие объявленного класса, а не «задача косметическая».
 */
function declaredClass(lines, inside, notes) {
  let best = '';
  let seen = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (inside[i] || !/^##\s+Класс риска\s*$/.test(lines[i])) continue;
    seen += 1;
    let token = '';
    for (let j = i + 1; j < lines.length && !/^##\s/.test(lines[j]); j += 1) {
      if (inside[j]) continue;
      const t = lines[j].match(/`([^`]*)`/);
      if (t) { token = t[1].trim(); break; }
    }
    if (CLASSES.includes(token)) best = maxClass(best || 'cosmetic', token);
    else if (!token) notes.push('раздел «Класс риска» есть, но значения в нём нет — после заголовка нет ни одного токена в обратных кавычках');
    else notes.push(`раздел «Класс риска» есть, но значение не разобрано («${clean(token)}»)`);
  }
  if (!seen) notes.push('раздела «Класс риска» в плане нет — объявленного класса не будет');
  return best;
}

/**
 * Правила пола по таблице §5.1 спецификации. Возвращает `{ cls, rule }`: класс и ИМЯ
 * сработавшего правила — имя печатается рядом с путём, иначе строку «пол elevated» нечем
 * ни проверить, ни оспорить.
 *
 * Порядок проверок — от предметных правил к правилу по §5 профиля: оба дают `elevated`,
 * но предметное объясняет причину само по себе и не зависит от того, что человек написал
 * в профиле.
 */
function floorFor(p, aclTokens) {
  const low = p.toLowerCase();
  const base = low.slice(low.lastIndexOf('/') + 1);
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.')) : '';
  if (/(^|\/)migrations?(\/|$)/.test(low) || base === '.env' || base.startsWith('.env.')
    || base === 'settings.json' || ['.pem', '.key', '.crt'].includes(ext)) {
    return { cls: 'elevated', rule: 'миграции, .env, settings.json, ключи и сертификаты' };
  }
  if (aclTokens.some((t) => low === t.value || (t.prefix && low.startsWith(t.prefix)))) {
    return { cls: 'elevated', rule: 'путь из раздела «Права доступа» профиля' };
  }
  if (CODE_EXT.includes(ext)) return { cls: 'standard', rule: 'расширение кода' };
  if (!ext) return { cls: 'standard', rule: 'путь без расширения' };
  if (RISKY_WORDS.some((w) => low.includes(w))) return { cls: 'standard', rule: 'слово из списка (config, settings, auth, …)' };
  if (DATA_EXT.includes(ext) && !TEST_DIR.test(low)) return { cls: 'standard', rule: 'данные и конфигурация вне каталога тестов' };
  return { cls: 'cosmetic', rule: '' };
}

/**
 * Пути из раздела «Права доступа» (`## 5.`) профиля проекта. Возвращает `{ tokens, notes }`.
 *
 * Токен режется по ПЕРВОМУ `*` и дальше работает префиксом: `.claude/tasks/**\/STATE.md`
 * → `.claude/tasks/`. Префикс из ОДНОГО верхнего каталога (`.claude/`, `src/`) отбрасывается:
 * по нему правило поднимало бы до `elevated` любой план, трогающий что угодно внутри набора,
 * то есть гарантия срабатывала бы всегда и перестала бы что-либо значить.
 *
 * Профиля нет или раздел не найден — НЕ ошибка: строка в вывод, и пол считается по остальным
 * правилам. Честно: в свежем проекте §5 шаблона — сплошные `TODO`, это правило там молчит,
 * и вся нагрузка ложится на правила по расширениям.
 *
 * Токены печатаются через `clean()` и с той же обрезкой, что пути: они приходят из
 * `PROJECT_PROFILE.md`, то есть из того же недоверенного текста, что и план.
 */
function aclPrefixes() {
  const notes = [];
  const tokens = [];
  const src = readOr(PROFILE, '');
  if (!src) {
    notes.push('профиль проекта не прочитан — раздел «Права доступа» в поле зрения не попал');
    return { tokens, notes };
  }
  const lines = src.split(/\r?\n/);
  let from = -1;
  for (let i = 0; i < lines.length; i += 1) if (/^##\s+5\./.test(lines[i])) { from = i; break; }
  if (from === -1) {
    notes.push('раздел «Права доступа» не найден — пол по нему не считался');
    return { tokens, notes };
  }
  const dropped = [];
  for (let i = from + 1; i < lines.length && !/^##\s/.test(lines[i]); i += 1) {
    for (const t of lines[i].matchAll(/`([^`]*)`/g)) {
      const tok = t[1];
      if (!tok || /\s/.test(tok)) continue;
      if (!tok.includes('/') && !tok.includes('.')) continue;
      const value = tok.split('\\').join('/').toLowerCase();
      const cut = value.indexOf('*');
      const head = cut === -1 ? value : value.slice(0, cut);
      if (!head) continue;
      // Один верхний каталог: `.claude/`, `src/` — см. докблок. Правило действует и на токен
      // со звёздочкой (`.claude/**`), и на голый (`.claude/`): опасен именно верхний каталог,
      // а не форма записи.
      if (head.endsWith('/') && !head.slice(0, -1).includes('/')) { dropped.push(head); continue; }
      if (cut === -1) tokens.push({ value: head, prefix: '' });
      else tokens.push({ value: '', prefix: head });
    }
  }
  for (const d of dropped.slice(0, PRINT_MAX)) notes.push(`токен ${clean(d)} из §5 не учтён: один верхний каталог`);
  if (dropped.length > PRINT_MAX) notes.push(`и ещё ${dropped.length - PRINT_MAX} токенов из §5 не учтено`);
  return { tokens, notes };
}

/** Больший из двух классов по порядку cosmetic < standard < elevated. */
function maxClass(a, b) {
  return CLASSES.indexOf(a) >= CLASSES.indexOf(b) ? a : b;
}

// --- идентификаторы и пути --------------------------------------------------

/**
 * ЕДИНСТВЕННОЕ место, где идентификатор превращается в путь. Через него обязаны ходить все
 * подкоманды, чтение ACTIVE и всё, что придёт позже: `id` приходит из файла, который правят
 * руками, из чужого markdown при миграции и из командной строки — то есть отовсюду.
 *
 * Возвращает абсолютный путь или null («не разобрал»). Что делать с отказом, решает
 * вызывающий: подкоманды заканчиваются кодом 3, а перечисление и миграция просто пропускают
 * такую запись. Никаких попыток «починить» строку здесь нет и быть не должно.
 */
function taskDir(id) {
  const s = String(id == null ? '' : id);
  if (s.length > ID_MAX) return null;   // ENAMETOOLONG — плохая замена внятному отказу
  if (!ID_RE.test(s)) return null;
  const dir = path.resolve(TASKS, s);
  if (!dir.startsWith(TASKS + path.sep)) return null;   // граница каталога, а не вера в регэксп
  return dir;
}

/** Правило Р11 на одного кандидата: имя прошло taskDir() и внутри есть STATE.md. */
function hasState(dir) {
  try { return statSync(path.join(dir, 'STATE.md')).isFile(); } catch { return false; }
}

/** id из ACTIVE, если он вообще похож на идентификатор; иначе null. Мягкая форма. */
function activeId() {
  const raw = activeRaw();
  return raw && taskDir(raw) ? raw : null;
}

function activeRaw() {
  try {
    return String(readFileSync(ACTIVE, 'utf8')).split(/\r?\n/)[0].trim();
  } catch {
    return '';
  }
}

/**
 * Активная задача целиком — для подкоманд, которые пишут. Ничего не создаёт и не достраивает:
 * `echo ../../../tmp > ACTIVE` обязан заканчиваться отказом, а не свежесозданной папкой.
 */
function requireActive() {
  const raw = activeRaw();
  if (!raw) die('активной задачи нет: .claude/tasks/ACTIVE пуст');
  const dir = taskDir(raw);
  if (!dir) die(`в ACTIVE не идентификатор задачи: «${clean(raw).slice(0, 80)}» — путь по нему не строю`);
  if (!hasState(dir)) die(`задачи ${raw} нет на диске (нет папки или нет STATE.md) — ничего не создаю`);
  return { id: raw, dir };
}

// --- файлы задачи -----------------------------------------------------------

/** Кладёт форму из assets/stubs. Существующее не перезаписывается никогда. */
function placeStub(name, to, transform) {
  if (existsSync(to)) { say(`${path.basename(to)} уже на месте — не трогаю`); return; }
  const from = path.join(STUBS, name);
  if (!existsSync(from)) { say(`нет заглушки assets/stubs/${name} — пропускаю`); return; }
  try {
    const src = readFileSync(from, 'utf8');
    writeFileSync(to, transform ? transform(src) : src, 'utf8');
  } catch (e) {
    say(`не смог положить ${path.basename(to)}: ${e.message}`);
  }
}

/** Эталон STATE.md → состояние конкретной задачи. */
function fillState(src, id, title) {
  const now = stamp();
  const filled = editFront(src, {
    id,
    title: title || '(без названия)',
    status: STATUSES[0],
    mode: 'full',
    created: now,
    updated: now,
    review_iterations: '0',
    // Класс риска ещё не считался: `-` читается всеми как `standard`, но никогда как
    // `cosmetic` (см. врезку в assets/stubs/STATE.md). Считает его `task.mjs class`.
    class: '-',
    audit_iterations: '0',
    stop_kind: '-',
    branch: gitBranch(),
  }) || src;
  // Строка-пример из эталона заменяется настоящей первой записью: журнал с выдуманной
  // строкой хуже пустого — по нему потом восстанавливают ход работы.
  const i = filled.indexOf('## Журнал');
  return i === -1 ? filled : `${filled.slice(0, i)}## Журнал\n\n- ${hhmm()} задача заведена\n`;
}

/** Правит поля во front-matter, не трогая тело. Нет front-matter — null (сами не выдумываем). */
function editFront(src, fields) {
  const m = String(src).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  let front = m[1];
  for (const [key, value] of Object.entries(fields)) {
    const re = new RegExp(`^${key}:.*$`, 'm');
    if (re.test(front)) front = front.replace(re, `${key}: ${value}`);
    else front += `\n${key}: ${value}`;
  }
  return `${src.slice(0, m.index)}---\n${front}\n---${src.slice(m.index + m[0].length)}`;
}

function frontMatter(src) {
  const m = String(src).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const map = new Map();
  for (const line of m[1].split(/\r?\n/)) {
    const f = line.match(/^([A-Za-z_][\w-]*)\s*:(.*)$/);
    if (f) map.set(f[1], f[2].trim());
  }
  return map;
}

/**
 * Счётчик из front-matter: сколько раз ревью возвращало задачу исполнителю
 * (`review_iterations`) или сколько раз план подавался на аудит (`audit_iterations`).
 * Функция обслуживает ОБА поля — правила у них одни и те же, и разными они быть не должны.
 *
 * Ровно ТРИ исхода и ни одного больше:
 *   поля нет вовсе         → 0. Законный ноль: задача заведена копией набора до 1.15.0
 *                            (для `audit_iterations` — до 1.17.0), и `editFront` допишет поле
 *                            при первом же переходе;
 *   целое и не меньше нуля → оно само;
 *   всё остальное          → null, «не разобрано», и вызывающий отказывает.
 *
 * Зажимать значение в ноль (`Math.max(0, …)`) здесь ЗАПРЕЩЕНО. Это единственная функция,
 * на которой держатся оба лимита, и двух трактовок одного значения в ней быть не должно:
 * отрицательное обязано давать отказ, а не тихий ноль. `parseInt('-5')` даёт -5, сравнение
 * «меньше трёх» не наступило бы очень долго, а поле можно удалить `Bash`-ом — правила `deny`
 * закрывают по STATE.md только `Write`/`Edit`.
 *
 * Пустая строка отсекается ОТДЕЛЬНО от нуля намеренно: `Number('')` — это 0, и пустое поле
 * иначе притворилось бы законным нулём, молча сбросив лимит.
 */
function iters(fm, field) {
  if (!fm || !fm.has(field)) return 0;
  const raw = clean(fm.get(field));
  if (raw === '') return null;
  const n = Number(raw);
  return (Number.isInteger(n) && n >= 0) ? n : null;
}

/** Журнал — хвост STATE.md. Дата стоит в `updated:`, поэтому в строке только время. */
function journal(file, text) {
  try {
    const src = readFileSync(file, 'utf8');
    const line = `- ${hhmm()} ${clean(text)}\n`;
    const sep = src.endsWith('\n') ? '' : '\n';
    appendFileSync(file, src.includes('## Журнал') ? sep + line : `${sep}\n## Журнал\n\n${line}`, 'utf8');
  } catch (e) {
    say(`не смог дописать журнал: ${e.message}`);   // журнал не повод ронять команду
  }
}

/**
 * Событие в машинный журнал `.claude/artifacts/events.jsonl` — best-effort и молча.
 *
 * Отдельным процессом, а не импортом: статический импорт ESM нельзя обернуть в `try/catch`,
 * и сломанный или недоехавший `events.mjs` уронил бы загрузку самого хука — то есть журнал
 * отнял бы у человека смену статуса. Цена решения — один процесс Node на событие.
 *
 * Значения чистятся ЗДЕСЬ, до `args.push`, а не только внутри `events.mjs`: очистка внутри
 * хука работает уже после границы процессов, а ломается именно граница. Node отвергает `argv`
 * с нулевым байтом целиком — `spawnSync` бросит, пустой `catch` проглотит, и событие пропадёт
 * молча. Тот же вызов закрывает длину: огромное значение раздувает `argv` за лимит ОС
 * (на Windows 32 767 символов) с тем же молчаливым исходом. Очистка в `events.mjs` при этом
 * остаётся — две линии здесь намеренны.
 *
 * `String(v)` перед `clean` обязателен: числа в payload бывают (`duration_min`), а версия
 * `clean` в gate.mjs написана как `String(s || '')` и превратила бы `0` в пустую строку, то
 * есть выбросила бы пару. Пишем одинаково в обоих файлах, чтобы разница реализаций `clean`
 * вообще не имела значения. Ключи не чистим — это литералы в коде, за них отвечает `KEY_RE`
 * в `events.mjs`.
 *
 * Ни `say`, ни `die` внутри: молчание намеренно, диагностика журнала живёт
 * в `events.mjs --selftest`, а не в выводе каждой команды.
 *
 * Первым действием обнуляет `pending`: с этой секунды событие взято в работу, и аварийный
 * досыл из верхнеуровневого `catch` его не повторит. Обнуление стоит ДО `existsSync`
 * намеренно — если `events.mjs` в наборе нет, повторять вызов из `catch` тем более незачем.
 */
function emit(event, id, payload) {
  pending = null;   // событие взято в работу — flushPending его больше не продублирует
  try {
    if (!existsSync(EVENTS_MJS)) return;
    const args = [EVENTS_MJS, '--emit', event, '--task', String(id || '')];
    for (const [k, v] of Object.entries(payload || {})) {
      if (v === undefined || v === null) continue;   // нет значения — нет пары
      const sv = clean(String(v));                   // String() обязателен: см. комментарий выше
      if (!sv) continue;                             // после чистки пусто — пары нет
      args.push('--set', `${k}=${sv}`);
    }
    spawnSync(process.execPath, args, { cwd: PROJECT_ROOT, timeout: 10000, stdio: 'ignore' });
  } catch { /* молча: журнал не повод ломать команду */ }
}

/**
 * «Событие заслужено»: изменение уже лежит на диске, а в журнал ещё не попало. Вызывается
 * СРАЗУ после удавшегося `writeFileSync` и ничего не пишет — только запоминает, что должно
 * быть записано. Дальше нормальным путём его пишет `emit`, а если до `emit` дело не дойдёт
 * (исключение между записью и вызовом) — `flushPending` из верхнеуровневого `catch`.
 *
 * Порядок «действие → событие» этим не меняется: событие по-прежнему отражает случившееся,
 * а не намерение. Переставить `emit` перед записью значило бы врать журналу, когда запись
 * не удалась.
 *
 * Payload копируется, а не берётся по ссылке: вызывающий волен дополнять свой объект после
 * вызова, и в аварийную запись не должно попасть то, чего в обычной не было бы.
 */
function pend(event, id, payload) {
  pending = { event, id, payload: { ...(payload || {}) } };
}

/**
 * Досыл незаписанного события из верхнеуровневого `catch`. Пара `crashed=yes` отличает его от
 * обычного: действие состоялось, но команда после этого упала, и остальному её выводу верить
 * нельзя. Новых имён под падение не заводим — оно видно по паре, а имя события остаётся тем
 * же, каким было бы при нормальном ходе дел.
 *
 * Текста ошибки в payload нет намеренно: `e.message` — свободный текст (в современном Node он
 * цитирует разбираемое содержимое), а журнал с фазы 1 контроллера отдаётся по HTTP. Полное
 * сообщение никуда не девается — его печатает человеку `die` в stderr.
 */
function flushPending() {
  const p = pending;
  if (!p) return;
  emit(p.event, p.id, { ...p.payload, crashed: 'yes' });
}

// --- вспомогательное --------------------------------------------------------

function readOr(file, fallback) {
  try { return readFileSync(file, 'utf8'); } catch { return fallback; }
}

/** Состояние приёмки. Оно живёт отдельно от задачи, и намеренно: см. врезку в STATE.md. */
function readGate() {
  try {
    const j = JSON.parse(readFileSync(GATE_STATE, 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

function gitBranch() {
  try {
    const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 5000,
    });
    if (r.error || r.status !== 0) return '-';
    return clean(r.stdout).slice(0, 60) || '-';
  } catch {
    return '-';
  }
}

/**
 * Текст человека, который попадёт в файл и в терминал. Управляющие символы (в том числе
 * нулевой байт, переводы строк и ANSI-escape) заменяются пробелом, длина режется по лимиту
 * заголовка. Чистим повторно, даже если звавший уже чистил: доверие к чужой очистке —
 * это отсутствие очистки.
 */
function clean(s) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/**
 * Имя папки из названия задачи. Кириллица переводится в латиницу: так имя остаётся
 * читаемым и не ломается при переносе между системами и архиваторами.
 *
 * Белый список `[^a-z0-9]+ → '-'` и фолбэк 'zadacha' — часть контракта безопасности, а не
 * стиль: именно на них держится защита от `../`, двоеточий, нулевых байтов и омоглифов.
 * Копия из archive-task.mjs намеренная: два хука обязаны собирать одно и то же имя.
 */
function slug(title) {
  const map = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
    й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
    у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
    э: 'e', ю: 'yu', я: 'ya',
  };
  return [...title.toLowerCase()]
    .map((ch) => (map[ch] !== undefined ? map[ch] : ch))
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'zadacha';
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function hhmm() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function stamp() {
  return `${today()} ${hhmm()}`;
}

/**
 * Обратное к `stamp()`: `"2026-08-27 14:40"` → миллисекунды. Разбираем сами, а не через
 * `new Date(строка)`, потому что это НЕ ISO-формат, и разные движки понимают такую строку
 * по-разному (где-то как локальное время, где-то как UTC, где-то не понимают вовсе).
 * Собираем по локальным компонентам — ровно так, как её и записали. Не совпало — `null`,
 * и вызывающий просто не пишет поле: ноль вместо факта не выдумываем.
 */
function parseStamp(s) {
  const m = String(s == null ? '' : s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime();
  return Number.isFinite(t) ? t : null;
}

function rel(p) {
  const r = path.relative(PROJECT_ROOT, p);
  return (!r || r.startsWith('..')) ? p : r.split(path.sep).join('/');
}

function out(line) {
  process.stdout.write(`${line}\n`);
}

function say(line) {
  console.log(`${TAG} ${line}`);
}

function die(msg) {
  for (const line of String(msg).split('\n')) process.stderr.write(`${TAG} ${line}\n`);
  process.exit(3);
}
