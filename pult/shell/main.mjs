#!/usr/bin/env node
/**
 * ГЛАВНЫЙ ПРОЦЕСС ОБОЛОЧКИ: одно окно, границы поимённо, системный диалог выбора папки.
 *
 * Логики пульта здесь нет и не будет (§3.1 контракта): оболочка поднимает демон СИСТЕМНЫМ
 * Node (`pult/shell/daemon.mjs`), показывает его страницу, запускает готовый инструмент кита
 * для записи в реестр (`pult/shell/add-project.mjs`) и сообщает человеку. Реестр главный
 * процесс НЕ ТРОГАЕТ: пишет инструмент.
 *
 * ПОРЯДОК СТАРТА ЖЁСТКИЙ: замок единственного экземпляра → поднять или распознать демон →
 * создать окно → загрузить страницу. Ответ на порту не распознан как наш — ОКНО НЕ СОЗДАЁТСЯ
 * ВОВСЕ, человек видит причину: иначе в окне с мостом в главный процесс и системным диалогом
 * оказалась бы чужая страница.
 *
 * АДРЕС НИГДЕ НЕ ПИШЕТСЯ СТРОКОЙ. Он собирается из узла и порта `pult/config.mjs`
 * (`PULT_URL` в `pult/shell/daemon.mjs`), а разрешённые происхождения берутся из того же
 * файла: расхождение с белым списком дало бы 403 на каждый запрос окна.
 *
 * ОГОВОРКА ПРО ПЯТЬ МИНУТ, КОТОРУЮ НЕ НАДО «ЧИНИТЬ»: закрытие окна прячет его в трей,
 * а сессии псевдотерминала живут ещё пять минут после ухода клиента (`PTY_IDLE_MS`,
 * решение 2 человека). §2.8 контракта требует это УЧИТЫВАТЬ, а не лечить: сессия переживает
 * перезагрузку страницы намеренно.
 *
 * Константы оболочки живут рядом с потребителем; отдельного файла констант тонкой оболочке
 * не заводим.
 */

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, dialog, ipcMain } from 'electron';

import { ORIGIN_ALLOW } from '../config.mjs';
import { PULT_URL, ensureDaemon, getCapped, onDaemonGone, stopDaemon } from './daemon.mjs';
import { addProjectByPath } from './add-project.mjs';
import { KIT_COMMANDS, changesState, commandKey, runKitCommand } from './kit-commands.mjs';
import {
  deployFromSlot, dropSlot, inspectChosen, removeByProject, removeDryRun, slotView,
} from './deploy.mjs';
import { presetKey, presetTitle } from '../lib/profiles.mjs';
import { createTray, destroyTray } from './tray.mjs';
import { notifyShell, startNotify, stopNotify } from './notify.mjs';

// --- константы: живут рядом с потребителем -----------------------------------

const WINDOW = Object.freeze({ width: 1440, height: 900, minWidth: 900, minHeight: 600 });

/**
 * Имена каналов повторены в `pult/shell/preload.cjs`: предзагрузке в песочнице доступен
 * урезанный `require`, и общий модуль констант ей не импортировать. Меняешь здесь — меняй там.
 */
const CH_ADD_PROJECT = 'cckit-shell:add-project';
const CH_OPEN_TASK = 'cckit-shell:open-task';
const CH_KIT_RUN = 'cckit-shell:kit-run';
const CH_DEPLOY_INSPECT = 'cckit-shell:deploy-inspect';
const CH_DEPLOY_RUN = 'cckit-shell:deploy-run';
const CH_DEPLOY_REMOVE = 'cckit-shell:deploy-remove';

/** Форма идентификатора проекта — копия `PROJECT_ID_RE` (`pult/config.mjs`), как в мосте. */
const PROJECT_ID_RE = /^[0-9a-f]{8}$/;

/** Сколько ждём у демона имя задачи для окна подтверждения. */
const TASK_LOOKUP_MS = 1500;

/** Потолок имени в тексте окна подтверждения: диалог не место для чужого полотна текста. */
const TITLE_MAX = 120;

