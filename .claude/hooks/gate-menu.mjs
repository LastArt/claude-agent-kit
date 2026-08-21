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

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERIFY = path.join(KIT, 'hooks', 'verify.mjs');
const GATE = path.join(KIT, 'hooks', 'gate.mjs');
const PROFILE = path.join(KIT, 'PROJECT_PROFILE.md');

const run = (script, args = []) =>
  spawnSync(process.execPath, [script, ...args], { stdio: 'inherit', cwd: path.dirname(KIT) });

const quiet = (script, args = []) =>
  spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: path.dirname(KIT) });

function state() {
  const out = { checks: 0, accepted: false, armed: false, task: '', verify: 'none', status: '' };
  const h = quiet(VERIFY, ['--hash']);
  try {
    const j = JSON.parse(String(h.stdout || '').replace(/^\[verify\]\s*/, ''));
    out.checks = j.count || 0;
    out.accepted = !!j.accepted;
  } catch { /* профиль без блока — так и оставим нули */ }
  const s = quiet(GATE, ['--status']);
  const text = String(s.stdout || '');
  out.armed = !text.includes('не взведён');
  out.task = (text.match(/задача:\s*(.+)/) || [, ''])[1].trim();
  out.status = (text.match(/статус:\s*(\S+)/) || [, ''])[1];
  out.verify = (text.match(/приёмка:\s*(\S+)/) || [, ''])[1];
  return out;
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
    else if (answer === '1') run(VERIFY, ['--show']);
    else if (answer === '2') run(VERIFY, ['--accept']);
    else if (answer === '3') run(VERIFY);
    else if (answer === '4') {
      const task = (await rl.question('  Над чем работаете (одной строкой)? ')).trim();
      run(GATE, ['--arm', task || 'задача без названия']);
    } else if (answer === '5') run(GATE, ['--disarm']);
    else if (answer === '6') openProfile();
    else if (answer === '7') about();
    else console.log('  Не понял. Введите цифру из списка.');
    console.log('');
    await rl.question('  Enter — вернуться в меню… ');
  }
  rl.close();
  console.log('  До встречи.');
}

main().catch((e) => {
  console.log(`  Что-то пошло не так: ${e && e.message ? e.message : e}`);
  process.exit(0);
});
