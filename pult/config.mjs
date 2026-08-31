#!/usr/bin/env node
/**
 * Настройки, потолки и закрытые словари демона пульта.
 *
 * Здесь только константы: ни одного обращения к диску, ни одной функции с побочным эффектом.
 * Всё, чем демон ограничивает себя при чтении чужих проектов, собрано в одном файле —
 * иначе потолки расползаются по модулям и «сколько мы читаем в худшем случае» перестаёт
 * быть вопросом с ответом.
 *
 * Три группы словарей и почему они закрытые:
 *
 *   1. Перечислимые поля кита (`ENUM`) — снимок набора на 2026-08-31. Значение из чужого
 *      `STATE.md` или `GATE_STATE.json` попадает в HTTP-ответ ТОЛЬКО совпав со словарём;
 *      не совпало — `null` и код отказа. Подготовленный проект в реестре кладёт в `status:`
 *      что угодно, и без словаря эта строка уехала бы фазе 2 под видом машинного поля.
 *   2. Регулярки времён (`TIME_RE`) — привязаны к обоим концам и фиксированной длины,
 *      поэтому «значение есть совпадение» и «значение есть строка целиком» здесь одно и то же.
 *   3. Коды отказов (`FAULT`) — наши собственные машинные слова. В `faults[]` уезжает код,
 *      а не текст ошибки: в современном Node сообщение об ошибке цитирует разбираемое
 *      содержимое, то есть чужой текст прошёл бы мимо всех белых списков.
 *
 * Словари сверяются с китом при каждом обновлении набора — там же, где гоняется сторож
 * копии отпечатка (`pult/tools/fingerprint-parity.mjs`).
 */

// --- сеть --------------------------------------------------------------------

export const HOST = '127.0.0.1';
export const PORT = 7331;

// Слушать локальную сеть разрешает раздел 1.1 контракта, но авторизация — открытый вопрос 2,
// он решается до фазы 2. Пока за адресом нет ни терминала, ни пин-кода, доступ снаружи петли
// выключен намеренно, а не «не сделан».
export const LAN = false;

// Закрытый список допустимых значений заголовка `Host`. Значения «любой» форма константы
// не предусматривает: при включении локальной сети сюда дописываются ЯВНЫЕ адреса с портами.
//
// Почему это вообще нужно: привязка к петле границей для браузера НЕ является. Страница
// заводит домен, который переезжает на 127.0.0.1, и запрос к `http://evil.example:7331/projects`
// для браузера становится однопроисхожденным; `Host` при этом остаётся чужим, а Node сам его
// не проверяет никогда. На фазе 2 за этим же адресом встанет терминал с доступом к оболочке.
export const HOST_ALLOW = Object.freeze([`${HOST}:${PORT}`, `localhost:${PORT}`]);

// Ограничители соединения.
export const MAX_CONNECTIONS = 32;
export const REQUEST_TIMEOUT_MS = 5000;
export const HEADERS_TIMEOUT_MS = 5000;
export const KEEP_ALIVE_TIMEOUT_MS = 5000;
export const MAX_REQUEST_LINE = 2048;      // потолок длины строки запроса

// --- бюджеты чтения ----------------------------------------------------------
//
// Трёхуровневые намеренно. Бюджет проекта не даёт одному каталогу съесть весь ход; сквозной
// бюджет запроса не даёт этого сделать всем проектам вместе; собственный бюджет эталона
// отделён от сквозного, чтобы один тяжёлый проект в реестре не гасил сверку у всех остальных:
// эталон считается первым и по своему бюджету, иначе `verdict: unknown` получили бы ВСЕ.

export const BUDGET_PROJECT = Object.freeze({
  ms: 2500,                      // таймаут на проект: защищает только асинхронную пробу
  files: 5000,
  bytes: 64 * 1024 * 1024,
});

export const BUDGET_REQUEST = Object.freeze({
  ms: 15000,
  files: 20000,
  bytes: 256 * 1024 * 1024,
});

export const BUDGET_REFERENCE = Object.freeze({
  ms: 2500,
  files: 5000,
  bytes: 64 * 1024 * 1024,
});

// Одновременно идёт не больше одного полного скана: подсчёт отпечатка синхронный,
// параллелить его на одном потоке смысла нет, а очередь из них глушит цикл событий.
export const MAX_CONCURRENT_SCANS = 1;

// --- потолки данных ----------------------------------------------------------

