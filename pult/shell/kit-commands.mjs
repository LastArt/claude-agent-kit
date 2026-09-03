#!/usr/bin/env node
/**
 * КОМАНДЫ НАБОРА: закрытый словарь ключей, замороженная таблица аргументов, запуск подпроцессом.
 *
 * §4.6 контракта: команды набора запускаются как процессы, а вывод показывается КАК ЕСТЬ.
 * Пульт не разбирает вывод, чтобы «улучшить» его, и не пересказывает отказ — отсюда всё
 * устройство этого модуля: он возвращает два потока и код возврата, и больше ничего.
 *
 * ГЛАВНОЕ СВОЙСТВО: АРГУМЕНТЫ НЕ ПРИХОДЯТ СО СТРАНИЦЫ — ПРИХОДИТ ТОЛЬКО КЛЮЧ. Таблица ниже
 * заморожена, ни одно её значение не собирается конкатенацией, свободного текста в ней нет
 * ни одного. Страница присылает слово из словаря; всё остальное вычисляется здесь.
 *
 * ГРАНИЦА ЗАКРЫТОГО СЛОВАРЯ, И ОНА НАЗЫВАЕТСЯ ПРЯМО: словарь закрывает ПОДСТАНОВКУ АРГУМЕНТОВ
 * и НЕ ОТВЕЧАЕТ на вопрос, КТО НАЖАЛ. Скрипт на странице умеет позвать мост ровно так же, как
 * человек, — поэтому меняющие состояние ключи требуют ПОДТВЕРЖДЕНИЯ ГЛАВНОГО ПРОЦЕССА
 * (`pult/shell/main.mjs`) и без него не исполняются: признак подтверждения приходит сюда
 * отдельным аргументом, и его нельзя прислать со страницы — он ставится главным процессом
 * после системного окна.
 *
 * ВТОРАЯ ГРАНИЦА, КОТОРУЮ НЕЛЬЗЯ ЗАМАЛЧИВАТЬ: здесь запускается КОД ИЗ ЧУЖОГО ПРОЕКТА —
 * хук набора, лежащий в `<проект>/.claude/hooks/`. Мы не сверяем его хеш и не можем: это
 * рабочий набор человека, он законно правится. Новой возможности это не даёт — с фазы 2 у той
 * же страницы есть сессия псевдотерминала в том же проекте, то есть оболочка машины; предмет
 * закрытого словаря не «чей код», а «какие аргументы» и «что меняет состояние».
 *
 * ПОЧЕМУ ЗАПУСКАЕТ ОБОЛОЧКА, А НЕ ДЕМОН. Демон обслуживает HTTP-запросы и обязан отвечать
 * всегда; запуск команды набора — это подпроцесс на секунды и минуты, у которого нет клиента,
 * кроме нажавшего человека. Ровно та же причина, по которой в фазе 3 инструмент реестра
 * запускает оболочка: у демона нет и не будет маршрута, принимающего путь проекта из запроса,
 * а корень для запуска берётся ИЗ РЕЕСТРА ПО ИДЕНТИФИКАТОРУ.
 *
 * ПОЧЕМУ У ПРИЁМКИ ТОЛЬКО СУХИЕ ПРОГОНЫ. `verify.mjs` без ключей ИСПОЛНЯЕТ блок проверок
 * из `PROJECT_PROFILE.md` ЧУЖОГО проекта — с правами человека и без единого ограничения на то,
 * что там написано. Кнопка, делающая это одним нажатием, превращает открытие чужого проекта
 * в исполнение его команд. Поэтому в таблице только `--dry` и `--selftest`: они печатают,
 * что настроено, и ничего не запускают. Запустить приёмку по-настоящему человек может
 * в терминале пульта, осознанно и видя команды.
 */

import path from 'node:path';
import process from 'node:process';