/** ОДИН ЗАПУСК НА КАНАЛ ЗА РАЗ: двойной клик не порождает второго процесса. */
let deployBusy = false;
let kitRunBusy = false;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(HERE, 'preload.cjs');

const say = (s) => process.stdout.write(`[shell] ${s}\n`);

/** Единственное окно; при отказе демона оно не создаётся вовсе. */
let win = null;

/** Пока диалог открыт, второй запрос отклоняется: сорвавшийся скрипт устроил бы череду окон. */
let dialogOpen = false;

/** Выход идёт одной дорогой: закрытие окна прячет его в трей, а не завершает приложение. */
let shuttingDown = false;

/**
 * ГОДЕН ЛИ ТРЕЙ КАК СПОСОБ ВЕРНУТЬСЯ И ВЫЙТИ. От этого — и только от этого — зависит, прячем
 * мы окно при закрытии или завершаем приложение.
 *
 * Находка человека 02.09.2026 (дефекты 1 и 3): значка в области уведомлений не видно, а окно
 * при закрытии всё равно пряталось. Приложение оставалось жить невидимым, и убить его можно
 * было только диспетчером задач. Причина связки прямая: обработчик `close` делал
 * `preventDefault()` плюс `hide()`, а `window-all-closed` пуст — значит трей был ЕДИНСТВЕННЫМ
 * выходом. Единственный выход, которого может не быть, — это не выход.
 */
let trayOk = false;

/** Про переезд в трей человеку говорится ОДИН раз: это новость, а не постоянный шум. */
let hidCount = 0;

/** Наш ли адрес. Сверяется ПРОИСХОЖДЕНИЕ целиком, а не приставка строки. */
function ourOrigin(target) {
  try {
    return ORIGIN_ALLOW.includes(new URL(target).origin);
  } catch {
    return false;
  }
}

/**
 * ГРАНИЦЫ ОКНА ПЕРЕЧИСЛЕНЫ ПОИМЁННО — здесь и в одном месте. Страница в окне Electron
 * остаётся обычным удалённым источником, и одна её дыра иначе масштабируется на всю машину.
 */