export const MAX_PROJECTS = 64;
export const MAX_TASKS = 200;
export const MAX_TEXT_FILE = 256 * 1024;         // размер читаемого текстового файла
export const MAX_SCAN_FILE = 4 * 1024 * 1024;    // размер ОДНОГО файла в обходе отпечатка
export const MAX_DIR_ENTRIES = 4096;             // записей в одном читаемом каталоге
// Каталогов за ОДИН обход отпечатка. Ширину одного каталога режет потолок выше, число
// прочитанных файлов и объём — бюджеты, а число каталогов не считал никто: дерево из одних
// пустых каталогов ничего не стоит и проходилось целиком, синхронно, вместе с `/health`
// (замер: 18 000 каталогов — 2090 мс обхода и столько же ожидания у проверки здоровья).
// Кит — папка настроек: под `ship.list` этого репозитория попадает ПЯТЬ каталогов (`agents`,
// `commands`, `hooks`, `assets`, `assets/stubs`) — столько же посещает и обход боевого кита.
// Во всей `.claude` каталогов 24, но `artifacts/`, `explores/` и `tasks/` в состав не входят
// и обходом не читаются. Запас здесь двухсоткратный (1024 против пяти), и исчерпание потолка
// означает не «дерево большое», а «читаемая папка — не кит»; ответ — честный `verdict: unknown`.
export const MAX_DIRS = 1024;                    // каталогов за один обход отпечатка
export const MAX_LINE_BYTES = 4096;              // длина разбираемой строки файла
export const MAX_TEXT = 1000;                    // длина строки свободного текста в ответе
export const EVENTS_TAIL_BYTES = 64 * 1024;      // хвост журнала событий
export const MAX_LOG_LINES = 200;                // строк журнала задачи
export const MAX_CHECKLIST = 100;                // пунктов чек-листа итога
export const MAX_DIVERGED = 50;                  // путей в списке расхождений
export const MAX_REGISTRY_ENTRIES = 200;         // записей в реестре
export const MAX_PATH = 4096;                    // длина пути в реестре

// Обёртка над списком состава чужого проекта (`ship.list`) — недоверенный вход,
// он управляет обходом файловой системы.
export const MAX_SHIP_ENTRIES = 500;
export const MAX_SHIP_ENTRY = 200;

// --- времена -----------------------------------------------------------------
//
// Четыре вида, четыре привязанные регулярки, ни одного «умного» разбора. Значение под
// пометкой `kind` в ответе — это СОВПАДЕНИЕ регулярки, а не кусок чужого файла: единственная
// дверь к временам — `timeField()` в `pult/lib/fs-safe.mjs`.
//
//   local-naive  как пишет `stamp()` в `.claude/hooks/task.mjs`   2026-08-31 16:13
//   utc-iso      как `new Date().toISOString()`                   2026-08-31T14:52:13.984Z
//   clock        строка журнала задачи, `hhmm()` там же           16:13
//   date         строка даты в итоге задачи                       2026-08-31
export const TIME_KINDS = Object.freeze(['local-naive', 'utc-iso', 'clock', 'date']);

export const TIME_RE = Object.freeze({
  'local-naive': /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/,
  'utc-iso': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  clock: /^\d{2}:\d{2}$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
});

// Строка длиннее этого до регулярки не доходит вовсе.
export const MAX_TIME_RAW = 64;

// --- закрытые словари перечислимых полей кита --------------------------------

