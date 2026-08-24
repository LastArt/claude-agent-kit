#!/usr/bin/env node
/**
 * Баннер Claude Agent Kit: логотип, версия и состояние набора в этом проекте.
 *
 *   node .claude/hooks/banner.mjs             ASCII-баннер для терминала (установщики)
 *   node .claude/hooks/banner.mjs --compact   одна строка (хук SessionStart)
 *   node .claude/hooks/banner.mjs --welcome   markdown окна приветствия (с картинкой)
 *
 * Про два разных вида. Вывод хука попадает в терминал как обычный текст — картинку туда
 * не вставить, поэтому там ASCII-рисунок. А `--welcome` отдаёт markdown, который помощник
 * вставляет В СВОЙ ОТВЕТ: он рендерится как markdown, и логотип показывается настоящей
 * картинкой. Шаблон текста — в .claude/WELCOME.md, правится без правки этого файла.
 *
 * Версия читается из .claude/VERSION — единственного места, где она хранится.
 * Скрипт ничего не меняет и никогда не падает: не смог что-то прочитать — покажет
 * то, что смог, и выйдет с нулём.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Логотип — текстовый, и это вынужденно: окно чата Claude Code не отображает локальные
 * картинки, `![...](logo.png)` показался бы там сырой строкой. PNG используется в README
 * на GitHub, где картинки работают, а здесь нужен знак, который виден везде.
 *
 * Рисунок лежит в .claude/assets/logo.txt — меняется без правки этого файла.
 */
const WORDMARK = 'C L A U D E   A G E N T   K I T';

/** Приводит рисунок к единому виду: LF, без пустых строк по краям. */
function art(file) {
  return read(path.join(KIT_DIR, 'assets', file))
    .replace(/\r\n?/g, '\n')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '');
}

const LOGO = art('logo.txt');

/**
 * Компактный знак для узких окон. Порядок такой:
 *   1. assets/logo-mini.txt — если он есть, значит вид задан руками, и это главнее всего;
 *   2. первый блок logo.txt (монограмма до пустой строки) + подпись — чтобы узкий вариант
 *      оставался частью настоящего знака, а не отдельным рисунком;
 *   3. одна подпись текстом — когда рисунков нет вовсе.
 */
const MINI = art('logo-mini.txt')
  || (LOGO ? `${LOGO.split(/\n[ \t]*\n/)[0]}\n\n${WORDMARK}` : '');

const widthOf = (art) => (art ? Math.max(...art.split('\n').map((l) => l.length)) : 0);

/**
 * Для терминала знак приходится выбирать по ширине окна: длинные строки там не
 * прокручиваются, а переносятся, и рисунок рассыпается. В приветствии этой беды нет —
 * оно уходит в блок кода с горизонтальной прокруткой, поэтому там всегда полный логотип.
 */
/**
 * Показываем ПОЛНЫЙ логотип всегда. Он поджат до ~117 колонок и помещается в стандартную
 * консоль (Windows по умолчанию 120). В совсем узком окне рисунок может перенестись — это
 * осознанный компромисс: полный знак важнее. Нет полного — mini, затем подпись текстом.
 */
function logoForTerminal() {
  return LOGO || MINI || WORDMARK;
}

const version = read(path.join(KIT_DIR, 'VERSION')).trim() || 'не указана';

// Отпечаток набора рядом с номером: версию поднимают не на каждую правку, и без него
// «1.8.0» в двух местах может означать разные наборы файлов. Считается по ship.list;
// нет списка — просто не показываем, баннер из-за этого не ломается.
let stamp = '';
try {
  const { fingerprint } = await import('./kit-fingerprint.mjs');
  const fp = fingerprint(KIT_DIR);
  if (fp) stamp = ' · ' + fp;
} catch { /* модуль не доехал — покажем одну версию */ }
const versionStamped = version + stamp;
const agents = countMd(path.join(KIT_DIR, 'agents'));
const commands = countMd(path.join(KIT_DIR, 'commands'));
const profileFilled = read(path.join(KIT_DIR, 'PROJECT_PROFILE.md')).includes('🟢');