function createWindow() {
  const window = new BrowserWindow({
    width: WINDOW.width,
    height: WINDOW.height,
    minWidth: WINDOW.minWidth,
    minHeight: WINDOW.minHeight,
    show: false,
    title: 'Пульт',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,          // изоляция контекстов включена
      nodeIntegration: false,          // доступ к платформе со страницы выключен
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,                   // песочница включена
      webSecurity: true,               // ОСТАЁТСЯ ВКЛЮЧЁННЫМ
      webviewTag: false,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
    },
  });

  // ПЕРЕХВАТЫВАЕТСЯ НЕ ТОЛЬКО ПЕРЕХОД, НО И ПЕРЕАДРЕСАЦИЯ, И ПЕРЕХОД ВО ВЛОЖЕННОМ КАДРЕ.
  const guard = (event, target) => {
    if (ourOrigin(target)) return;
    event.preventDefault();
    say('переход за пределы страницы пульта отклонён');
  };
  window.webContents.on('will-navigate', guard);
  window.webContents.on('will-redirect', guard);
  window.webContents.on('will-frame-navigate', (event) => guard(event, event.url));

  // Открытие новых окон запрещается ЦЕЛИКОМ: разрешать нечего — внешнюю ссылку открывает трей
  // и только адресом из констант.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // ПРАВА ОТКЛОНЯЮТСЯ ОБОИМИ ОБРАБОТЧИКАМИ: запрос и проверка — разные точки, и страница,
  // спросившая через вторую, мимо первой пройдёт.
  const ses = window.webContents.session;
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);

  /**
   * ЗАКРЫТИЕ ОКНА ПРЯЧЕТ ЕГО В ТРЕЙ — НО ТОЛЬКО ЕСЛИ ЕСТЬ КУДА ВЕРНУТЬСЯ.
   *
   * Прятать окно в трей нужно ради §3.2: уведомления «задача ждёт человека» приходят, пока
   * приложение живо, а живёт оно после закрытия окна только так. Но если трей не годен
   * (`createTray()` вернул `ok: false`), пряталось бы в никуда — и приложение становилось бы
   * незакрываемым обычными средствами. Поэтому здесь развилка, а не безусловный `hide()`.
   *
   * Про переезд человеку говорится ОДИН раз, и это не украшение: «значка не видно» и «значок
   * в переполнении у часов» для кода неразличимы, а для человека — совсем разные вещи.
   * Сообщение превращает невидимое состояние в названное.
   */
  window.on('close', (event) => {
    if (shuttingDown) return;
    if (!trayOk) {
      say('трей негоден — закрытие окна завершает приложение, прятать его некуда');
      shutdown(0);
      return;
    }
    event.preventDefault();
    window.hide();
    hidCount += 1;
    say('окно спрятано в трей; демон и сессии продолжают жить');
    if (hidCount === 1) {
      notifyShell(
        'Пульт свернулся в значок',
        'Окно закрыто, но пульт продолжает работать: значок в области уведомлений у часов'
        + ' (может быть спрятан под стрелкой «Отображать скрытые значки»). Выход — из меню значка.',
        'Пульт свёрнут в значок у часов',
      );
    }
  });

  // СБРОС СЛОТА ВЫБРАННОГО ПУТИ — ПО ДВУМ ПОИМЁННО НАЗВАННЫМ СОБЫТИЯМ, и оба означают
  // «человек ушёл от мастера»: окно скрыто (свёрнуто в значок) и страница перезагружена.
  //
  // СОБСТВЕННЫЕ СИСТЕМНЫЕ ОКНА ИЗ СПИСКА ИСКЛЮЧЕНЫ НАМЕРЕННО. Диалог выбора каталога
  // и окно подтверждения забирают фокус сами, поэтому сброс «по любой потере фокуса»
  // отказывал бы сразу после выбора папки — а первым же «лечением» сняли бы сам сброс
  // и слот пережил бы всё. Поэтому здесь нет ни 'blur', ни 'focus'.
  window.on('hide', () => dropSlot('окно скрыто'));
  window.webContents.on('did-start-navigation', (_e, _url, _inPage, isMainFrame) => {
    if (isMainFrame) dropSlot('страница перезагружена');
  });

  window.once('ready-to-show', () => window.show());
  window.webContents.on('did-fail-load', (_e, code, description) => {
    say(`страница не загрузилась: ${code} ${description}`);
  });

  window.loadURL(PULT_URL);
  return window;
}

/** Показать окно человеку: из трея, со второго запуска и по клику на уведомлении. */
export function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * Событие «открыть задачу» уходит на страницу через мост; больше его не получает никто.
 *
 * ТРЕТЬЕ ПОЛЕ — ПРИЧИНА ОЖИДАНИЯ, машинное слово из закрытого списка `PENDING_REASONS`.
 * Форму его проверяет мост (`pult/shell/preload.cjs`) перед передачей на страницу: не прошло
 * словарь — поле просто не едет, а сообщение уходит, и человек попадает на карточку задачи.
 */
export function sendOpenTask(projectId, taskId, reason) {
  if (!win) return;
  win.webContents.send(CH_OPEN_TASK, { project: projectId, task: taskId, reason });
}

/**
 * ОБРАБОТЧИК «ЗАВЕСТИ ПРОЕКТ».
 *
 * ПРЯМОЕ ПРАВИЛО: ОБРАБОТЧИК НЕ ЧИТАЕТ ИЗ СООБЩЕНИЯ СТРАНИЦЫ НИЧЕГО — НИ ПУТИ, НИ ЕГО ЧАСТИ,
 * НИ НАЧАЛЬНОГО КАТАЛОГА. Полезной нагрузки у этого сообщения нет ПО ПОСТРОЕНИЮ: у функции
 * объявлен один параметр — событие, и второго не будет. Причина та же, что записана в шапке
 * `pult/shell/preload.cjs`: единственный источник пути — системный диалог, и именно на этом
 * держится свойство, ради которого в круге 1 аудита снят маршрут записи в реестр.
 *
 * Путь никуда не склеивается — ни в командную строку оболочки, ни в адрес: он уходит одним
 * позиционным аргументом инструмента, и отсюда сохранность пробелов и кириллицы.
 */
