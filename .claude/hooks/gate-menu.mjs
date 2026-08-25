#!/usr/bin/env node
/**
 * Меню машинной приёмки — то, что видит человек, запустив `.claude/gate.bat` (Windows)
 * или `.claude/gate.sh` (macOS / Linux).
 *
 * Зачем отдельный скрипт. Настройка приёмки — это работа человека, и половина её шагов
 * физически требует терминала: `verify.mjs --accept` спрашивает подтверждение с клавиатуры
 * и без TTY отказывается работать. Объяснять это простынёй в инструкции бесполезно — проще
 * открыть окно, где всё нажимается цифрами.
 *
 * Дочерние хуки запускаются со `stdio: 'inherit'`: они получают тот же терминал, поэтому
 * подтверждение работает как надо, а вывод человек видит целиком.
 *
 * Без внешних зависимостей. Ничего не делает молча: каждый пункт показывает, что запустил.
 */

import { spawnSync, spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERIFY = path.join(KIT, 'hooks', 'verify.mjs');
const GATE = path.join(KIT, 'hooks', 'gate.mjs');
const PROFILE = path.join(KIT, 'PROJECT_PROFILE.md');

/**
 * `--launch` — открыть меню в НОВОМ окне терминала и сразу выйти.
 *
 * Зачем режим, а не строчка в тексте команды: возня с окнами платформозависима и полна ловушек
 * (кириллица в заголовке ломает `start`, из Git Bash он не отделяется и льёт баннер в чужой
 * терминал, macOS требует `open -a Terminal`). Такое место должно быть одно и проверяться,
 * а не переписываться в промте команды на каждой платформе заново.
 *
 * Окно нужно именно настоящее: подтверждение набора команд спрашивает «да» с клавиатуры
 * и без TTY отказывается работать.
 */
if (process.argv.includes('--launch')) {
  const p = process.platform;
  const tries = p === 'win32'
    // Заголовок латиницей намеренно: кириллица здесь ломает разбор аргументов start.
    ? [['cmd', ['/c', 'start', 'Claude Agent Kit', 'cmd', '/k', path.join(KIT, 'gate.bat')]]]
    : p === 'darwin'
      ? [['open', ['-a', 'Terminal', path.join(KIT, 'gate.sh')]]]
      : [
        ['x-terminal-emulator', ['-e', 'bash', path.join(KIT, 'gate.sh')]],
        ['gnome-terminal', ['--', 'bash', path.join(KIT, 'gate.sh')]],
        ['konsole', ['-e', 'bash', path.join(KIT, 'gate.sh')]],
        ['xterm', ['-e', 'bash', path.join(KIT, 'gate.sh')]],
      ];

  let ok = false;
  for (const [cmd, args] of tries) {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      child.unref();          // не держим родителя: команда должна вернуться сразу
      ok = true;
      break;
    } catch { /* пробуем следующий терминал */ }
  }
  if (ok) {
    console.log('[gate] меню открыто в отдельном окне.');
  } else {
    console.log('[gate] окно открыть не удалось (нет графической среды?). Запустите вручную:');
    console.log(p === 'win32' ? `  ${path.join(KIT, 'gate.bat')}` : `  bash ${path.join(KIT, 'gate.sh')}`);
  }
  process.exit(0);
}

const run = (script, args = []) =>
  spawnSync(process.execPath, [script, ...args], { stdio: 'inherit', cwd: path.dirname(KIT) });

const quiet = (script, args = []) =>
  spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: path.dirname(KIT) });

/** Машинный список проверок: печатает его человеку уже это меню, своими словами. */
function listChecks() {
  const r = quiet(VERIFY, ['--list']);
  try { return JSON.parse(String(r.stdout || '').trim()); } catch { return null; }
}

/** Список так, как его прочтёт человек: пронумерованный, с пояснением, зачем это всё. */
function showList() {
  const j = listChecks();
  if (!j || j.checks.length === 0) {
    console.log('  Список пуст — проверять нечего, помощник работает как обычно.');
    console.log('  Чтобы завести проверки, откройте файл (пункт 6) или попросите помощника');
    console.log('  подобрать их под ваш проект.');
    return;
  }
  console.log('  Проверок в списке: ' + j.checks.length + '. Идут сверху вниз и останавливаются');
  console.log('  на первой упавшей — поэтому быстрые стоит ставить первыми.');
  console.log('');
  j.checks.forEach((c, i) => {
    console.log('   ' + (c.enabled ? '[вкл]' : '[выкл]') + ' ' + (i + 1) + '. ' + c.name);
    console.log('         запустит:  ' + c.cmd);
    if (c.timeout) console.log('         ждать до:  ' + c.timeout + ' с');
  });
  const off = j.checks.filter((c) => !c.enabled).length;
  if (off) {
    console.log('');
    console.log('  Выключенных: ' + off + '. Их предложил помощник, но запускать их или нет —');
    console.log('  решаете вы: включить можно пунктом 8.');
  }
  console.log('');
  console.log(j.accepted
    ? '  Список подтверждён — эти команды разрешено выполнять.'
    : '  Список НЕ подтверждён: пока вы не скажете «да» (пункт 2), не выполнится ни одна.');
}

