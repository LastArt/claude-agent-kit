/**
 * МОСТ МЕЖДУ СТРАНИЦЕЙ И ГЛАВНЫМ ПРОЦЕССОМ — МИНИМАЛЬНЫЙ ПО ПОСТРОЕНИЮ.
 *
 * Это единственная точка, где страница получает что-то сверх обычного браузера, и поверхность
 * считается по одному правилу: КАЖДЫЙ МЕТОД МОСТА — ЭТО ТО, ЧТО ЧУЖОЙ СКРИПТ НА СТРАНИЦЕ
 * СМОЖЕТ ПОЗВАТЬ.
 *
 * ПОВЕРХНОСТЬ РАСТЁТ ВПЕРВЫЕ (фаза 4), И ПРАВИЛО ЕЁ РОСТА ЗАПИСАНО ЗДЕСЬ ЗАГЛАВНЫМИ:
 *
 *   ПАРАМЕТРОМ БЫВАЕТ ТОЛЬКО ИДЕНТИФИКАТОР ИЗВЕСТНОЙ ФОРМЫ ИЛИ СЛОВО ИЗ ЗАКРЫТОГО СЛОВАРЯ.
 *   НИ ОДИН ПАРАМЕТР НИКОГДА НЕ УЧАСТВУЕТ В ПОСТРОЕНИИ ПУТИ.
 *
 * Источников пути по-прежнему ДВА, и оба вне страницы: системный диалог главного процесса
 * и реестр по идентификатору. Метод «завести проект» как не имел параметра пути, так
 * и не получит его — ни целиком, ни частью, ни подсказкой начального каталога.
 *
 * ОТКЛОНЕНИЕ ОТ БУКВЫ ФАЗЫ 3 НАЗЫВАЕТСЯ ПРЯМО. Тогда здесь стояло «ни одна функция моста
 * не принимает ничего», и это было честно: параметров не требовалось. Теперь требуется выбрать
 * проект и команду, то есть параметры появились. Заменяющая гарантия — не «мы аккуратны»,
 * а три вещи вместе: проверка формы прямо здесь, закрытые словари прямо здесь и ПОДТВЕРЖДЕНИЕ
 * ГЛАВНОГО ПРОЦЕССА на всём, что меняет состояние. Не прошедшее форму НЕ УЕЗЖАЕТ в главный
 * процесс вовсе; прошедшее проверяется там ЗАНОВО — мост живёт в одном процессе со страницей.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И НЕ ПОЯВИТСЯ: чтения файловой системы, запуска процессов, открытия внешних
 * ссылок. Наружу мост выставляется только официальным пробросом в изолированный контекст,
 * и проброс этот ОДИН.
 *
 * ФОРМАТ CommonJS НАМЕРЕННЫЙ, И РАСШИРЕНИЕ ФАЙЛА «ЧИНИТЬ» НЕ НАДО: при включённой песочнице
 * окна предзагрузка в формате модулей не поддерживается. Оттуда же второе следствие —
 * в песочнице предзагрузке доступен УРЕЗАННЫЙ `require` (только `electron` и несколько
 * встроенных), поэтому импортировать константы демона отсюда нельзя, и все формы и словари
 * ниже ПОВТОРЕНЫ с указанием источника.
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Имена каналов повторены в `pult/shell/main.mjs` по той же причине: общий модуль констант
 * предзагрузке в песочнице недоступен. Меняешь здесь — меняй там.
 */
const CH_ADD_PROJECT = 'cckit-shell:add-project';
const CH_OPEN_TASK = 'cckit-shell:open-task';
const CH_KIT_RUN = 'cckit-shell:kit-run';
const CH_DEPLOY_INSPECT = 'cckit-shell:deploy-inspect';
const CH_DEPLOY_RUN = 'cckit-shell:deploy-run';
const CH_DEPLOY_REMOVE = 'cckit-shell:deploy-remove';

/**
 * Формы идентификаторов — копии `PROJECT_ID_RE` и `TASK_ID_RE` (`pult/config.mjs`),
 * вместе с потолком длины `TASK_ID_MAX`. Копия вынужденная (см. шапку), поэтому источник
 * назван прямо здесь.
 */
const PROJECT_ID_RE = /^[0-9a-f]{8}$/;
const TASK_ID_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*$/;
const TASK_ID_MAX = 80;