/**
 * ОТПРАВИТЕЛЬ СВЕРЯЕТСЯ У КАЖДОГО КАНАЛА: это обязан быть ГЛАВНЫЙ КАДР НАШЕГО ОКНА и его
 * происхождение. Отсутствующий или неопознанный кадр — ОТКАЗ, а не пропуск.
 *
 * Функция общая, а не скопированная в каждый обработчик: копии разошлись бы при первой
 * правке, и разошлись бы МОЛЧА — отказ виден только тому, кто его пробует.
 */
function fromOurPage(event) {
  let frame = null;
  try {
    frame = event.senderFrame;
  } catch {
    frame = null;
  }
  const sameWindow = Boolean(win) && event.sender === win.webContents;
  const mainFrame = Boolean(frame) && frame.parent === null;
  return sameWindow && mainFrame && ourOrigin(frame.origin);
}

ipcMain.handle(CH_ADD_PROJECT, async (event) => {
  if (!fromOurPage(event)) {
    say('запрос «завести проект» пришёл не от главного кадра нашего окна — отказ');
    return { ok: false, code: 'bad_sender', message: 'запрос пришёл не от страницы пульта' };
  }

  if (dialogOpen) {
    return { ok: false, code: 'dialog_busy', message: 'диалог выбора папки уже открыт' };
  }
  dialogOpen = true;
  let picked;
  try {
    // Начальный каталог НЕ ЗАДАЁТСЯ намеренно: подсказка начального каталога — это и есть
    // «часть пути со страницы», которой здесь быть не должно.
    picked = await dialog.showOpenDialog(win, {
      title: 'Выберите папку проекта',
      buttonLabel: 'Завести проект',
      properties: ['openDirectory'],
    });
  } finally {
    dialogOpen = false;
  }
  if (picked.canceled || !picked.filePaths.length) return { cancelled: true };

  // Выбранный путь уходит инструменту и НА СТРАНИЦУ НЕ ВОЗВРАЩАЕТСЯ НИКОГДА: наружу идёт
  // только идентификатор проекта либо текст отказа инструмента.
  return addProjectByPath(picked.filePaths[0]);
});

/**
 * ИМЯ ПРОЕКТА И АКТИВНОЙ ЗАДАЧИ ДЛЯ ОКНА ПОДТВЕРЖДЕНИЯ — СПРАШИВАЮТСЯ У ДЕМОНА.
 *
 * Оболочка файлов проекта не читает (§3.1 контракта), и ради текста в диалоге это правило
 * не нарушается: имя задачи берётся тем же лёгким чтением, каким уведомления спрашивают
 * ожидания. Демон не ответил — окно подтверждения показывается всё равно, просто без имени:
 * подтверждение важнее украшения.
 */
async function projectTitles(projectId) {
  const empty = { project: null, task: null };
  const res = await getCapped(`/projects/${projectId}`, { timeoutMs: TASK_LOOKUP_MS });
  if (!res.answered || res.code !== 'ok') return empty;
  let body = null;
  try {
    body = JSON.parse(res.body);
  } catch {
    return empty;
  }
  if (!body || typeof body !== 'object') return empty;
  const cut = (v) => (typeof v === 'string' && v ? v.slice(0, TITLE_MAX) : null);
  const task = body.active_task && typeof body.active_task === 'object' ? body.active_task : null;
  return { project: cut(body.name), task: cut(task && (task.title || task.id)) };
}

