#!/usr/bin/env node
/**
 * УВЕДОМЛЕНИЯ «ЗАДАЧА ЖДЁТ ЧЕЛОВЕКА»: опрос лёгкого маршрута демона, признак «уже сообщали»
 * и клик, открывающий задачу.
 *
 * ИНТЕРВАЛ — ОДНА МИНУТА, И ЧИСЛО ОБОСНОВАНО. Задача ждёт человека часами, а не секундами:
 * минута ничего не стоит по смыслу и не заставляет считать секунды. Цена названа честно —
 * каждый опрос читает состояния задач и приёмки ВСЕХ проектов реестра (до потолка задач
 * на проект), в живом реестре это единицы проектов и десятки мелких файлов. Обхода отпечатка
 * в маршруте нет и быть не должно: §2.8 контракта, пункт 6.
 *
 * ОПРОСЫ НЕ НАКЛАДЫВАЮТСЯ: следующий заводится ПОСЛЕ возврата предыдущего, а не по расписанию.
 * Первый — через несколько секунд после подъёма демона, чтобы не спорить со стартом страницы.
 *
 * ПРИЗНАК «ПРО ЭТО УЖЕ УВЕДОМЛЯЛИ» ЖИВЁТ В ПАМЯТИ ОБОЛОЧКИ — отображение «проект и задача →
 * причина, о которой сообщили». Пришла другая причина — уведомляем и запоминаем; запись
 * пропала из ответа — забываем, и повторный вход в то же ожидание уведомит снова.
 *
 * ПОЧЕМУ ПРИЗНАКА НЕТ НА ДИСКЕ: файл с ним стал бы ВТОРЫМ ИСТОЧНИКОМ ПРАВДЫ о состоянии
 * задачи — той болезнью, которую запрещает правило 1 раздела OVERVIEW контракта, — и, устарев,
 * гасил бы законное уведомление навсегда. Перезапуск оболочки признак не переживает НАМЕРЕННО:
 * оболочку перезапускает человек, он в этот момент за машиной, и одно уведомление «вот что вас
 * ждёт» при старте — верное приветствие состояния.
 *
 * ЧУЖОЙ СВОБОДНЫЙ ТЕКСТ (имя проекта, заголовок задачи) идёт в нативное уведомление ТОЛЬКО
 * ПОСЛЕ ОЧИСТКИ И ЭКРАНИРОВАНИЯ: на Windows текст уведомления собирается системой как XML,
 * и угловая скобка или амперсанд дают ТИХО НЕ ПОКАЗАННОЕ уведомление — то есть ошибку без
 * сообщения. Остаток назван честно: если платформенный слой экранирует ещё раз, человек
 * увидит `&amp;` вместо `&`. Это косметика, и она дешевле непоказанного уведомления.
 *
 * ДВЕ ЧЕСТНЫЕ ВЕТВИ ОТКАЗА:
 *   • маршрут ответил «не найдено» — значит демон снаружи старше оболочки. Опрос выключается,
 *     человек получает ОДНО заметное сообщение. Молчать нельзя: уведомления не придут никогда,
 *     и это неотличимо от «ничего не ждёт»;
 *   • нативное уведомление недоступно или не показалось (реальный случай на Windows
 *     у неупакованного приложения) — запасной путь через подсказку иконки трея.
 * Идентификатор приложения выставляется при старте В ЛЮБОМ СЛУЧАЕ.
 */

import process from 'node:process';

import { app, Notification } from 'electron';

import { PENDING_REASONS } from '../config.mjs';
import { capText } from '../lib/fs-safe.mjs';
import { getCapped } from './daemon.mjs';
import { setTrayTip } from './tray.mjs';

// --- константы: живут рядом с потребителем -----------------------------------

const POLL_MS = 60 * 1000;
const FIRST_POLL_MS = 5000;
const PENDING_TIMEOUT_MS = 5000;
const PENDING_MAX_BODY = 512 * 1024;

/** Потолки чужого свободного текста: свой у имени, свой у заголовка, свой короткий у подсказки. */
const NAME_MAX = 64;
const TITLE_MAX = 120;
const TIP_MAX = 100;

/** Возраст сверх этого считается несуразным: время задачи вписано руками и может быть любым. */
const AGE_SANE_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Идентификатор приложения для Windows. Без него у НЕУПАКОВАННОГО приложения уведомления
 * не показываются вовсе — а это неотличимо от «ничего не ждёт».
 */
const APP_ID = 'cckit.pult.shell';

