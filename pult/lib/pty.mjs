#!/usr/bin/env node
/**
 * Хозяйство сессий псевдотерминала: подъём, буфер, потолки, пять минут без клиента.
 *
 * ЧТО ЗДЕСЬ ГЛАВНОЕ. За этим модулем стоит ОБОЛОЧКА МАШИНЫ, поэтому клиент не присылает
 * ни команды, ни аргументов, ни рабочего каталога: он присылает СЛОВО вида сессии, а всё
 * остальное вычисляется на демоне из констант (`PTY_KINDS` в `pult/config.mjs`) и из записи
 * реестра.
 *
 * КОМАНДА РАЗРЕШАЕТСЯ ДВЕРЬЮ `resolveCommand()` в `pult/lib/fs-safe.mjs` — один раз на вид
 * сессии, и берётся ФОРМА ЗАПУСКА ЦЕЛИКОМ, а не одно её поле. На машине с командным файлом
 * (`.cmd`, `.bat`) в поле файла лежит `cmd.exe`, а сам исполняемый файл вместе с ключами
 * `/d /s /c` — в аргументах: `CreateProcess`, а значит и conpty внутри `node-pty`, командный
 * файл напрямую не запускает.
 *
 * ЗАПРЕТ, КОТОРЫЙ НЕЛЬЗЯ ЗАБЫТЬ. Увидев, что сессия не поднимается, НЕЛЬЗЯ заменять форму
 * на `cmd /c claude`: запуск по ИМЕНИ возвращает подмену через рабочий каталог, а рабочий
 * каталог у сессии чужой — подложенные туда `claude.exe`, `node.exe` или `cmd.exe`
 * выполнились бы вместо системных. Четыре лечения этой стены (одно верное, три запрещённых)
 * перечислены в докблоке `resolveCommand()` там же; свои изобретать не надо.
 *
 * СТРОКА ПРОТИВ МАССИВА. В ветви командного файла аргументы уезжают в `node-pty` СТРОКОЙ
 * (`argline` из формы): библиотека принимает обе формы, но массив приводит каждый элемент
 * по правилам MSVCRT, и наш собственный закавыченный путь превратился бы
 * в `"\"C:\...\claude.cmd\""` — `cmd.exe` командного файла не находит, и сессия не поднимается.
 *
 * ОКРУЖЕНИЕ — СЕССИОННОЕ (`sessionEnv()`), не служебное: человеку в терминале нужен рабочий
 * `git commit` с его `user.name` и `credential.helper`, PowerShell с модулями и корпоративный
 * прокси. Поэтому здесь наследование МИНУС закрытый список, а ужесточение git сюда
 * не попадает — иначе `git commit` внутри пульта падает «Author identity unknown», а лечат
 * это наследованием окружения целиком.
 *
 * `CCKIT_*` из списка вычищаемых не уходит НИКОГДА: демон, запущенный человеком из терминала
 * с выставленной `CCKIT_GATE=off` (штатный ремонтный приём из `CUSTOMIZE.md`), иначе раздал бы
 * её всем сессиям пульта, и каждая завершала бы ход без машинной приёмки — `decide()`
 * в `.claude/hooks/gate.mjs` читает эту переменную первой строкой. Правило 3 раздела OVERVIEW
 * контракта говорит обратное: пульт не снимает остановку «СТОП».
 *
 * РАБОЧИЙ КАТАЛОГ — КОРЕНЬ ПРОЕКТА ИЗ ЗАПИСИ РЕЕСТРА, И НИКОГДА `<root>/.claude`. Прецедент
 * §0.2 контракта: сессию запустили с рабочим каталогом папки набора, настройки искались
 * этажом ниже (`.claude/.claude/settings.json`), и все хуки молчали весь день. Отказ по имени
 * каталога стоит здесь машинно — это дешевле, чем полагаться на то, что вызывающий не ошибётся.
 *
 * БУФЕР — ОСОЗНАННОЕ ИСКЛЮЧЕНИЕ из правила 1.3 контракта («ничего не кэшировать»), и граница
 * исключения такая: буфер хранит ВЫВОД ЖИВОГО ПРОЦЕССА, а не факты о проекте с диска. Ни
 * версия, ни отпечаток, ни задачи, ни статусы в нём не оседают, и смерть сессии он не
 * переживает — вместе с процессом уходит и он.
 *
 * ПЯТЬ МИНУТ. Отключение последнего клиента не убивает сессию, а взводит таймер (решение 2
 * человека): человек закрыл вкладку по ошибке или уснул ноутбук — вернувшись, он получает
 * тот же процесс и последний экран из буфера. Переподключение таймер снимает.
 *
 * `node-pty` подключается ЛЕНИВО и под `try`: это нативный модуль, готовых сборок под Linux
 * у апстрима нет (риск 8 плана фазы 2), и отсутствие модуля обязано давать код отказа
 * «сессия не поднялась», а не падение демона на импорте.
 */

