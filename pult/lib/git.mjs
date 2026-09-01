#!/usr/bin/env node
/**
 * Единственное место, где демон зовёт git.
 *
 * КОМАНДА ВСЕГДА АБСОЛЮТНАЯ. Имя разрешается дверью `resolveCommand()`
 * в `pult/lib/fs-safe.mjs` ОДИН раз и только по `PATH`. Причина: имя без разделителя пути
 * на Windows ищется в рабочем каталоге РАНЬШЕ `PATH`, а рабочий каталог здесь — корень
 * чужого проекта из реестра, то есть подложенный туда `git.exe` выполнился бы вместо
 * системного, и триггером стало бы простое открытие проекта в левой колонке. Не разрешилось —
 * наружу уходит признак «git недоступен», а не попытка запустить имя.
 *
 * ЗАПОМИНАЕТСЯ ФОРМА ЦЕЛИКОМ, а не одно её поле: на машине с git-шимом `.cmd` в поле файла
 * лежит `cmd.exe`, а сам git с ключами `/d /s /c` — в аргументах. Подробности и цена ошибки —
 * у переменной `gitForm` ниже.
 *
 * ОКРУЖЕНИЕ — СЛУЖЕБНОЕ (`gitEnv()`), не сессионное: белый список имён плюс
 * `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1`, `NoDefaultCurrentDirectoryInExePath=1`
 * и `GIT_CONFIG_GLOBAL`, указывающий на НЕСУЩЕСТВУЮЩИЙ путь (пустая строка частью версий git
 * читается как «не задано», и ужесточение тихо не применяется).
 *
 * ЧУЖОЙ `.git/config` — ИСПОЛНЯЕМЫЙ ВХОД, и это главная причина обеих приставок аргументов.
 * Репозиторий, приехавший КОПИЕЙ КАТАЛОГА вместе с `.git/`, исполняет то, что записано в его
 * конфиге (клон такой конфиг не переносит, копия переносит):
 *
 *   • без `--no-optional-locks` состояние дерева переписывает `.git/index` на каждое открытие
 *     проекта;
 *   • `core.fsmonitor` и `core.hooksPath` дают исполнение при первом же запросе состояния —
 *     закрыты общей приставкой `GIT_ARGS`;
 *   • `diff.external` и `textconv` в паре с `diff=x` в `.gitattributes` — при открытии вкладки
 *     диффов; закрыты приставкой ПОДКОМАНДЫ `GIT_DIFF_ARGS`, и приставляется она в ЕДИНСТВЕННОМ
 *     пусковом примитиве по имени подкоманды (`run()` ниже), а не переписывается у каждого
 *     вызова: пятый вызов, дописанный через полгода, получает ключи механически.
 *
 * ЧЕТВЁРТЫЙ ВЕКТОР НЕ ЗАКРЫВАЕТСЯ ВОВСЕ, и это сказано словами, а не спрятано:
 * `filter.<drv>.clean` из репозиторного конфига в паре с `filter=` в `.gitattributes`
 * исполняется уже на `git status`, и ключа «не запускать фильтры» у git НЕТ. Значит
 * добавление чужого репозитория в реестр остаётся АКТОМ ДОВЕРИЯ. Лечение одно — не заводить
 * в реестр репозиторий, которому не доверяешь.
 *
 * РАБОЧИЙ КАТАЛОГ ПЕРЕДАЁТСЯ ЯВНО корнем проекта: на `process.cwd()` полагаться нельзя,
 * демон обслуживает много проектов.
 *
 * НУЛЕВОЙ РАЗДЕЛИТЕЛЬ ОБЯЗАТЕЛЕН. Без `-z` вывод git экранирует не-ASCII пути восьмерично,
 * если у человека не выставлен `core.quotePath=false`, — а полагаться на чужой конфиг нельзя.
 *
 * ОТСУТСТВИЕ git И «КАТАЛОГ НЕ РЕПОЗИТОРИЙ» — не исключение, а честный признак в ответе:
 * дерево без меток, вкладка диффов с объяснением. Падения быть не должно.
 *
 * КОД ВОЗВРАТА «НЕ РЕПОЗИТОРИЙ» У ПОДКОМАНД РАЗНЫЙ, и это не мелочь: `status` и `cat-file`
 * дают 128, а `diff` — 129, потому что уходит в режим `--no-index`. Признавать 129 «за не
 * репозиторий» нельзя (это общий код негодных аргументов), поэтому на неудаче диффа спрашивается
 * `rev-parse --is-inside-work-tree` — см. `insideWorkTree()` ниже.
 *
 * Хук набора `.claude/hooks/git-status.mjs` здесь НЕ используется и не трогается: он печатает
 * сводку человеку и путей программно не отдаёт.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';

import { resolveCommand, withArgs, resolveTarget, gitEnv, isSecretPath } from './fs-safe.mjs';
import { readProjectFile, isRoundTripUtf8 } from '../read/file.mjs';
import {
  FAULT, GIT_ARGS, GIT_DIFF_ARGS, GIT_TIMEOUT_MS, GIT_MAX_OUTPUT, MAX_DIFF_BYTES, SECRET_GLOBS,
} from '../config.mjs';

/**
 * Подкоманды, к которым приставляются ключи диффа. `show` и `log` в списке заранее: сегодня
 * их нет, но вызов, дописанный позже, получит ключи сам, а не по памяти автора.
 */