export const ENUM = Object.freeze({
  // `STATUSES` в `.claude/hooks/task.mjs` — девять значений, порядок оттуда же.
  taskStatus: Object.freeze([
    'exploring', 'planning', 'awaiting_approval', 'implementing',
    'reviewing', 'reworking', 'awaiting_acceptance', 'done', 'blocked',
  ]),

  // `CLASSES` в `.claude/hooks/task.mjs` плюс `-`: прочерк пишет `fillState()` там же
  // и означает «класс ещё не считался».
  taskClass: Object.freeze(['cosmetic', 'standard', 'elevated', '-']),

  // `STOP_KINDS` в `.claude/hooks/task.mjs` плюс `-` («стопа не было»).
  taskStopKind: Object.freeze(['product', 'technical', 'security', '-']),

  // Словаря-константы у режима задачи в ките НЕТ: `fillState()` пишет `full` жёстко,
  // других значений в коде не встречается. Поэтому всё прочее считается нераспознанным.
  taskMode: Object.freeze(['full']),

  // Ровно три значения, и все три попадают на диск через `writeState()`
  // в `.claude/hooks/gate.mjs`: `arm()` пишет `implementing`, `decide()` — `verified`
  // (зелёный и частичный прогон, коды 0 и 4) и `blocked` (три неудачные попытки либо
  // подменённый набор проверок). Источник перечня — все вызовы `writeState(...)` в хуке,
  // а не список слов, встречающихся в его тексте.
  //
  // ЛОВУШКА. В том же хуке встречаются слова `stale`, `none`, `fail`, `error` — вот это
  // payload события `gate_result`, а НЕ состояние на диске. Сливать два словаря нельзя:
  // состояние в файле знает три значения `status` и четыре значения `verify`.
  //
  // А `verified` из перечня «только payload» убрано намеренно: оно и payload, и состояние
  // на диске, причём самое частое ЗДОРОВОЕ — у любого проекта, прошедшего приёмку, в файле
  // лежит именно оно. Пока словарь знал два значения из трёх, такой проект получал
  // `gate.status: null` и код `enum_unrecognised`, то есть машинная проверка «не совпало —
  // значит null» срабатывала на здоровом ките.
  gateStatus: Object.freeze(['implementing', 'verified', 'blocked']),

  // Результат приёмки в состоянии гейта. `partial` — частичный прогон (на Windows без bash
  // проверка `install-sh` даёт `skipped`, и весь прогон становится частичным).
  gateVerify: Object.freeze(['none', 'partial', 'pass', 'fail']),

  // Вердикт ревью и аудита — по эталонам `.claude/assets/stubs/REVIEW.md`
  // и `.claude/assets/stubs/SECURITY.md`.
  verdict: Object.freeze(['approved', 'changes_requested', 'blocked']),

  // Белый список имён событий — `EVENTS` в `.claude/hooks/events.mjs`, семь имён.
  event: Object.freeze([
    'task_opened', 'status_changed', 'gate_armed', 'gate_result', 'task_closed',
    'session_started', 'session_ended',
  ]),

  // Состояния проекта в ответе. Наши, не китовые: раздел 1.4 контракта требует их наличия,
  // но признака «чужой кит» в самом ките нет — эвристика описана в `pult/read/kit.mjs`.
  projectState: Object.freeze(['ok', 'unreachable', 'no_kit', 'foreign', 'legacy']),

  // Состояния профиля. `filled` — зелёный кружок, `template` — красный (так их различает
  // приветствие набора), `absent` — файла нет, `null` — нечитаем.
  profile: Object.freeze(['filled', 'template', 'absent']),

  // Вердикт сверки отпечатка.
  fingerprintVerdict: Object.freeze(['match', 'mismatch', 'unknown']),
});

// Форма идентификатора задачи — та же, что в `task.mjs`, `gate.mjs` и `events.mjs`.
export const TASK_ID_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*$/;
export const TASK_ID_MAX = 80;

// Идентификатор проекта в реестре и в адресе: восемь шестнадцатеричных знаков.
export const PROJECT_ID_RE = /^[0-9a-f]{8}$/;

// Версия набора: первая строка файла версии, «число.число.число» и ничего больше.
export const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

// Целое без знака. Правило счётчиков уже написано в `iters()` в `.claude/hooks/task.mjs`,
// здесь оно повторено, а не изобретено заново: пустая строка отсекается ОТДЕЛЬНО от нуля,
// потому что число из пустой строки — это 0, и пустое поле иначе притворилось бы законным
// нулём. Осмысленный потолок у `attempts` гейта задаёт `MAX_ATTEMPTS` там же, но большее
// значение не чинится и не выдумывается — оно просто целое.
export const COUNTER_RE = /^\d{1,9}$/;

// --- закрытый словарь кодов отказов ------------------------------------------
//
// В `faults[]` и в `reason` уезжает ТОЛЬКО значение отсюда. Ни текста ошибки, ни стека,
// ни пути к файлу: подробности остаются в stdout демона, где они нужны человеку.