import path from 'node:path';
import process from 'node:process';
import { randomBytes } from 'node:crypto';

import { resolveCommand, sessionEnv, realPath, statSafe } from './fs-safe.mjs';
import {
  FAULT, PTY_KINDS, PTY_IDLE_MS, PTY_BUFFER_BYTES, MAX_SESSIONS, MAX_SESSIONS_PER_PROJECT,
  MAX_PTY_INPUT, MAX_COLS, MAX_ROWS,
} from '../config.mjs';

/** Живые сессии: идентификатор — сессия. Между запросами живёт ПРОЦЕСС, а не факты о проекте. */
const sessions = new Map();

/**
 * Формы запуска по видам сессии: ключа нет — ещё не искали, `null` — искали и не нашли.
 * Ищется один раз на вид: это расположение системной программы, а не что-либо, прочитанное
 * из чужого дерева, — правилу 1.3 контракта такая память не противоречит.
 */
const forms = new Map();

/** Модуль псевдотерминала: `undefined` — не грузили, `null` — не грузится на этой машине. */
let ptyModule;

async function loadPty() {
  if (ptyModule === undefined) {
    try {
      ptyModule = await import('node-pty');
    } catch {
      ptyModule = null;
    }
  }
  return ptyModule;
}

/** Форма запуска вида сессии. Не разрешилось — `null`, и вызывающий отдаёт код отказа. */
async function kindForm(kind) {
  if (!forms.has(kind)) {
    const spec = PTY_KINDS[kind];
    forms.set(kind, spec ? await resolveCommand(spec.command, { args: [...spec.args] }) : null);
  }
  return forms.get(kind);
}

/** Целое в границах: клиентские числа приходят чем угодно, включая строкой и дробью. */
function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/**
 * Кольцевой буфер вывода: куски как есть, суммарный объём под потолком.
 *
 * Куски хранятся строками, а меряются БАЙТАМИ: потолок задан в байтах, и считать его
 * в символах значило бы держать втрое больше памяти на кириллице.
 */
function makeBuffer(limit) {
  const chunks = [];
  let bytes = 0;
  return {
    push(chunk) {
      const size = Buffer.byteLength(chunk, 'utf8');
      chunks.push({ chunk, size });
      bytes += size;
      while (bytes > limit && chunks.length > 1) bytes -= chunks.shift().size;
    },
    text() {
      return chunks.map((c) => c.chunk).join('');
    },
  };
}

/**
 * Поднять сессию — или вернуть уже живую того же проекта и вида.
 *
 * ПЕРЕПОДКЛЮЧЕНИЕ ЗДЕСЬ, А НЕ У МОСТА: вернувшийся клиент обязан получить ТОТ ЖЕ процесс,
 * иначе таймер пяти минут теряет смысл — он держит процесс ради возврата, а возврат поднимал
 * бы второй.
 *
 * Возвращается либо САМА СЕССИЯ (`ok: true`), либо отказ `{ok:false, code}` с кодом
 * из закрытого словаря.
 *
 * @param {object} options `projectPath` — корень проекта ИЗ ЗАПИСИ РЕЕСТРА; `projectId` —
 *                         идентификатор проекта (для потолка на проект и для следа);
 *                         `kind` — слово из `PTY_KINDS`; `cols`, `rows` — размер окна.
 */