/**
 * ОБРАБОТЧИК «ЗАПУСТИТЬ КОМАНДУ НАБОРА».
 *
 * Порядок жёсткий, и каждый пункт закрывает свою дыру:
 *   1. отправитель — главный кадр нашего окна (иначе отказ);
 *   2. ПАРАМЕТРЫ ПРОВЕРЯЮТСЯ ЗАНОВО. Мост живёт в одном процессе со страницей, то есть его
 *      проверки — удобство, а не граница; границей они становятся только здесь;
 *   3. один запуск за раз: двойной клик не порождает второго процесса;
 *   4. МЕНЯЮЩИЙ СОСТОЯНИЕ КЛЮЧ — СИСТЕМНОЕ ПОДТВЕРЖДЕНИЕ с названием проекта и задачи.
 *      Без него страница переводила бы статусы и закрывала задачи в любом проекте реестра
 *      БЕЗЗВУЧНО — та же симметрия, что у раскладки и сноса;
 *   5. запуск — модулем `pult/shell/kit-commands.mjs`, корень берётся им из реестра
 *      по идентификатору. Путь проекта СЮДА не приходит и НАРУЖУ не уходит.
 *
 * Наружу идут код возврата и два потока — очищенные и обрезанные, но не пересказанные
 * (§4.6 контракта: вывод показывается как есть).
 */
ipcMain.handle(CH_KIT_RUN, async (event, payload) => {
  if (!fromOurPage(event)) {
    say('запрос «команда набора» пришёл не от главного кадра нашего окна — отказ');
    return { ok: false, code: 'bad_sender', message: 'запрос пришёл не от страницы пульта' };
  }

  const projectId = payload && typeof payload.project === 'string' ? payload.project : '';
  const key = commandKey(payload && payload.key);
  if (!PROJECT_ID_RE.test(projectId) || !key) {
    return { ok: false, code: 'bad_params', message: 'параметр не той формы или ключ неизвестен' };
  }

  if (kitRunBusy) {
    return { ok: false, code: 'run_busy', message: 'команда набора уже выполняется' };
  }
  kitRunBusy = true;
  try {
    if (changesState(key)) {
      const titles = await projectTitles(projectId);
      const command = KIT_COMMANDS[key];
      const answer = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Отмена', 'Выполнить'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: 'Команда набора меняет состояние',
        message: `${command.title}`,
        detail: [
          `Проект: ${titles.project || 'без имени'}`,
          `Задача: ${titles.task || 'не определена'}`,
          '',
          'Команда пишет на диск проекта. Отмена ничего не меняет.',
        ].join('\n'),
      });
      if (answer.response !== 1) {
        say(`команда набора «${key}» отменена человеком`);
        return { ok: false, code: 'cancelled', message: 'отменено человеком' };
      }
    }

    // ПРИЗНАК ПОДТВЕРЖДЕНИЯ СТАВИТ ГЛАВНЫЙ ПРОЦЕСС, и только он: со страницы он не приходит
    // ни в каком виде. Читающие ключи проходят без него — им нечего подтверждать.
    return await runKitCommand(projectId, key, { confirmed: true });
  } finally {
    kitRunBusy = false;
  }
});

/**
 * ДИАЛОГ ВЫБОРА КАТАЛОГА — ЕДИНСТВЕННЫЙ ИСТОЧНИК ПУТИ У МАСТЕРА.
 *
 * Начальный каталог НЕ ЗАДАЁТСЯ: подсказка начального каталога — это и есть «часть пути
 * со страницы», которой здесь быть не должно. Пока диалог открыт, второй запрос отклоняется.
 */
async function pickDirectory(title, buttonLabel) {
  if (dialogOpen) return null;
  dialogOpen = true;
  let picked;
  try {
    picked = await dialog.showOpenDialog(win, {
      title,
      buttonLabel,
      properties: ['openDirectory'],
    });
  } finally {
    dialogOpen = false;
  }
  if (!picked || picked.canceled || !picked.filePaths.length) return null;
  return picked.filePaths[0];
}

/**
 * ОСМОТР КАТАЛОГА (§4.2, правило 2: показать, что нашлось, ДО раскладки).
 *
 * Полезной нагрузки у этого сообщения нет по построению: у обработчика объявлен один
 * параметр — событие. Путь рождается в диалоге и уезжает на страницу ТОЛЬКО в отчёте:
 * человеку надо видеть, куда ставим, а НАЗНАЧИТЬ каталог страница не может.
 */