const DIFF_SUBCOMMANDS = new Set(['diff', 'show', 'log']);

/**
 * ФОРМА ЗАПУСКА git ЦЕЛИКОМ, найденная один раз. Это НЕ кэш фактов о проекте (правило 1.3
 * контракта запрещает именно их): здесь запомнено расположение системной программы,
 * а не что-либо, прочитанное из чужого дерева.
 *
 * ЗАПОМИНАЕТСЯ ФОРМА, А НЕ ПОЛЕ ФАЙЛА, и это не стилистика. На машине, где git — шим `.cmd`,
 * дверь возвращает `cmd.exe` в поле файла, а путь до git вместе с ключами `/d /s /c` лежит
 * в аргументах. Запомнив одно поле, следующий вызов разрешал бы уже `cmd.exe` и получал
 * форму БЕЗ `/c`: git тихо переставал работать, дерево теряло все метки, вкладка диффов
 * пустела, и от «каталог не репозиторий» это не отличалось (находка ревью фазы 2).
 * Аргументы подставляются в запомненную форму функцией `withArgs()` в `pult/lib/fs-safe.mjs`;
 * заодно с диска на каждый вызов не читается ничего.
 *
 * `undefined` — ещё не искали, `null` — искали и не нашли.
 */
let gitForm;

async function gitLaunchForm() {
  if (gitForm === undefined) gitForm = await resolveCommand('git');
  return gitForm;
}

/** Полный argv одного вызова. Вынесен отдельно, чтобы приставки можно было увидеть проверкой. */
export function buildArgs(sub, args = []) {
  const diff = DIFF_SUBCOMMANDS.has(sub) ? GIT_DIFF_ARGS : [];
  return [...GIT_ARGS, sub, ...diff, ...args];
}

/**
 * Один вызов git. Без оболочки, с явным рабочим каталогом, под таймаутом и потолком вывода.
 *
 * Наружу отдаётся код возврата и байты; текст ошибки git НЕ уезжает в ответ никогда —
 * он цитирует чужие пути и чужое содержимое.
 */
async function run(root, sub, args, options = {}) {
  const base = await gitLaunchForm();
  if (!base) return { ok: false, code: FAULT.GIT_UNAVAILABLE };

  // Форма берётся ЦЕЛИКОМ и по частям не пересобирается: подставляются только аргументы.
  const form = withArgs(base, buildArgs(sub, args));
  if (!form) return { ok: false, code: FAULT.GIT_UNAVAILABLE };

  const maxBytes = typeof options.maxBytes === 'number' ? options.maxBytes : GIT_MAX_OUTPUT;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(form.file, form.args, {
        cwd: root,
        env: gitEnv(),
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: form.verbatim === true,
      });
    } catch {
      resolve({ ok: false, code: FAULT.GIT_UNAVAILABLE });
      return;
    }

    const chunks = [];
    let size = 0;
    let truncated = false;
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* уже умер */ }
      finish({ ok: false, code: FAULT.READ_TIMEOUT });
    }, GIT_TIMEOUT_MS);

    child.stdout.on('data', (buf) => {
      if (size + buf.length > maxBytes) {
        truncated = true;
        try { child.kill(); } catch { /* уже умер */ }
        return;
      }
      size += buf.length;
      chunks.push(buf);
    });
    // stderr читается и выбрасывается: не читать его значит рано или поздно упереться
    // в заполненный канал и повесить ребёнка.
    child.stderr.on('data', () => {});
    child.on('error', () => finish({ ok: false, code: FAULT.GIT_UNAVAILABLE }));
    child.on('close', (exit) => {
      finish({ ok: true, exit, out: Buffer.concat(chunks), truncated, code: null });
    });

    if (typeof options.stdin === 'string') {
      child.stdin.on('error', () => {});
      child.stdin.end(options.stdin, 'utf8');
    } else {
      child.stdin.end();
    }
  });
}