import { capText, isPlainFile, sanePath } from '../lib/fs-safe.mjs';
import { readRegistry } from '../lib/registry.mjs';
import { KIT_READ_KEYS, KIT_WRITE_KEYS, PROJECT_ID_RE } from '../config.mjs';
import { childEnv, findNode, percentUnsafe, runCapped } from './daemon.mjs';

// --- константы: живут рядом с потребителем -----------------------------------

/** Потолок на КАЖДЫЙ поток по отдельности. Вывод показывается человеку, а не разбирается. */
const OUT_MAX_BYTES = 128 * 1024;

/** Минута на команду. Дольше — это не «медленно», это «повис»: все команды таблицы быстрые. */
const RUN_TIMEOUT_MS = 60000;

/** Каталог хуков внутри проекта. Строится нами из констант, со страницы не приходит. */
const HOOKS_DIR = ['.claude', 'hooks'];

const say = (s) => process.stdout.write(`[shell] ${s}\n`);
const fail = (code, message) => ({ ok: false, code, message });

/**
 * ЗАМОРОЖЕННАЯ ТАБЛИЦА «КЛЮЧ → ХУК И АРГУМЕНТЫ».
 *
 * Правила, по которым она пополняется:
 *   • значение — неизменяемый массив литералов; конкатенации, шаблонов и подстановок нет;
 *   • свободного текста нет ни одного: `task.mjs new` и `task.mjs log` несут произвольную
 *     строку и в таблицу не входят НИКОГДА — по той же причине, по которой их нет в `allow`
 *     набора;
 *   • `changes: true` означает «пишет на диск проекта» и требует подтверждения человека.
 *
 * ЧЕТЫРЕ СТАТУСА И ЗАКРЫТИЕ — это то, что человек за пультом двигает РУКОЙ: утвердил план
 * (`implementing`), вернул на ревью (`reviewing`), принял (`done`), остановил (`blocked`),
 * закрыл задачу.
 *
 * ЧЕГО ЗДЕСЬ НЕТ ПОСЛЕ РЕВЬЮ 03.09.2026 — `task.mjs class`. Он выглядит читающим («покажи
 * класс риска»), но `cmdClass()` в `.claude/hooks/task.mjs` ПИШЕТ: правит поле `class`
 * в `STATE.md` и добавляет строку журнала. Хуже цены ошибки не придумать: если человек
 * ПОДНЯЛ класс до `elevated`, а план объявляет `cosmetic`, нажатие «читающей» кнопки
 * ПОНИЖАЕТ класс молча — а при `cosmetic` аудит безопасности пропускается целиком.
 * Решение человека: убрать ключ совсем, а не прятать за подтверждением. Подтверждение
 * защищает от случайного клика, но не от неверного действия, и конвейер зовёт `class` сам —
 * на своём месте между планом и аудитом.
 *
 * ЧЕГО ЗДЕСЬ НЕТ НАМЕРЕННО — `status awaiting_acceptance`: этот переход СНИМАЕТ ВЗВОД ГЕЙТА
 * (внутренним вызовом `gate.mjs --disarm --if-task` в `task.mjs`), то есть единственная кнопка,
 * которая трогала бы машинную приёмку. Её делает оркестратор после ревью, а не нажатие
 * на странице. По той же причине нет `gate.mjs --arm` и голого `verify.mjs`.
 */