ipcMain.handle(CH_DEPLOY_INSPECT, async (event) => {
  if (!fromOurPage(event)) {
    say('запрос «осмотреть каталог» пришёл не от главного кадра нашего окна — отказ');
    return { ok: false, code: 'bad_sender', message: 'запрос пришёл не от страницы пульта' };
  }
  if (deployBusy) {
    return { ok: false, code: 'run_busy', message: 'мастер уже занят' };
  }
  deployBusy = true;
  try {
    return await inspectChosen(() => pickDirectory('Выберите папку проекта', 'Осмотреть'));
  } finally {
    deployBusy = false;
  }
});

/**
 * РАСКЛАДКА. Единственный параметр — КЛЮЧ ПРОФИЛЯ из закрытого словаря; путь берётся
 * из слота главного процесса.
 *
 * ОБРАБОТЧИК НЕ ЧИТАЕТ ИЗ СООБЩЕНИЯ СТРАНИЦЫ ПУТИ НИ В КАКОМ ВИДЕ. Пришедшая полезная
 * нагрузка сверх ключа игнорируется целиком: ни одно её поле ниже не читается.
 *
 * ПОДТВЕРЖДЕНИЕ ОБЯЗАТЕЛЬНО — симметрично сносу и меняющим командам набора: раскладка
 * пишет в чужой проект, и страница не имеет права начать её беззвучно.
 */
ipcMain.handle(CH_DEPLOY_RUN, async (event, payload) => {
  if (!fromOurPage(event)) {
    say('запрос «развернуть набор» пришёл не от главного кадра нашего окна — отказ');
    return { ok: false, code: 'bad_sender', message: 'запрос пришёл не от страницы пульта' };
  }
  const preset = presetKey(payload && payload.preset);
  if (!preset) {
    return { ok: false, code: 'bad_preset', message: 'профиль бывает только из закрытого словаря' };
  }
  const state = slotView();
  if (!state.chosen) {
    return { ok: false, code: 'slot_empty', message: 'каталог не выбран или выбор устарел — начните с осмотра' };
  }
  if (deployBusy) {
    return { ok: false, code: 'run_busy', message: 'мастер уже занят' };
  }
  deployBusy = true;
  try {
    const answer = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Отмена', 'Развернуть'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Развернуть набор в проект',
      message: `Профиль: ${presetTitle(preset)}`,
      detail: [
        `Каталог: ${state.chosen}`,
        '',
        'Папка набора будет скопирована в соседнюю .claude.backup-<дата> ДО первой записи.',
        'Существующие файлы не перезаписываются: всё пропущенное будет перечислено.',
      ].join('\n'),
    });
    if (answer.response !== 1) {
      say('раскладка отменена человеком');
      return { ok: false, code: 'cancelled', message: 'отменено человеком' };
    }
    return await deployFromSlot(preset);
  } finally {
    deployBusy = false;
  }
});

/**
 * СНОС. Единственный параметр — идентификатор проекта; корень берётся из реестра.
 *
 * ЧИСЛО УДАЛЯЕМЫХ ФАЙЛОВ В ОКНЕ ПОДТВЕРЖДЕНИЯ БЕРЁТСЯ ИЗ СУХОГО ПРОГОНА, а не считается
 * здесь: два счётчика разошлись бы, и человек подтверждал бы одно, а получал другое.
 * Сухой прогон ничего не пишет — он проходит тем же шлюзом в режиме удаления.
 */
ipcMain.handle(CH_DEPLOY_REMOVE, async (event, payload) => {
  if (!fromOurPage(event)) {
    say('запрос «снять набор» пришёл не от главного кадра нашего окна — отказ');
    return { ok: false, code: 'bad_sender', message: 'запрос пришёл не от страницы пульта' };
  }
  const projectId = payload && typeof payload.project === 'string' ? payload.project : '';
  if (!PROJECT_ID_RE.test(projectId)) {
    return { ok: false, code: 'bad_params', message: 'идентификатор проекта не той формы' };
  }
  if (deployBusy) {
    return { ok: false, code: 'run_busy', message: 'мастер уже занят' };
  }
  deployBusy = true;
  try {
    const dry = await removeDryRun(projectId);
    if (dry.ok === false && dry.code) return dry;
    const answer = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Отмена', 'Снять набор'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Снять набор, разложенный пультом',
      message: `Проект: ${dry.name || projectId}`,
      detail: [
        `Будет удалено файлов: ${dry.removed}. Перечень — в сухом прогоне инструмента.`,
        'Файлы, которые пульт не клал, остаются на месте.',
        'Память проекта не трогается: папки задач, журнал событий и история.',
      ].join('\n'),
    });
    if (answer.response !== 1) {
      say('снос отменён человеком');
      return { ok: false, code: 'cancelled', message: 'отменено человеком' };
    }
    return await removeByProject(projectId);
  } finally {
    deployBusy = false;
  }
});