/** Код 128 у git означает и «не репозиторий», и «нет HEAD»: снаружи это один и тот же ответ. */
function notRepo(r) {
  return r.ok && r.exit === 128;
}

/**
 * Каталог — рабочее дерево репозитория? Спрашивается ЧЕСТНЫМ вопросом, а не выводится
 * из кода возврата чужой подкоманды.
 *
 * ЗАЧЕМ ЭТО ЕСТЬ. `status` и `cat-file` вне репозитория дают 128, и `notRepo()` их узнаёт.
 * А `diff` — НЕТ: не найдя репозитория, он уходит в режим `--no-index`, печатает справку
 * по использованию и выходит с кодом 129. Разбор ждал 128, поэтому `changedFiles()` отвечал
 * `git_failed`, и ЛЮБОЙ проект-не-репозиторий получал на вкладке диффов «503, git отказал» —
 * то есть ровно тот режим отказа, против которого написано правило `no_kit`: штатное
 * состояние читается как поломка демона (находка ревью фазы 2).
 *
 * Лечить это признанием кода 129 «за не репозиторий» НЕЛЬЗЯ: 129 у git означает «негодные
 * аргументы» вообще, и наша собственная ошибка в аргументах диффа тогда молча превращалась бы
 * в «здесь просто нет git». Поэтому на неудаче спрашивается отдельная дешёвая подкоманда,
 * у которой ответ однозначен: `rev-parse --is-inside-work-tree` печатает `true`/`false`
 * и честно даёт 128 вне репозитория.
 *
 * Возвращается ПАРА: `known` — получен ли ответ вообще (git недоступен или упал иначе —
 * это `false`, и вызывающий остаётся при своём отказе), `repo` — сам ответ.
 */
async function insideWorkTree(root) {
  const r = await run(root, 'rev-parse', ['--is-inside-work-tree']);
  if (!r.ok) return { known: false, repo: false };
  if (r.exit === 128) return { known: true, repo: false };
  if (r.exit !== 0) return { known: false, repo: false };
  return { known: true, repo: r.out.toString('utf8').trim() === 'true' };
}

/**
 * Состояние рабочего дерева: `status --porcelain=v2 -z`.
 *
 * Разбираются записи видов `1` (обычное изменение), `2` (переименование — старый путь лежит
 * ОТДЕЛЬНЫМ полем после нулевого байта), `u` (конфликт) и `?` (неотслеживаемый).
 */
export async function status(root) {
  const r = await run(root, 'status', ['--porcelain=v2', '-z', '--untracked-files=normal']);
  if (!r.ok) return { ok: false, repo: false, git: r.code !== FAULT.GIT_UNAVAILABLE, entries: [], truncated: false, code: r.code };
  if (notRepo(r)) return { ok: true, repo: false, git: true, entries: [], truncated: false, code: null };
  if (r.exit !== 0) return { ok: false, repo: true, git: true, entries: [], truncated: r.truncated, code: FAULT.GIT_FAILED };

  const fields = r.out.toString('utf8').split('\u0000');
  const entries = [];
  for (let i = 0; i < fields.length; i += 1) {
    const f = fields[i];
    if (!f) continue;
    const kind = f[0];
    if (kind === '#' || kind === '!') continue;
    if (kind === '?') {
      entries.push({ path: f.slice(2), x: '?', y: '?', kind: 'untracked', orig: null });
      continue;
    }
    const parts = f.split(' ');
    const xy = parts[1] || '  ';
    let head = 0;
    let name = 'changed';
    if (kind === '1') { head = 8; name = 'changed'; }
    else if (kind === '2') { head = 9; name = 'renamed'; }
    else if (kind === 'u') { head = 10; name = 'unmerged'; }
    else continue;
    const p = parts.slice(head).join(' ');
    let orig = null;
    if (kind === '2') { orig = fields[i + 1] || null; i += 1; }
    entries.push({ path: p, x: xy[0], y: xy[1], kind: name, orig });
  }
  return { ok: true, repo: true, git: true, entries, truncated: r.truncated, code: null };
}