/**
 * ПЕРЕВОД МАШИННОГО СЛОВА ЗДЕСЬ, А НЕ НА ДЕМОНЕ. Правило то же, что у кодов отказов
 * в разделе 1.5 контракта: текст живёт на стороне того, кто показывает его человеку.
 * Ключи — закрытый словарь `PENDING_REASONS` из `pult/config.mjs`.
 */
const REASON_TEXT = Object.freeze({
  awaiting_approval: 'план ждёт утверждения',
  awaiting_acceptance: 'ждёт приёмки человеком',
  blocked: 'задача заблокирована',
  gate_blocked: 'машинная приёмка заблокирована',
  stop_product: 'СТОП: продуктовый вопрос',
  stop_technical: 'СТОП: технический вопрос',
  stop_security: 'СТОП: вопрос безопасности',
});

const say = (s) => process.stdout.write(`[shell] ${s}\n`);

// Слово из словаря демона без перевода не пропадает молча — но и приложение не роняет:
// уведомление важнее стройности, поэтому здесь строка в журнал, а не исключение.
for (const reason of PENDING_REASONS) {
  if (!REASON_TEXT[reason]) say(`причина ожидания «${reason}» без человеческого перевода`);
}

// --- состояние ---------------------------------------------------------------

/** Отображение «проект и задача → причина, о которой уже сообщили». Только в памяти. */
const reported = new Map();

let timer = null;
let polling = false;
let disabled = false;
let hooks = { onOpenTask: () => {}, onShow: () => {} };

// --- текст -------------------------------------------------------------------

const XML_ESCAPE = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' });

/** Очистка и потолок — общие для уведомления и для подсказки трея. */
function clean(raw, limit) {
  return capText(raw == null ? '' : raw, limit).text;
}