/**
 * Выход: гасится ТОЛЬКО свой демон, чужой не трогается никогда.
 *
 * ДОРОГА К ВЫХОДУ ОДНА, И ГОЛОГО `app.exit()` рядом с ней быть не должно: `app.exit()`
 * НЕ поднимает `before-quit`, то есть проходит мимо останова демона (находка 7 ревью
 * 02.09.2026). Код возврата — параметром, чтобы отказ старта уходил не нулём и всё равно
 * этой же дорогой.
 */
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopNotify();
  destroyTray();
  await stopDaemon();
  app.exit(code);
}

// --- старт -------------------------------------------------------------------

// ЗАМОК ЕДИНСТВЕННОГО ЭКЗЕМПЛЯРА — ПЕРВОЙ СТРОКОЙ: две оболочки дрались бы за порт и за
// владение демоном.
if (!app.requestSingleInstanceLock()) {
  // ЕДИНСТВЕННОЕ ЗАКОННОЕ МЕСТО ГОЛОГО `app.exit()`: этот экземпляр не поднимал ни демона,
  // ни окна и убирать за собой ему нечего — окно показал первый.
  app.exit(0);
} else {
  app.on('second-instance', () => showWindow());
  app.on('before-quit', (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    shutdown();
  });
  // ОКНО ЖИВЁТ В ТРЕЕ, ПОКА ТРЕЙ ГОДЕН. Если окно закрылось по-настоящему (трей негоден —
  // см. развилку в `close`), приложению больше нечего показывать и незачем жить: пустой
  // обработчик здесь и был второй половиной связки, делавшей пульт незакрываемым.
  app.on('window-all-closed', () => {
    if (shuttingDown) return;
    say('окон не осталось и трей негоден — завершаюсь');
    shutdown(0);
  });

  app.whenReady().then(async () => {
    const daemon = await ensureDaemon();
    if (!daemon.ok) {
      say(`окно не открываю: ${daemon.code}`);
      // Свой демон, если он всё-таки успел подняться, погашен уже в `ensureDaemon()` —
      // кто поднял, тот и убирает. Выход всё равно идёт общей дорогой: она переживёт
      // появление ветви, о которой здесь забудут.
      dialog.showErrorBox('Пульт не запустился', daemon.message);
      await shutdown(1);
      return;
    }
    win = createWindow();

    // ТРЕЙ ЗАВОДИТСЯ ДО ПЕРВОГО ЗАКРЫТИЯ ОКНА, и его отчёт запоминается: развилка в `close`
    // спрашивает именно этот признак, а не наличие объекта.
    const tray = createTray({ onShow: showWindow, onQuit: () => app.quit() });
    trayOk = tray.ok;
    say(trayOk
      ? 'трей заведён; закрытие окна прячет пульт в значок'
      : `трей негоден (${tray.error ? tray.error : 'пустая иконка'}) — закрытие окна завершит приложение`);

    startNotify({ onOpenTask: sendOpenTask, onShow: showWindow });

    // СВОЙ ДЕМОН УШЁЛ САМ — человеку говорится словами. Без этого окно выглядит живым,
    // а страница отвечает «нет связи» на каждое действие (находка человека, дефект 2).
    onDaemonGone(({ code }) => {
      notifyShell(
        'Пульт: демон остановился',
        `Демон пульта завершился (код ${code}). Страница больше ничего не прочитает:`
        + ' закройте пульт и запустите заново.',
        'Демон пульта остановился',
      );
    });

    say(`окно открыто на ${PULT_URL}`);
  });
}