/**
 * Игнорируемость порции имён одного каталога: `check-ignore -z --stdin`.
 *
 * Код возврата 1 значит «ничего не совпало» и ошибкой НЕ является. Код 128 значит, что git
 * отказался разбирать порцию, — тогда честно возвращается «не проверено», а не «не игнорируется».
 *
 * Имя, начинающееся с двоеточия, в порцию не отправляется: для git это магия pathspec
 * (`:!x`, `:(exclude)y`; на POSIX такое имя законно), и один такой файл уронил бы код 128
 * на весь каталог. Исполнения это не даёт, но пометки каталог лишился бы весь.
 */
export async function checkIgnored(root, relDir, names) {
  const list = [];
  const skipped = [];
  for (const n of names) {
    if (typeof n !== 'string' || !n) continue;
    if (n.startsWith(':')) { skipped.push(n); continue; }
    list.push(relDir ? `${relDir}/${n}` : n);
  }
  if (!list.length) return { ok: true, checked: skipped.length === 0, ignored: new Set(), skipped };

  const r = await run(root, 'check-ignore', ['-z', '--stdin'], { stdin: `${list.join('\u0000')}\u0000` });
  if (!r.ok) return { ok: false, checked: false, ignored: new Set(), skipped, code: r.code };
  if (r.exit === 1) return { ok: true, checked: true, ignored: new Set(), skipped };
  if (r.exit !== 0) return { ok: true, checked: false, ignored: new Set(), skipped };

  const ignored = new Set();
  for (const p of r.out.toString('utf8').split('\u0000')) {
    if (!p) continue;
    ignored.add(p.split('\\').join('/'));
  }
  return { ok: true, checked: true, ignored, skipped };
}

/**
 * Исключающие образцы для вызова диффа — по тому же закрытому списку имён секретов.
 *
 * `**\/` разворачивается в две формы (корневую и вложенную) намеренно: в обычном pathspec git
 * звёздочка и так пересекает разделитель, но полагаться на это молча не хочется.
 */
function secretPathspecs() {
  const specs = new Set();
  for (const g of SECRET_GLOBS) {
    if (g.startsWith('**/')) {
      specs.add(g.slice(3));
      specs.add(`*/${g.slice(3)}`);
    } else {
      specs.add(g);
    }
  }
  return [...specs];
}

/**
 * Список изменённого для вкладки диффов: дифф рабочего дерева против `HEAD`, числа добавленных
 * и удалённых строк и ОТДЕЛЬНО два числа про то, чего в списке НЕТ, — сколько файлов скрыто
 * как секреты и сколько записей неотслеживаемо.
 *
 * Исключение живёт в самом вызове (`:(exclude)` в пути), иначе закрытое чтение файла обходится
 * вкладкой диффов. Список скрытых считается вторым вызовом, который отдаёт ТОЛЬКО ИМЕНА:
 * число «скрыто: 1» обязано быть честным, а не молчанием. Возвращаемый список ещё раз
 * процеживается через `isSecretPath()` — страховка на случай, если форма образца pathspec
 * промахнулась.
 *
 * НЕОТСЛЕЖИВАЕМОЕ СЧИТАЕТСЯ ТРЕТЬИМ ВЫЗОВОМ И ОТДАЁТСЯ ЧИСЛОМ — по той же причине, что
 * и скрытое. `diff HEAD` новых файлов не показывает вовсе: задача, которая только добавляет
 * файлы, даёт ПУСТУЮ вкладку при непустом дереве, и молчаливый неполный список неотличим
 * от «изменений нет». Поддержки неотслеживаемых здесь нет и в этой фазе не будет — есть
 * честность: страница обязана сказать, сколько их и почему их тут нет.
 *
 * СЧИТАЮТСЯ ЗАПИСИ `git status`, А НЕ ФАЙЛЫ, и разница названа тут, чтобы её не пришлось
 * искать: при `--untracked-files=normal` целиком новый каталог — ОДНА запись. Число потому
 * и совпадает с тем, что человек видит в `git status`, а не с числом файлов на диске.
 * Считает их `status()` выше — своего разбора здесь нет, чтобы два места не разъехались.
 * Цена — ещё один вызов git на открытие вкладки; вкладка открывается по клику, а не
 * по таймеру, и опроса по времени на странице нет вовсе.
 *
 * `untracked: null` значит «не сосчитано» (git не ответил) и `0` не заменяет: ноль означал бы
 * «новых нет», а это разные вещи.
 */