export const KIT_COMMANDS = Object.freeze({
  // --- читающие ---------------------------------------------------------------
  task_list: Object.freeze({
    title: 'Задачи',
    hook: 'task.mjs',
    args: Object.freeze(['list']),
    changes: false,
  }),
  task_path: Object.freeze({
    title: 'Путь активной задачи',
    hook: 'task.mjs',
    args: Object.freeze(['path']),
    changes: false,
  }),
  verify_dry: Object.freeze({
    title: 'Приёмка: что настроено',
    hook: 'verify.mjs',
    args: Object.freeze(['--dry']),
    changes: false,
  }),
  verify_selftest: Object.freeze({
    title: 'Приёмка: самопроверка',
    hook: 'verify.mjs',
    args: Object.freeze(['--selftest']),
    changes: false,
  }),
  gate_status: Object.freeze({
    title: 'Гейт: состояние',
    hook: 'gate.mjs',
    args: Object.freeze(['--status']),
    changes: false,
  }),
  gate_dry: Object.freeze({
    title: 'Гейт: решение без последствий',
    hook: 'gate.mjs',
    args: Object.freeze(['--dry']),
    changes: false,
  }),
  banner: Object.freeze({
    title: 'Версия и отпечаток',
    hook: 'banner.mjs',
    args: Object.freeze(['--compact']),
    changes: false,
  }),

  // --- меняющие состояние -----------------------------------------------------
  status_implementing: Object.freeze({
    title: 'Статус: в работе',
    hook: 'task.mjs',
    args: Object.freeze(['status', 'implementing']),
    changes: true,
  }),
  status_reviewing: Object.freeze({
    title: 'Статус: на ревью',
    hook: 'task.mjs',
    args: Object.freeze(['status', 'reviewing']),
    changes: true,
  }),
  status_done: Object.freeze({
    title: 'Статус: готово',
    hook: 'task.mjs',
    args: Object.freeze(['status', 'done']),
    changes: true,
  }),
  status_blocked: Object.freeze({
    title: 'Статус: заблокирована',
    hook: 'task.mjs',
    args: Object.freeze(['status', 'blocked']),
    changes: true,
  }),
  task_close: Object.freeze({
    title: 'Закрыть задачу',
    hook: 'task.mjs',
    args: Object.freeze(['close']),
    changes: true,
  }),
});

/** Ключ из закрытого словаря либо `null`. Чужое слово ключом не становится никогда. */
export function commandKey(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 32) return null;
  return Object.prototype.hasOwnProperty.call(KIT_COMMANDS, raw) ? raw : null;
}

/** Меняет ли ключ состояние. Неизвестный ключ считается меняющим: сторона отказа безопасная. */
export function changesState(key) {
  const k = commandKey(key);
  return k === null ? true : KIT_COMMANDS[k].changes === true;
}

/**
 * ОБЕЩАНИЕ «СЛОВАРЬ РАЗДЕЛЁН НА ДВА СПИСКА» ПРОВЕРЯЕТСЯ, А НЕ ДЕКЛАРИРУЕТСЯ.
 *
 * Списки ключей лежат в `pult/config.mjs` (их читает страница шага 20 через свою копию,
 * и их же видит демон), а таблица аргументов — здесь. Два места разошлись бы молча: добавили
 * ключ сюда, забыли там — и кнопка либо не появится, либо появится без команды. Поэтому
 * сверка стоит на загрузке модуля и роняет оболочку с внятной строкой, а не открывает
 * непроверенный ключ.
 */
const READ_KEYS = Object.keys(KIT_COMMANDS).filter((k) => !KIT_COMMANDS[k].changes);
const WRITE_KEYS = Object.keys(KIT_COMMANDS).filter((k) => KIT_COMMANDS[k].changes);
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
if (!sameSet(READ_KEYS, [...KIT_READ_KEYS]) || !sameSet(WRITE_KEYS, [...KIT_WRITE_KEYS])) {
  throw new Error('pult/shell/kit-commands.mjs: таблица команд разошлась со словарями в pult/config.mjs');
}

/** Корень проекта по идентификатору — ТОЛЬКО из реестра. Другого источника пути у модуля нет. */
async function rootById(id) {
  if (typeof id !== 'string' || !PROJECT_ID_RE.test(id)) {
    return fail('bad_project', 'идентификатор проекта не той формы');
  }
  const reg = await readRegistry();
  const entry = reg.entries.find((e) => e.id === id);
  if (!entry) return fail('unknown_project', 'такого проекта нет в реестре пульта');
  // ОТВЕРГНУТЫЙ КОРЕНЬ — ОТКАЗ, а не запуск: под таким корнем демон не читает и не пишет
  // ничего, и запускать в нём команды тем более не следует.
  if (entry.rejected) return fail('root_rejected', 'корень этого проекта отвергнут — команды в нём не запускаются');
  if (!sanePath(entry.path) || !path.isAbsolute(entry.path)) {
    return fail('bad_root', 'путь проекта в реестре не годится');
  }
  return { ok: true, root: entry.path, name: entry.name };
}