/** То же плюс экранирование там, где текст собирается системой как XML. */
function forNotification(raw, limit) {
  const text = clean(raw, limit);
  if (process.platform !== 'win32') return text;
  return text.replace(/[&<>"']/g, (ch) => XML_ESCAPE[ch]);
}

/**
 * Возраст задачи. Время приходит помеченным как МЕСТНОЕ БЕЗ ЗОНЫ (`local-naive` — так его
 * пишет `stamp()` в `.claude/hooks/task.mjs`), и разбирается именно так. Получилось
 * отрицательное или несуразное — «возраст неизвестен», а не число наугад.
 */
function ageText(updated) {
  if (!updated || typeof updated.value !== 'string' || updated.kind !== 'local-naive') return 'возраст неизвестен';
  const stamp = Date.parse(updated.value.replace(' ', 'T'));
  if (!Number.isFinite(stamp)) return 'возраст неизвестен';
  const ms = Date.now() - stamp;
  if (ms < 0 || ms > AGE_SANE_MS) return 'возраст неизвестен';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  return `${Math.floor(hours / 24)} дн назад`;
}

/** Подсказка иконки: дешёвый постоянный индикатор и запасной канал сообщения. */
function tip(text) {
  setTrayTip(clean(text, TIP_MAX));
}

/** То же под другим именем — для сообщений о самой оболочке (см. `notifyShell()`). */
const tipText = tip;

// --- уведомление -------------------------------------------------------------

function notifyOne(item) {
  const project = (item && item.project) || {};
  const task = item && item.task;
  const reason = REASON_TEXT[item.reason] || item.reason;
  const parts = [reason, ageText(task && task.updated)];
  if (task && task.title) parts.unshift(forNotification(task.title, TITLE_MAX));
  const title = forNotification(project.name, NAME_MAX) || 'Пульт';
  const body = parts.join(' · ');

  if (!Notification.isSupported()) {
    say('нативные уведомления недоступны — сообщаю подсказкой трея');
    tip(`${clean(project.name, NAME_MAX)}: ${clean(reason, TIP_MAX)}`);
    return;
  }

  const note = new Notification({ title, body });
  // КЛИК: показать окно и попросить страницу открыть ту самую задачу — И СКАЗАТЬ, ПОЧЕМУ.
  //
  // ТРЕТЬЕ ПОЛЕ — МАШИННАЯ ПРИЧИНА ОЖИДАНИЯ, та самая, что уже пришла с лёгкого маршрута
  // и уже переведена человеку в текст уведомления выше. По ней страница выбирает АДРЕС
  // назначения: у ожидания утверждения, ожидания приёмки, блокировки, красной приёмки
  // и трёх видов стопа места решения РАЗНЫЕ (пункт 7 договора с фазой 4). Уведомление,
  // которое доводит до окна и бросает, решает меньшую половину задачи.
  //
  // Второго словаря причин здесь не заводится: наружу уходит машинное слово как есть,
  // а переводит его страница — тем же правилом, каким демон отдаёт коды, а не тексты.
  note.on('click', () => {
    hooks.onShow();
    if (task && task.id && project.id) hooks.onOpenTask(project.id, task.id, item.reason);
  });
  note.on('failed', () => {
    say('система не показала уведомление — сообщаю подсказкой трея');
    tip(`${clean(project.name, NAME_MAX)}: ${clean(reason, TIP_MAX)}`);
  });
  note.show();
  say(`уведомление: ${item.reason}`);
}

/** Одно заметное сообщение и выключение опроса: демон снаружи старше оболочки. */
function disableForOldDaemon() {
  disabled = true;
  const text = 'Демон снаружи не умеет отдавать ожидания — уведомления выключены';
  say(text);
  tip(text);
  if (Notification.isSupported()) {
    new Notification({ title: 'Пульт', body: `${text}. Перезапустите демон из этой версии пульта.` }).show();
  }
}

// --- опрос -------------------------------------------------------------------

function handle(body) {
  const list = Array.isArray(body && body.pending) ? body.pending : [];
  const seen = new Set();

  for (const item of list) {
    const project = item && item.project;
    const projectId = project && typeof project.id === 'string' ? project.id : null;
    const reason = item && typeof item.reason === 'string' ? item.reason : null;
    if (!projectId || !reason) continue;
    const taskId = item.task && typeof item.task.id === 'string' ? item.task.id : '';
    const key = `${projectId} ${taskId}`;
    seen.add(key);
    if (reported.get(key) === reason) continue;
    reported.set(key, reason);
    notifyOne(item);
  }

  // Запись пропала из ответа — забываем: повторный вход в то же ожидание уведомит снова.
  for (const key of [...reported.keys()]) {
    if (!seen.has(key)) reported.delete(key);
  }

  const cut = body && (body.pending_truncated || body.projects_truncated);
  tip(list.length ? `Ждут человека: ${list.length}${cut ? ' (список неполон)' : ''}` : 'Пульт: ничего не ждёт');
}

async function poll() {
  if (disabled || polling) return;
  polling = true;
  try {
    const res = await getCapped('/pending', { timeoutMs: PENDING_TIMEOUT_MS, maxBody: PENDING_MAX_BODY });
    if (!res.answered) { say('демон не ответил на опрос ожиданий — жду следующего круга'); return; }
    if (res.status === 404) { disableForOldDaemon(); return; }
    if (res.code !== 'ok') { say(`опрос ожиданий: ${res.code} (${res.status})`); return; }
    let body;
    try {
      body = JSON.parse(res.body);
    } catch {
      say('ответ маршрута ожиданий не разобрался');
      return;
    }
    handle(body);
  } finally {
    polling = false;
  }
}

/** Следующий круг заводится ПОСЛЕ возврата предыдущего — опросы не накладываются. */
function schedule(ms) {
  if (disabled) return;
  timer = setTimeout(async () => {
    await poll();
    schedule(POLL_MS);
  }, ms);
  if (timer.unref) timer.unref();
}

export function startNotify(options = {}) {
  hooks = {
    onOpenTask: options.onOpenTask || (() => {}),
    onShow: options.onShow || (() => {}),
  };
  // В ЛЮБОМ СЛУЧАЕ, до всякой ветви: без идентификатора приложения уведомления
  // у неупакованного приложения на Windows не показываются вовсе.
  app.setAppUserModelId(APP_ID);
  schedule(FIRST_POLL_MS);
}

/**
 * Разовое сообщение человеку — не про задачу, а про саму оболочку.
 *
 * Живёт здесь, а не в главном процессе, потому что здесь уже есть и проверка доступности
 * уведомлений, и запасной путь через подсказку трея: сообщение, которое некому показать,
 * ничем не лучше молчания.
 */
export function notifyShell(title, body, tip) {
  say(`сообщение человеку: ${body}`);
  if (!Notification.isSupported()) {
    if (tip) tipText(tip);
    return;
  }
  const note = new Notification({ title: forNotification(title, NAME_MAX), body: forNotification(body, TITLE_MAX * 2) });
  note.on('failed', () => { if (tip) tipText(tip); });
  note.show();
}

export function stopNotify() {
  disabled = true;
  if (timer) clearTimeout(timer);
  timer = null;
}