export async function changedFiles(root) {
  const excludes = secretPathspecs().map((s) => `:(exclude)${s}`);
  const r = await run(root, 'diff', ['--numstat', '-z', 'HEAD', '--', '.', ...excludes], { maxBytes: MAX_DIFF_BYTES });
  if (!r.ok) return { ok: false, repo: false, git: r.code !== FAULT.GIT_UNAVAILABLE, files: [], hidden: 0, untracked: null, truncated: false, code: r.code };
  if (notRepo(r)) return { ok: true, repo: false, git: true, files: [], hidden: 0, untracked: null, truncated: false, code: null };
  if (r.exit !== 0) {
    // ВНЕ РЕПОЗИТОРИЯ `diff` ДАЁТ 129, А НЕ 128 (уходит в `--no-index` и печатает справку),
    // поэтому «не репозиторий» здесь узнаётся отдельным вопросом, а не кодом возврата.
    // Усечённый вывод в этот разбор не идёт: там отказ наш собственный, и спрашивать нечего.
    if (!r.truncated) {
      const tree = await insideWorkTree(root);
      if (tree.known && !tree.repo) {
        return { ok: true, repo: false, git: true, files: [], hidden: 0, untracked: null, truncated: false, code: null };
      }
    }
    return { ok: false, repo: true, git: true, files: [], hidden: 0, untracked: null, truncated: r.truncated, code: FAULT.GIT_FAILED };
  }

  const fields = r.out.toString('utf8').split('\u0000');
  const files = [];
  for (let i = 0; i < fields.length; i += 1) {
    const f = fields[i];
    if (!f) continue;
    const m = f.match(/^(\d+|-)\t(\d+|-)\t(.*)$/);
    if (!m) continue;
    let p = m[3];
    // Переименование: путь пуст, а старое и новое имена лежат следующими двумя полями.
    if (p === '') { p = fields[i + 2] || ''; i += 2; }
    if (!p || isSecretPath(p)) continue;
    files.push({ path: p, added: m[1] === '-' ? null : Number(m[1]), deleted: m[2] === '-' ? null : Number(m[2]) });
  }

  const only = secretPathspecs();
  const h = await run(root, 'diff', ['--name-only', '-z', 'HEAD', '--', ...only], { maxBytes: MAX_DIFF_BYTES });
  let hidden = 0;
  if (h.ok && h.exit === 0) {
    hidden = h.out.toString('utf8').split('\u0000').filter((x) => x).length;
  }

  // Неотслеживаемое: не список, а число. Имена сюда не едут — вкладка их не показывает,
  // а число отвечает на единственный вопрос человека: «весь ли это дифф».
  const st = await status(root);
  const untracked = st.ok && st.repo
    ? st.entries.filter((e) => e.kind === 'untracked').length
    : null;

  return { ok: true, repo: true, git: true, files, hidden, untracked, truncated: r.truncated, code: null };
}