/**
 * Запустить команду набора в проекте.
 *
 * @param {string} projectId  идентификатор проекта (форма проверяется, путь берётся из реестра)
 * @param {string} key        ключ из закрытого словаря
 * @param {object} options    `confirmed` — ПРИЗНАК ПОДТВЕРЖДЕНИЯ ГЛАВНОГО ПРОЦЕССА. Его ставит
 *                            `pult/shell/main.mjs` после системного окна; со страницы он
 *                            не приходит и прийти не может.
 * @returns {Promise<object>} `{ok, key, title, changes, code, killed, stdout, stderr, truncated}`
 *                            либо `{ok:false, code, message}`. Оба потока — ДОСЛОВНО.
 */
export async function runKitCommand(projectId, key, options = {}) {
  const k = commandKey(key);
  if (!k) return fail('unknown_key', 'такой команды набора нет');
  const command = KIT_COMMANDS[k];

  // МЕНЯЮЩИЙ КЛЮЧ БЕЗ ПОДТВЕРЖДЕНИЯ — ОТКАЗ, А НЕ ЗАПУСК. Проверка стоит ДО обращения
  // к реестру и к диску: намерение человека проверяется раньше, чем что-либо делается.
  if (command.changes && options.confirmed !== true) {
    return fail('not_confirmed', 'команда меняет состояние и требует подтверждения человека');
  }

  const found = await rootById(projectId);
  if (!found.ok) return found;

  const hook = path.join(found.root, ...HOOKS_DIR, command.hook);
  if (!(await isPlainFile(hook))) {
    return fail('hook_missing', `в проекте нет хука ${command.hook} — набор там не развёрнут или неполон`);
  }

  const node = await findNode();
  if (!node.ok) return node;

  const args = [hook, ...command.args];

  // ЗНАК ПРОЦЕНТА — ПО ВСЕМУ НАБОРУ АРГУМЕНТОВ, включая путь до хука: он считается от корня
  // проекта человека, а подстановка по процентам в командной строке идёт даже внутри кавычек.
  if (percentUnsafe(node.form, args)) {
    return fail('percent_in_path', [
      'В пути к проекту есть знак процента, а найденный Node запускается через командный файл.',
      '',
      'Интерпретатор команд подставит значение переменной окружения по процентам даже внутри',
      'кавычек — запустился бы не тот файл. Отказываюсь молча портить путь.',
    ].join('\n'));
  }

  say(`команда набора «${k}» в проекте ${found.name}`);
  const run = await runCapped(node.form, args, {
    cwd: found.root,
    env: childEnv(),
    timeoutMs: RUN_TIMEOUT_MS,
    maxBytes: OUT_MAX_BYTES,
  });
  if (!run.ok) return run;

  // ВЫВОД ВОЗВРАЩАЕТСЯ ДОСЛОВНО И ДВУМЯ ПОТОКАМИ ОТДЕЛЬНО. Очистка `capText()` снимает
  // управляющие символы и переворот направления письма — то же, что демон делает со всяким
  // чужим текстом, — и обрезает по потолку. Пересказа, «улучшения» и склейки потоков нет:
  // §4.6 контракта требует показать вывод как есть.
  return {
    ok: true,
    key: k,
    title: command.title,
    changes: command.changes,
    code: run.code,
    killed: run.killed === true,
    truncated: run.truncated === true,
    stdout: capText(run.stdout, OUT_MAX_BYTES).text,
    stderr: capText(run.stderr, OUT_MAX_BYTES).text,
  };
}