export async function open(options = {}) {
  const kind = typeof options.kind === 'string' ? options.kind : '';
  if (!Object.prototype.hasOwnProperty.call(PTY_KINDS, kind)) {
    return { ok: false, code: FAULT.UNKNOWN_SESSION_KIND };
  }
  const projectId = typeof options.projectId === 'string' ? options.projectId : '-';

  // Рабочий каталог: канонизируется и проверяется ДО подъёма. Папка набора рабочим каталогом
  // сессии не бывает никогда — прецедент §0.2 контракта.
  const rootReal = await realPath(String(options.projectPath == null ? '' : options.projectPath));
  if (!rootReal.ok) return { ok: false, code: FAULT.PATH_UNREACHABLE };
  const cwd = rootReal.path;
  const st = await statSafe(cwd);
  if (!st.ok || !st.stat.isDirectory()) return { ok: false, code: FAULT.PATH_UNREACHABLE };
  if (path.basename(cwd) === '.claude') return { ok: false, code: FAULT.SESSION_FAILED };

  // Живая сессия того же проекта и вида — это переподключение, а не новая сессия.
  //
  // В ключ переиспользования входит и РАБОЧИЙ КАТАЛОГ, хотя через мост идентификатор всегда
  // приходит из записи реестра и одного его хватало бы. Причина в умолчании `'-'`: прямой
  // вызов `open({ projectPath })` без идентификатора (так зовут проверки и примеры) склеил бы
  // РАЗНЫЕ проекты в одну сессию с общим буфером. Каталог здесь уже канонизирован, поэтому
  // сверка не разъезжается на симлинках и коротких именах, а вернувшийся клиент того же
  // проекта получает тот же процесс, как и раньше (замечание ревью фазы 2).
  for (const s of sessions.values()) {
    if (s.projectId === projectId && s.kind === kind && s.cwd === cwd && s.alive) return s;
  }

  if (sessions.size >= MAX_SESSIONS) return { ok: false, code: FAULT.SESSION_LIMIT };
  let own = 0;
  for (const s of sessions.values()) if (s.projectId === projectId) own += 1;
  if (own >= MAX_SESSIONS_PER_PROJECT) return { ok: false, code: FAULT.SESSION_LIMIT };

  const form = await kindForm(kind);
  if (!form) return { ok: false, code: FAULT.EXEC_NOT_ALLOWED };
  const mod = await loadPty();
  if (!mod) return { ok: false, code: FAULT.SESSION_FAILED };

  const cols = clampInt(options.cols, 20, MAX_COLS, 80);
  const rows = clampInt(options.rows, 5, MAX_ROWS, 24);

  // ФОРМА БЕРЁТСЯ ЦЕЛИКОМ И НЕ ПЕРЕСОБИРАЕТСЯ. Аргументы вида сессии — константы, они уже
  // вложены в форму дверью; `withArgs()` нужен там, где аргументы у каждого вызова свои
  // (так работает `pult/lib/git.mjs`), и здесь его вызов был бы пересборкой формы по частям.
  //
  // В ветви командного файла аргументы уезжают СТРОКОЙ (`argline`) — ровно той, которую собрал
  // `cmdForm()` в `pult/lib/fs-safe.mjs`, с нашими кавычками. Массив здесь не работает:
  // `node-pty` приводит каждый элемент по правилам MSVCRT, и наш закавыченный путь превратился
  // бы в `"\"C:\...\claude.cmd\""`.
  const args = form.shellFile === true ? form.argline : form.args;

  let proc;
  try {
    proc = mod.spawn(form.file, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: sessionEnv(),
    });
  } catch {
    return { ok: false, code: FAULT.SESSION_FAILED };
  }

  const id = randomBytes(8).toString('hex');
  const buffer = makeBuffer(PTY_BUFFER_BYTES);
  const listeners = new Set();
  const exits = new Set();
  let clients = 0;
  let idleTimer = null;

  const session = {
    ok: true,
    code: null,
    id,
    kind,
    projectId,
    cwd,
    alive: true,

    /** Последний экран: он же отдаётся вернувшемуся клиенту. */
    buffer() {
      return buffer.text();
    },

    /** Ввод от человека. Длиннее потолка не пишется вовсе — обрезать чужой ввод нельзя. */
    write(data) {
      if (!session.alive || typeof data !== 'string') return false;
      if (Buffer.byteLength(data, 'utf8') > MAX_PTY_INPUT) return false;
      try {
        proc.write(data);
      } catch {
        return false;
      }
      return true;
    },

    resize(nextCols, nextRows) {
      if (!session.alive) return;
      try {
        proc.resize(clampInt(nextCols, 20, MAX_COLS, cols), clampInt(nextRows, 5, MAX_ROWS, rows));
      } catch { /* процесс уже умер — размер ему не нужен */ }
    },

    // ПАРА «ПРИОСТАНОВИТЬ/ПРОДОЛЖИТЬ» нужна обратному давлению моста: без неё `yes`
    // в терминале при медленном клиенте выедает память демона, а кольцевой буфер здесь
    // не помогает — он про переподключение, а не про живой поток.
    pause() {
      try { proc.pause(); } catch { /* уже умер */ }
    },
    resume() {
      try { proc.resume(); } catch { /* уже умер */ }
    },

    onData(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onExit(fn) {
      exits.add(fn);
      return () => exits.delete(fn);
    },

    /** Клиент подключился: таймер снимается, сессия снова кому-то нужна. */
    attach() {
      clients += 1;
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      return session;
    },

    /** Последний клиент ушёл — процесс живёт ещё пять минут (решение 2 человека). */
    detach() {
      clients = Math.max(0, clients - 1);
      if (clients > 0 || !session.alive) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => session.kill(), PTY_IDLE_MS);
      // Таймер не держит цикл событий: демон, которому больше нечего делать, обязан гаснуть.
      if (typeof idleTimer.unref === 'function') idleTimer.unref();
    },

    kill() {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      if (!session.alive) return;
      session.alive = false;
      sessions.delete(id);
      try { proc.kill(); } catch { /* уже умер */ }
    },
  };

  proc.onData((chunk) => {
    buffer.push(chunk);
    for (const fn of listeners) {
      try { fn(chunk); } catch { /* один слушатель не роняет остальных */ }
    }
  });

  proc.onExit(() => {
    session.alive = false;
    sessions.delete(id);
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    for (const fn of exits) {
      try { fn(); } catch { /* то же самое */ }
    }
  });

  sessions.set(id, session);
  return session;
}