/**
 * ОБЕ СТОРОНЫ ОДНОГО ФАЙЛА. Отдаёт их демон, а не страница: здесь стоят и `--`, и потолки,
 * и фильтр секретов, и ключи `--no-ext-diff --no-textconv`. Дорисовывать вторую сторону
 * по месту на странице ЗАПРЕЩЕНО — там нет ничего из перечисленного, и `.env` из `HEAD` уехал
 * бы в браузер мимо исключения, которое живёт только в вызове диффа.
 *
 * Сторона `HEAD` берётся `cat-file blob HEAD:<путь>`: аргумент собирается на демоне, всегда
 * начинается с `HEAD:` и потому ключом притвориться не может (путь с дефисом становится
 * `HEAD:-foo` и разбирается как имя в дереве). `cat-file` отдаёт объект как он лежит
 * в репозитории — ни внешний дифф, ни textconv, ни смуджи-фильтры к нему не применяются.
 *
 * Путь для git ВЫЧИСЛЯЕТСЯ от разрешённого шлюзом, а не берётся присланной строкой, и слэши
 * приводятся к прямым: git ищет `a\b` в дереве буквально, и правка показалась бы новым файлом.
 *
 * ОГОВОРКА ПРО ШИМ `.cmd`. Аргумент `HEAD:<путь>` — ЕДИНСТВЕННЫЙ, куда попадает производная
 * от клиентского пути, и на машине с git-шимом он уезжает в командную строку `cmd /c`.
 * Кавычки из `quoteForCmd()` обезвреживают `&`, `^` и `|`, но подстановку переменной
 * окружения по процентам `cmd` делает и внутри кавычек: файл с `%имя%` в имени приедет
 * подставленным значением. Исполнения это не даёт — худшее, что выходит, «объекта нет
 * в HEAD», то есть закрытый отказ и пустая сторона сравнения.
 *
 * Рабочая сторона берётся ЧИТАТЕЛЕМ шага 9 — его проверки здесь не повторяются: потолок,
 * вложенность и фильтр секретов уже там.
 */
export async function fileSides(root, rel) {
  const t = await resolveTarget(root, rel, { mode: 'read', kind: 'file', allowMissing: true });
  if (!t.ok) return { ok: false, hidden: false, head: null, work: null, code: t.code };

  if (isSecretPath(t.path)) {
    return { ok: true, hidden: true, head: null, work: null, code: null };
  }

  const gitRel = path.relative(t.root, t.path).split(path.sep).join('/');
  const r = await run(root, 'cat-file', ['blob', `HEAD:${gitRel}`], { maxBytes: MAX_DIFF_BYTES });
  let head = { exists: false, text: '', binary: false, truncated: false, code: null };
  if (!r.ok) {
    if (r.code === FAULT.GIT_UNAVAILABLE) {
      return { ok: false, hidden: false, head: null, work: null, code: r.code };
    }
  } else if (r.exit === 0) {
    // ТА ЖЕ ПРОВЕРКА ОБРАТНОГО КОДИРОВАНИЯ, ЧТО И У РАБОЧЕЙ СТОРОНЫ. Читатель шага 9 её
    // делает сам (`isRoundTripUtf8()` в `pult/read/file.mjs`), а сторона `HEAD` шла мимо:
    // двоичный объект уезжал бы на страницу кракозябрами — строкой из заменяющих символов,
    // выдающей себя за содержимое. Показывать нечего — значит и не показываем: признак
    // `binary` есть, содержимого нет (замечание ревью фазы 2, лечится здесь, а не на шаге 25).
    const text = r.out.toString('utf8');
    head = isRoundTripUtf8(r.out, text)
      ? { exists: true, text, binary: false, truncated: r.truncated, code: null }
      : { exists: true, text: '', binary: true, truncated: r.truncated, code: FAULT.NOT_TEXT_FILE };
  }
  // Ненулевой код здесь НЕ ошибка: файла в `HEAD` нет (новый файл), `HEAD` не существует
  // (пустой репозиторий), цель оказалась деревом. Все три — «стороны нет».

  const work = await readProjectFile(root, rel);
  return {
    ok: true,
    hidden: false,
    head,
    work: work.ok
      ? { exists: true, text: work.text, truncated: work.truncated }
      : { exists: false, text: '', truncated: work.truncated, code: work.code },
    code: null,
  };
}

/** Доступен ли git вообще. Признак, а не исключение: дерево без меток — законный вид. */
export async function gitAvailable() {
  return (await gitLaunchForm()) !== null;
}