export const FAULT = Object.freeze({
  VERSION_UNREADABLE: 'version_unreadable',             // нечитаемая версия
  PROFILE_UNREADABLE: 'profile_unreadable',             // нечитаемый профиль
  SHIP_LIST_MISSING: 'ship_list_missing',               // отсутствующий список состава
  FINGERPRINT_UNCOUNTABLE: 'fingerprint_uncountable',   // несчитаемый отпечаток
  REFERENCE_MISSING: 'reference_missing',               // отсутствующий эталон
  REFERENCE_UNREACHABLE: 'reference_unreachable',       // недоступный эталон
  SCAN_TRUNCATED: 'scan_truncated',                     // усечён обход отпечатка
  REFERENCE_SCAN_TRUNCATED: 'reference_scan_truncated', // усечён обход эталона
  FILE_UNREADABLE: 'file_unreadable',                   // нечитаемый файл в обходе
  DIR_UNREADABLE: 'dir_unreadable',                     // неперечислимый каталог в обходе
  LSTAT_FAILED: 'lstat_failed',                         // несостоявшийся lstat в обходе
  STATE_NO_FRONT_MATTER: 'state_no_front_matter',       // нет front-matter в состоянии задачи
  ACTIVE_UNREADABLE: 'active_unreadable',               // нечитаемый указатель активной задачи
  REVIEW_HEADER_MISSING: 'review_header_missing',       // шапки ревью нет вовсе
  SECURITY_HEADER_MISSING: 'security_header_missing',   // шапки аудита нет вовсе
  DONE_UNPARSED: 'done_unparsed',                       // неразобранный итог
  GATE_STATE_UNREADABLE: 'gate_state_unreadable',       // нечитаемое состояние гейта
  VERIFY_REPORT_UNREADABLE: 'verify_report_unreadable', // нечитаемый отчёт приёмки
  EVENTS_UNREADABLE: 'events_unreadable',               // нечитаемый журнал
  TASKS_UNREADABLE: 'tasks_unreadable',                 // нечитаемый список задач
  TASKS_TRUNCATED: 'tasks_truncated',                   // обрезка списка задач
  TEXT_TRUNCATED: 'text_truncated',                     // обрезка строки свободного текста
  TIME_UNRECOGNISED: 'time_unrecognised',               // нераспознанное время
  ENUM_UNRECOGNISED: 'enum_unrecognised',               // нераспознанное значение перечислимого поля
  NOT_PLAIN_FILE: 'not_plain_file',                     // пропущен не обычный файл
  FILE_TOO_BIG: 'file_too_big',                         // файл сверх потолка
  BUDGET_EXHAUSTED: 'budget_exhausted',                 // исчерпан бюджет запроса
  REGISTRY_ENTRY_INVALID: 'registry_entry_invalid',     // негодная запись реестра
  PATH_UNREACHABLE: 'path_unreachable',                 // недоступный путь
  READ_TIMEOUT: 'read_timeout',                         // таймаут чтения
  // Запись состава отбита обёрткой над `ship.list` (абсолютная, с двумя точками, с обратным
  // слэшем, с нулевым байтом, длиннее потолка, сверх потолка числа записей) либо не легла
  // внутрь папки кита по проверке вложенности. Кода на этот случай план поимённо не назвал,
  // а ограждение без своего кода не умеет о себе доложить, — заводим его здесь, рядом
  // с остальными, а не сводим к общему «нераспознанному отказу».
  ENTRY_REJECTED: 'entry_rejected',
  UNKNOWN: 'unknown_fault',                             // нераспознанный отказ (общий код)
});

/** Все коды одним множеством: ничем, кроме значения отсюда, `faults[]` не наполняется. */
export const FAULT_CODES = Object.freeze(new Set(Object.values(FAULT)));

/**
 * Имя системной ошибки в код из словаря. Имени в таблице нет — общий `UNKNOWN`, а не сырое
 * значение: список имён системных ошибок открыт, и пускать чужое слово в ответ только потому,
 * что оно короткое, нельзя.
 */
export const ERROR_CODES = Object.freeze({
  ENOENT: FAULT.PATH_UNREACHABLE,
  ENOTDIR: FAULT.PATH_UNREACHABLE,
  ENAMETOOLONG: FAULT.PATH_UNREACHABLE,
  EACCES: FAULT.FILE_UNREADABLE,
  EPERM: FAULT.FILE_UNREADABLE,
  EBUSY: FAULT.FILE_UNREADABLE,
  EMFILE: FAULT.FILE_UNREADABLE,
  ENFILE: FAULT.FILE_UNREADABLE,
  EIO: FAULT.FILE_UNREADABLE,
  EISDIR: FAULT.NOT_PLAIN_FILE,
  ELOOP: FAULT.NOT_PLAIN_FILE,
  ETIMEDOUT: FAULT.READ_TIMEOUT,
  ERR_FS_FILE_TOO_LARGE: FAULT.FILE_TOO_BIG,
});