/** Подтверждение: сначала объясняем, что сейчас произойдёт, потом отдаём терминал хуку. */
function confirmList() {
  const j = listChecks();
  if (!j || j.checks.length === 0) { console.log('  Список пуст — подтверждать нечего.'); return; }
  if (j.accepted) {
    console.log('  Этот список уже подтверждён. Заново нужно только после правок.');
    console.log('');
  }
  console.log('  Сейчас покажу команды и спрошу согласие. Это тот случай, когда решаете вы:');
  console.log('  команды выполнятся на вашем компьютере по-настоящему.');
  console.log('');
  run(VERIFY, ['--accept']);
}

/** Прогон: ход дела виден как есть, а итог переводим на человеческий. */
function runChecks() {
  const j = listChecks();
  if (!j || j.checks.length === 0) { console.log('  Список пуст — запускать нечего.'); return; }
  if (!j.accepted) {
    console.log('  Список не подтверждён, поэтому ничего не выполнится. Сначала пункт 2.');
    return;
  }
  console.log('  Запускаю проверки: ' + j.checks.length + ' шт.');
  console.log('');
  const code = run(VERIFY).status;
  console.log('');
  if (code === 0) {
    console.log('  ✓ Всё прошло. Помощник сможет закончить работу.');
  } else if (code === 4) {
    console.log('  ~ Прошло не всё: часть проверок пропущена — обычно потому, что нужной');
    console.log('    программы нет на этом компьютере. Это не ошибка в вашем коде.');
  } else if (code === 1) {
    console.log('  ✗ Одна из проверок не прошла — какая именно, написано выше.');
    console.log('    Это и есть та ситуация, в которой помощника не выпустят с работы.');
  } else {
    console.log('  Проверить не удалось: список пуст, не подтверждён или повреждён (см. выше).');
  }
}

/**
 * Включение и выключение проверки. Помощник, разбирая проект, предлагает проверки
 * выключенными — решение «этому запускаться у меня на машине» принимает человек, и вот здесь.
 */
async function toggleCheck(rl) {
  const j = listChecks();
  if (!j || j.checks.length === 0) {
    console.log('  Список пуст — включать нечего. Попросите помощника подобрать проверки');
    console.log('  под ваш проект: он видит, чем проект собирается и чем тестируется.');
    return;
  }
  j.checks.forEach((c, i) => {
    console.log('   ' + (c.enabled ? '[вкл] ' : '[выкл]') + ' ' + (i + 1) + '. ' + c.name + '  —  ' + c.cmd);
  });
  console.log('');
  const raw = (await rl.question('  Номер проверки (Enter — назад): ')).trim();
  if (!raw) return;
  const num = Number(raw);
  if (!Number.isInteger(num) || num < 1 || num > j.checks.length) {
    console.log('  Нет такого номера.');
    return;
  }
  const c = j.checks[num - 1];
  console.log('');
  run(VERIFY, [c.enabled ? '--disable' : '--enable', String(num)]);
  if (!c.enabled) {
    console.log('');
    console.log('  Готово. Заново подтверждать не нужно: команды не менялись, вы лишь сказали,');
    console.log('  что эта строка теперь выполняется.');
  }
}

function state() {
  const out = { checks: 0, accepted: false, armed: false, task: '', taskId: '', verify: 'none', status: '' };
  const h = quiet(VERIFY, ['--hash']);
  try {
    const j = JSON.parse(String(h.stdout || '').replace(/^\[verify\]\s*/, ''));
    out.checks = j.count || 0;
    out.accepted = !!j.accepted;
  } catch { /* профиль без блока — так и оставим нули */ }
  const s = quiet(GATE, ['--status']);
  const text = String(s.stdout || '');
  out.armed = !text.includes('не взведён');
  // Название и id приходят из STATE.md и из ACTIVE, то есть в конечном счёте от человека:
  // перед печатью вырезаем управляющие символы, иначе чужой заголовок покрасит терминал.
  out.task = safe((text.match(/задача:\s*(.+)/) || [, ''])[1]);
  out.taskId = safe((text.match(/id задачи:\s*(\S+)/) || [, ''])[1]);
  out.status = (text.match(/статус:\s*(\S+)/) || [, ''])[1];
  out.verify = (text.match(/приёмка:\s*(\S+)/) || [, ''])[1];
  return out;
}