if (process.argv.includes('--compact')) {
  const profile = profileFilled ? 'профиль заполнен' : 'профиль НЕ заполнен → /cckit_research';
  process.stdout.write(`⬢ Claude Agent Kit ${versionStamped} · агентов: ${agents} · команд: ${commands} · ${profile}\n`);
  process.exit(0);
}

if (process.argv.includes('--welcome')) {
  const tpl = read(path.join(KIT_DIR, 'WELCOME.md'));
  if (!tpl) {
    process.stdout.write('Файл .claude/WELCOME.md не найден — выводить нечего.\n');
    process.exit(0);
  }
  const next = profileFilled
    ? '> Набор настроен под этот проект. Опишите задачу — и поехали.'
    : '> **Первый шаг:** выполните `/cckit_research` — набор изучит проект и подстроится '
      + 'под его язык, команды и структуру. После этого полностью перезапустите VS Code.';
  process.stdout.write(
    tpl
      .replace(/<!--[\s\S]*?-->\s*/, '')                 // служебный комментарий наружу не нужен
      .replaceAll('{{LOGO}}', `${fence(LOGO)}\n${LOGO}\n${fence(LOGO)}`)
      .replaceAll('{{VERSION}}', version)
      .replaceAll('{{AGENTS}}', String(agents))
      .replaceAll('{{COMMANDS}}', String(commands))
      .replaceAll('{{PROFILE}}', profileFilled ? 'заполнен' : 'ещё не заполнен')
      .replaceAll('{{NEXT}}', next)
  );
  process.exit(0);
}

if (process.argv.includes('--mini')) {
  // Компактная шапка для вставки в ответ команды: логотип + версия + черта. Без повторов.
  process.stdout.write(`${fence(LOGO)}\n${LOGO}\n${fence(LOGO)}\n\n**Claude Agent Kit** · версия ${versionStamped}\n\n---\n`);
  process.exit(0);
}

// Название подписывается внутри logoForTerminal() — только к монограмме.
// В полном логотипе оно уже нарисовано, второй раз писать не нужно.
process.stdout.write('\n' + logoForTerminal() + '\n');
process.stdout.write(`\n        версия ${versionStamped}\n\n`);
process.stdout.write('  Агент Кит установлен. Откройте VS Code (или полностью перезапустите, если он уже открыт) — команды читаются при старте.\n\n');
process.stdout.write('  Дальше — что делать, если у вас:\n\n');
process.stdout.write('  а) УЖЕ есть проект:\n');
process.stdout.write('     откройте его в VS Code -> включите расширение Claude Code (Enable) ->\n');
process.stdout.write('     новая сессия чата -> /cckit_install (поставит Агент Кит в проект) ->\n');
process.stdout.write('     затем /cckit_research и следуйте подсказкам.\n\n');
process.stdout.write('  б) НОВЫЙ проект:\n');
process.stdout.write('     откройте VS Code -> включите расширение Claude Code (Enable) ->\n');
process.stdout.write('     новая сессия чата -> /cckit_new-project <имя> -> дальше Агент Кит подскажет.\n\n');
process.stdout.write('  Справка по командам: /cckit_help\n\n');
process.stdout.write('  ПОМНИТЕ: на рабочем столе появилась иконка "Claude Agent Kit" —\n');
process.stdout.write('  там подробная инструкция по работе. Откройте её, если что-то непонятно.\n');

function read(p) { try { return readFileSync(p, 'utf8'); } catch { return ''; } }

/**
 * Ограда для блока кода, которая заведомо длиннее любой последовательности обратных кавычек
 * внутри рисунка. Без этого логотип с ``` внутри разорвал бы markdown приветствия.
 */
function fence(art) {
  let f = '```';
  while (art.includes(f)) f += '`';
  return f;
}
function countMd(dir) {
  try { return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).length : 0; }
  catch { return 0; }
}