/**
 * Закрытый словарь ключей команд набора — копия `KIT_READ_KEYS` и `KIT_WRITE_KEYS`
 * (`pult/config.mjs`), а таблица аргументов к ним живёт в `pult/shell/kit-commands.mjs`.
 * Здесь только ИМЕНА: сюда не попадает ни один аргумент, и собирать их странице нечем.
 */
const KIT_KEYS = [
  'task_list', 'task_path', 'verify_dry', 'verify_selftest',
  'gate_status', 'gate_dry', 'banner',
  'status_implementing', 'status_reviewing', 'status_done', 'status_blocked', 'task_close',
];

/** Копия ключей профилей — `PRESETS` в `pult/lib/profiles.mjs`. */
const PRESET_KEYS = ['full', 'no-docs', 'checks-only'];

/** Копия `PENDING_REASONS` (`pult/config.mjs`) — семь слов, у каждого свой адрес назначения. */
const PENDING_REASONS = [
  'awaiting_approval', 'awaiting_acceptance', 'blocked', 'gate_blocked',
  'stop_product', 'stop_technical', 'stop_security',
];

/** Не прошло форму — не передаётся ВОВСЕ. */
function idOrNull(value, re) {
  if (typeof value !== 'string' || value.length === 0 || value.length > TASK_ID_MAX) return null;
  return re.test(value) ? value : null;
}

/** Не совпало со словарём — не передаётся ВОВСЕ. */
function wordOrNull(value, list) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 32) return null;
  return list.includes(value) ? value : null;
}

const refuse = (code) => Promise.resolve({ ok: false, code, message: 'мост отклонил параметр' });

// Приходящее из главного процесса проверяется по форме ДО передачи на страницу. Обработчик
// частью моста не является: он не выставлен наружу и позвать его со страницы нельзя.
//
// ТРЕТЬЕ ПОЛЕ — ПРИЧИНА ОЖИДАНИЯ из закрытого словаря семи слов: по ней страница выбирает,
// КУДА вести человека (уведомление обязано вести, а не просто разворачивать окно). Причина
// не прошла словарь — поле просто не едет, а сообщение уходит: адрес по умолчанию есть всегда.
ipcRenderer.on(CH_OPEN_TASK, (event, payload) => {
  const project = idOrNull(payload && payload.project, PROJECT_ID_RE);
  const task = idOrNull(payload && payload.task, TASK_ID_RE);
  if (!project || !task) return;
  const reason = wordOrNull(payload && payload.reason, PENDING_REASONS);
  window.postMessage({ kind: CH_OPEN_TASK, project, task, reason }, window.location.origin);
});

contextBridge.exposeInMainWorld('cckitShell', {
  present: true,
  openTaskMessage: CH_OPEN_TASK,

  /** Завести проект: БЕЗ ЕДИНОГО ПАРАМЕТРА — путь рождается в системном диалоге. */
  addProject: () => ipcRenderer.invoke(CH_ADD_PROJECT),

  /**
   * Запустить команду набора: идентификатор проекта известной формы и КЛЮЧ из словаря.
   * Аргументы команды здесь не участвуют и участвовать не могут — их знает только
   * `pult/shell/kit-commands.mjs`. Меняющие состояние ключи главный процесс исполнит
   * только после системного подтверждения.
   */
  runKitCommand: (projectId, key) => {
    const id = idOrNull(projectId, PROJECT_ID_RE);
    const k = wordOrNull(key, KIT_KEYS);
    if (!id || !k) return refuse('bad_params');
    return ipcRenderer.invoke(CH_KIT_RUN, { project: id, key: k });
  },

  /** Осмотреть выбранный в диалоге каталог: БЕЗ ПАРАМЕТРОВ — путь берётся из слота. */
  inspectProject: () => ipcRenderer.invoke(CH_DEPLOY_INSPECT),

  /** Разложить набор: единственный параметр — КЛЮЧ ПРОФИЛЯ из закрытого словаря. */
  deployKit: (preset) => {
    const p = wordOrNull(preset, PRESET_KEYS);
    if (!p) return refuse('bad_preset');
    return ipcRenderer.invoke(CH_DEPLOY_RUN, { preset: p });
  },

  /** Снять набор: единственный параметр — идентификатор проекта известной формы. */
  removeKit: (projectId) => {
    const id = idOrNull(projectId, PROJECT_ID_RE);
    if (!id) return refuse('bad_params');
    return ipcRenderer.invoke(CH_DEPLOY_REMOVE, { project: id });
  },
});