/** Управляющие символы (в том числе ANSI-escape) — пробелом; длину режем по ширине окна. */
function safe(s) {
  return String(s || '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function header() {
  const st = state();
  const line = (s) => console.log('  ' + s);
  console.log('');
  console.log('┌─ Проверка перед сдачей ' + '─'.repeat(40));
  if (st.checks === 0) {
    line('Сейчас: выключена. Список проверок пуст — помощник работает как обычно.');
  } else if (!st.accepted) {
    line(`Сейчас: список из ${st.checks} проверок составлен, но НЕ подтверждён.`);
    line('Пока вы его не подтвердите (пункт 2), проверки не выполняются.');
  } else if (st.armed) {
    line(`Сейчас: включена и следит за задачей «${st.task}».`);
    if (st.taskId) line(`Папка задачи: .claude/tasks/${st.taskId}/`);
    line(`Проверок: ${st.checks} · последний прогон: ${st.verify || 'ещё не было'}`);
  } else {
    line(`Сейчас: список из ${st.checks} проверок подтверждён, слежение не включено.`);
    line('Это нормальное состояние между задачами — помощник включит его сам.');
  }
  console.log('└' + '─'.repeat(63));
  console.log('');
  console.log('  1  Показать список проверок');
  console.log('  2  Подтвердить список  (нужно после каждой его правки)');
  console.log('  3  Прогнать проверки прямо сейчас');
  console.log('  4  Включить слежение за текущей задачей');
  console.log('  5  Выключить слежение');
  console.log('  6  Открыть файл со списком в редакторе');
  console.log('  7  Что это вообще такое (коротко)');
  console.log('  8  Включить или выключить проверку из списка');
  console.log('  0  Выход');
  console.log('');
}

function about() {
  console.log(`
  Раньше помощник сам говорил «готово», и проверять приходилось вам.
  Теперь на выходе стоит турникет: вы описываете список проверок —
  «запусти тесты», «проверь стиль кода», — и пока список не сойдётся,
  помощник не может закончить работу. Решает машина, а не его мнение.

  По умолчанию турникет выключен: список пуст, всё как раньше.

  Подтверждать список обязаны вы, и только из такого окна, как это.
  В списке лежат команды, которые по-настоящему выполнятся на вашем
  компьютере, — поэтому помощнику подтверждать их не позволено.

  Застрять нельзя: три неудачные попытки подряд — турникет открывается
  сам и зовёт вас. Забыли выключить — выключится через шесть часов.

  Что вписывать: только быстрое — проверку стиля, быстрые тесты,
  сборку. Полный прогон тестов на десять минут превратит каждый ответ
  помощника в десятиминутное ожидание.
`);
}

function openProfile() {
  if (!existsSync(PROFILE)) { console.log(`  Файл не найден: ${PROFILE}`); return; }
  console.log(`  Открываю: ${PROFILE}`);
  const p = process.platform;
  const cmd = p === 'win32' ? ['cmd', ['/c', 'start', '', PROFILE]]
    : p === 'darwin' ? ['open', [PROFILE]]
    : ['xdg-open', [PROFILE]];
  const r = spawnSync(cmd[0], cmd[1], { stdio: 'ignore' });
  if (r.error) console.log('  Открыть не получилось — скопируйте путь выше и откройте вручную.');
  console.log('  Список — между пометками CCKIT:VERIFY. Правки не забудьте подтвердить (пункт 2).');
}

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for (;;) {
    header();
    const answer = (await rl.question('  Что делаем? ')).trim();
    console.log('');
    if (answer === '0' || answer === '') { break; }
    // Ошибка внутри пункта не должна закрывать окно: человек в нём работает, а закрывшееся
    // на глазах окно не оставляет даже текста, по которому можно понять, что случилось.
    try {
      if (answer === '1') showList();
      else if (answer === '2') confirmList();
      else if (answer === '3') runChecks();
      else if (answer === '4') {
        const task = (await rl.question('  Над чем работаете (одной строкой)? ')).trim();
        run(GATE, ['--arm', task || 'задача без названия']);
      } else if (answer === '5') run(GATE, ['--disarm']);
      else if (answer === '6') openProfile();
      else if (answer === '8') await toggleCheck(rl);
      else if (answer === '7') about();
      else console.log('  Не понял. Введите цифру из списка.');
    } catch (e) {
      console.log('');
      console.log('  Не получилось выполнить этот пункт:');
      console.log('  ' + (e && e.message ? e.message : e));
      console.log('');
      console.log('  Меню при этом работает — можно попробовать другой пункт.');
      console.log('  Если повторяется, покажите эти строки разработчику:');
      console.log('  ' + String((e && e.stack ? e.stack : '').split('\n').slice(1, 3).join(' | ')).slice(0, 200));
    }
    console.log('');
    await rl.question('  Enter — вернуться в меню… ');
  }
  rl.close();
  console.log('  До встречи.');
}

main().catch((e) => {
  // Падение самого меню тоже не должно оставлять человека наедине с закрывшимся окном:
  // печатаем причину целиком и ждём Enter, а не выходим молча.
  console.log('');
  console.log('  Меню остановилось из-за ошибки:');
  console.log('  ' + (e && e.message ? e.message : e));
  if (e && e.stack) console.log('  ' + e.stack.split('\n').slice(1, 4).join('\n  '));
  console.log('');
  console.log('  Скопируйте эти строки — по ним видно, что именно сломалось.');
  try {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question('  Enter — закрыть окно… ').then(() => { rl.close(); process.exit(0); });
  } catch { process.exit(0); }
});