/** Сессия по идентификатору либо `null`. Идентификатор чужой — это `null`, а не исключение. */
export function get(id) {
  const s = typeof id === 'string' ? sessions.get(id) : undefined;
  return s || null;
}

/** Сколько сессий живо сейчас. Нужно потолкам и доказательству границы записи. */
export function count() {
  return sessions.size;
}

/**
 * Убить все сессии. Зовётся на остановке демона.
 *
 * ОГОВОРКА ПРО WINDOWS, которую нельзя потерять: `SIGTERM` там НЕ ДОСТАВЛЯЕТСЯ ни при закрытии
 * окна консоли, ни при `taskkill`, поэтому пункт 4 критерия готовности фазы проверяется именно
 * этими способами, а не только Ctrl+C. Обработчик `exit` ловит нормальный выход, при
 * `TerminateProcess` не срабатывает и он — то есть на жёстком убийстве этот код НЕ ВЫПОЛНЯЕТСЯ.
 *
 * ЗАМЕРЕНО, А НЕ ПРЕДПОЛОЖЕНО (ревью фазы 2, круг по части C): при `taskkill /F` без `/T`
 * дочерний `powershell.exe` и его `conhost.exe` УМИРАЮТ ВМЕСТЕ С ДЕМОНОМ — ConPTY закрывается
 * вместе с владельцем, и осиротевшей оболочки в этом раскладе не остаётся. Замер ОДИН и сделан
 * на виде сессии `shell`; вид `claude` (внутри него живёт ещё и Node) и закрытие окна консоли
 * не мерил никто. Поэтому граница формулируется узко: «наш код при жёстком убийстве не
 * отрабатывает» — это факт; «оболочка остаётся сиротой» — не подтверждено ни разу, и писать
 * так значило бы пугать строже, чем показал замер.
 */
export function killAll() {
  for (const s of [...sessions.values()]) s.kill();
}

let hooked = false;

/**
 * Повесить уборку на выход процесса. Зовётся демоном один раз; повторный вызов ничего
 * не добавляет — иначе каждый импорт модуля вешал бы свой обработчик.
 */
export function hookExit() {
  if (hooked) return;
  hooked = true;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => killAll());
  process.on('exit', () => killAll());
}
