#!/usr/bin/env node
/**
 * ОДНА ТОЧКА ВХОДА В ПРОВЕРКИ ПУЛЬТА: пять инструментов, итог одной строкой.
 *
 *   node pult/tools/check-all.mjs [--selftest]
 *
 * ЗАЧЕМ ОНА ЕСТЬ И ПОЧЕМУ НЕ В БЛОКЕ МАШИННОЙ ПРИЁМКИ. Решение человека 03.09.2026:
 * инструменты пульта в блок `CCKIT:VERIFY` НЕ ВКЛЮЧАЮТСЯ. Довод фактический, а не вкусовой:
 * блок гоняет Stop-гейт на КАЖДОМ завершении хода, потолок у него 120 секунд, и все пять его
 * нынешних проверок — уровня `node --check` и баннера. Пять инструментов со стендами, копиями
 * пульта и headless-браузером идут минутами; поставленные в блок, они сделали бы работу
 * невыносимой, и приёмку выключили бы ЦЕЛИКОМ — то есть лечение вышло бы хуже болезни.
 *
 * Вместо этого — одна команда ПЕРЕД КОММИТОМ. Довод человека дословно: «пять команд руками
 * не запускают, одну запускают».
 *
 * ТРИ ИСХОДА, А НЕ ДВА, И ЭТО ГЛАВНОЕ СВОЙСТВО ИТОГОВОЙ СТРОКИ. У инструментов есть код 3 —
 * «прогон ничего не доказывает»: нет привилегии на файловую символическую ссылку, не найден
 * headless-браузер, не установлен Electron, недоступна мастер-копия набора. Превратить
 * «не доказано» в «зелено» — ровно та подмена, которую эта фаза ловила пять раз подряд,
 * поэтому итог различает:
 *
 *   зелено          все пять вернули 0: проверено всё, что они обещают;
 *   НЕ ДОКАЗАНО     красного нет, но часть случаев не выполнялась — названо СЛОВАМИ;
 *   КРАСНО          хоть один нашёл расхождение либо не смог отработать.
 *
 * КРАСНОЕ СИЛЬНЕЕ «НЕ ДОКАЗАНО»: если что-то расходится, итог красный, даже когда рядом
 * что-то не проверялось. Ноль означает ровно одно — проверено и сошлось.
 *
 * ОТДЕЛЬНЫЕ ИНСТРУМЕНТЫ ЭТА ТОЧКА НЕ ЗАМЕНЯЕТ И НЕ ПРЯЧЕТ: у каждого свои ключи, свои
 * отрицательные пробы (`--negative <имя>`) и свой подробный вывод. Здесь — сводка для человека,
 * который решает, идти ему коммитить или сначала включить режим разработчика.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const BULLET = String.fromCharCode(8226);
const out = (s = '') => process.stdout.write(s + NL);
const err = (s = '') => process.stderr.write('[пульт] ' + s + NL);

/** Минут на инструмент хватает с запасом: самый долгий — проверка страницы. */
const TOOL_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * ПЯТЬ ИНСТРУМЕНТОВ, порядок — от быстрого к долгому: человек видит первое красное раньше,
 * а не через десять минут. Числа проверок и проб держатся здесь ради итоговой строки; они же
 * записаны в протоколе приёмки, и расхождение видно глазами при первом же прогоне.
 */
const TOOLS = Object.freeze([
  { file: 'kitrun-check.mjs', title: 'команды набора', checks: 6, probes: 5 },
  { file: 'wizard-check.mjs', title: 'мастер установки', checks: 6, probes: 3 },
  { file: 'deploy-check.mjs', title: 'раскладка набора', checks: 7, probes: 25 },
  { file: 'shell-check.mjs', title: 'оболочка', checks: 3, probes: 4 },
  { file: 'page-check.mjs', title: 'страница', checks: 9, probes: 9 },
]);

/**
 * ЧТО ИМЕННО НЕ ДОКАЗАНО — СЛОВАМИ, А НЕ КОДОМ. Инструмент объясняет это своей строкой,
 * но строка длинная и лежит в конце трёх экранов вывода; человеку в итог нужна фраза,
 * из которой видно, ЧТО включить, чтобы стало доказано.
 *
 * Образцы ищутся в выводе инструмента; не нашлось ни одного — печатается его собственная
 * строка объяснения, а если и её нет, честное «инструмент вернул 3 и причины не назвал».
 */
/**
 * ЧТО ИМЕННО НЕ ДОКАЗАНО — СЛОВАМИ, А НЕ КОДОМ.
 *
 * Образцы — ЭТО НАСТОЯЩИЕ ФРАЗЫ, КОТОРЫМИ ИНСТРУМЕНТЫ ВЫХОДЯТ С КОДОМ 3, снятые из их кода,
 * а не придуманные по памяти. Первая редакция таблицы их придумала — и из шести образцов
 * работал ОДИН: на машине без Electron и без браузера, то есть в самом частом случае
 * «не доказано», итог печатал «причины не назвал» (находка ревью 03.09.2026).
 *
 * Второй урок той же находки: два образца указывали на `kit-deploy.mjs`
 * и `write-scope-check.mjs`, которых точка входа НЕ ЗАПУСКАЕТ вовсе. Образец на незапускаемый
 * инструмент — это строка, которая выглядит рабочей и не работает; таких здесь больше нет.
 *
 * Порядок значим: первым идёт самый частый случай. Совпадений бывает несколько — печатаются
 * все: инструмент вправе не доказать двух разных вещей сразу.
 */
const REASONS = Object.freeze([
  {
    mark: 'файловую ссылку создать не удалось',
    text: 'раскладка — выход по ФАЙЛОВОЙ символической ссылке: нужен режим разработчика Windows'
      + ' либо права администратора',
  },
  {
    mark: 'Electron не установлен',
    text: 'оболочка — Electron не установлен: npm ci в pult/shell, затем'
      + ' node node_modules/electron/install.js',
  },
  {
    mark: 'Electron не виден через точку соединения',
    text: 'оболочка — Electron не виден через точку соединения стенда',
  },
  {
    mark: 'headless-браузера в окружении нет',
    text: 'страница — не найден headless-браузер: Chrome, Edge или Chromium; путь задаётся'
      + ' переменной CCKIT_CHROME',
  },
  {
    mark: 'git не разрешился по PATH',
    text: 'страница — git не разрешился по PATH: стенд-репозиторий не собрать',
  },
  {
    mark: 'без мастер-копии набора этот прогон ничего не доказывает',
    text: 'мастер установки — мастер-копия набора недоступна (поставьте набор установщиком)',
  },
  {
    mark: 'каталог стендов обязан быть ВНЕ этого репозитория',
    text: 'каталог стендов оказался внутри репозитория — прогон отменён',
  },
  {
    mark: 'каталог стендов обязан лежать ВНУТРИ временного каталога',
    text: 'каталог стендов вне временного каталога системы: подмена источника там запрещена',
  },
  {
    mark: 'не подключились зависимости',
    text: 'оболочка — не подключились зависимости стенда (нужен npm ci)',
  },
  {
    mark: 'стенд не завёлся в реестр прогона',
    text: 'стенд не завёлся во временный реестр прогона',
  },
  { mark: 'демон стенда не ответил', text: 'страница — демон стенда не ответил' },
  { mark: 'строка порта в копии не нашлась', text: 'стенд занял бы боевой порт — прогон отменён' },
  { mark: 'не отработал:', text: 'инструмент упал — разбирайте его вывод выше' },
]);

const UNPROVEN_MARKS = ['НЕ ДОКАЗАНО', 'ничего не доказ', 'СЛУЧАЙ НЕ ЗАВЁЛСЯ', 'случай пропущен'];

/**
 * Человеческие слова про непроведённое.
 *
 * Образцы `REASONS` взяты ДОСЛОВНО из ветвей отказа самих инструментов, поэтому короткого
 * слова вроде «порт» среди них нет: именно оно в первой редакции нашлось внутри «импортов»
 * и дописало в итог причину, которой не было. Лечится это длиной образца, а не сужением
 * области поиска — сужение до строк под заголовком убило пять образцов из шести.
 */
export function unprovenWords(text) {
  const lines = text.split(NL).map((l) => l.split(CR).join(''));

  // ОБРАЗЦЫ ИЩУТСЯ ПО ВСЕМУ ВЫВОДУ, а не только под заголовком «НЕ ДОКАЗАНО». Причина в том,
  // ЧЕМ инструменты выходят: «Electron не установлен» печатается в поток ошибок и никакого
  // заголовка рядом не имеет. Сужение до заголовка выглядело аккуратным и убивало пять
  // образцов из шести.
  //
  // Ложных совпадений это не даёт: образцы — длинные фразы из ветвей отказа, а сама функция
  // зовётся ТОЛЬКО для инструмента, вернувшего 3.
  const found = [];
  for (const line of lines) {
    for (const r of REASONS) {
      if (line.includes(r.mark) && !found.includes(r.text)) found.push(r.text);
    }
  }
  if (found.length) return found;

  // ЗАПАСНОЙ ПУТЬ: ни один образец не подошёл — берём собственную строку инструмента. Сначала
  // строки под заголовком «НЕ ДОКАЗАНО» и с метками непроведённого, затем — последняя непустая
  // строка вывода: инструмент что-то сказал, и показать это лучше, чем промолчать.
  const head = lines.findIndex((l) => l.includes('НЕ ДОКАЗАНО'));
  const tail = head >= 0 ? lines.slice(head + 1) : [];
  const marked = lines.filter((l) => UNPROVEN_MARKS.some((m) => l.includes(m)));
  const candidates = [...new Set([...tail, ...marked, ...lines.slice().reverse()])]
    .filter((l) => l.trim());
  for (const line of candidates) {
    const bare = line.trim();
    const clean = bare.startsWith(BULLET) ? bare.slice(BULLET.length).trim() : bare;
    if (clean && !clean.startsWith('НЕ ДОКАЗАНО')) {
      return [clean.length > 160 ? `${clean.slice(0, 160)}…` : clean];
    }
  }
  return [];
}

/**
 * ОКРУЖЕНИЕ РЕБЁНКА: переменная запуска Electron в режиме Node снимается ЯВНО. Она бывает
 * выставлена в окружении редактора, и под ней проверка оболочки не поднимает окна вовсе —
 * прогон сказал бы «окно не открылось» и увёл разбор в сторону. Ту же дисциплину держит
 * сам `shell-check.mjs` для своих детей; здесь она повторена для него самого.
 */
function childEnv() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.toUpperCase().startsWith('ELECTRON_')) delete env[name];
  }
  return env;
}

/** Один инструмент: код возврата, время и его собственный вывод. */
function runTool(tool) {
  const started = Date.now();
  const res = spawnSync(process.execPath, [path.join(HERE, tool.file)], {
    cwd: path.resolve(HERE, '..', '..'),
    env: childEnv(),
    encoding: 'utf8',
    timeout: TOOL_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  const text = (res.stdout || '') + (res.stderr || '');
  const code = res.error ? 3 : (res.status === null ? 3 : res.status);
  return { tool, code, text, seconds: Math.round((Date.now() - started) / 1000) };
}

/** Слово исхода по коду возврата инструмента. */
function word(code) {
  if (code === 0) return 'зелено';
  if (code === 3) return 'НЕ ДОКАЗАНО';
  if (code === 2) return 'КРАСНО (проба не покраснела)';
  return 'КРАСНО';
}

/**
 * ИТОГ ОДНОЙ СТРОКОЙ. Функция отделена от прогона намеренно: так её можно показать на трёх
 * выдуманных исходах (`--selftest`), не имея под рукой машины, где все пять зелены.
 * Возвращает `{code, lines}`.
 */
export function verdict(results) {
  const red = results.filter((r) => r.code !== 0 && r.code !== 3);
  const unproven = results.filter((r) => r.code === 3);
  const green = results.filter((r) => r.code === 0);
  const checks = results.reduce((n, r) => n + r.tool.checks, 0);
  const probes = results.reduce((n, r) => n + r.tool.probes, 0);
  const lines = [];

  if (red.length) {
    lines.push(`ИТОГ: КРАСНО. Нашли расхождение: ${red.length} из ${results.length} — `
      + red.map((r) => `${r.tool.file} (код ${r.code})`).join(', '));
    for (const r of red) lines.push(`  ${r.tool.file}: ${r.tool.title} — разбирайте вывод выше`);
    lines.push('Коммитить рано.');
    return { code: 1, lines };
  }

  if (unproven.length) {
    lines.push('ИТОГ: НЕ ДОКАЗАНО ПОЛНОСТЬЮ.'
      + ` Зелёных инструментов: ${green.length}. Не доказали своё: ${unproven.length}.`);
    for (const r of unproven) {
      const words = unprovenWords(r.text);
      if (words.length) for (const w of words) lines.push(`  ${r.tool.file}: ${w}`);
      else lines.push(`  ${r.tool.file}: вернул 3 и причины не назвал — прочитайте вывод выше`);
    }
    lines.push('Красного нет; названное выше не проверено ничем — решайте сами, идти ли коммитить.');
    return { code: 3, lines };
  }

  lines.push('ИТОГ: зелено.'
    + ` Инструментов: ${results.length}. Проверок: ${checks}. Отрицательных проб: ${probes}.`
    + ' Непроведённого нет.');
  return { code: 0, lines };
}

/** Три исхода на выдуманных результатах: видно, что итог различает их, а не сводит к двум. */
function selftest() {
  const all = TOOLS.map((t) => ({ tool: t, code: 0, text: '', seconds: 1 }));
  out('три исхода итоговой строки на выдуманных результатах:');
  out('');
  for (const v of [
    verdict(all),
    verdict(all.map((r, i) => (i === 2
      // Текст берётся НАСТОЯЩИЙ — тот, которым `deploy-check` выходит с кодом 3 на машине
      // без привилегии: выдуманный текст показывал бы вёрстку итога, но не работу образцов.
      ? { ...r, code: 3, text: '  • файловую ссылку создать не удалось: про выход по ссылке'
        + ' этот прогон НИЧЕГО НЕ ДОКАЗЫВАЕТ (нужна привилегия или режим разработчика Windows)' }
      : r))),
    verdict(all.map((r, i) => (i === 0 ? { ...r, code: 1, text: '' } : r))),
  ]) {
    for (const line of v.lines) out('  ' + line);
    out(`  → код возврата ${v.code}`);
    out('');
  }
  return 0;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    out('Все проверки пульта одной командой (запускать ПЕРЕД КОММИТОМ):');
    out('  node pult/tools/check-all.mjs [--selftest]');
    out('');
    out('Инструменты остаются запускаемыми поимённо — у каждого свои ключи и свои пробы:');
    for (const t of TOOLS) out(`  node pult/tools/${t.file.padEnd(20)} ${t.title}`);
    return 0;
  }
  if (args.includes('--selftest')) return selftest();
  if (args.length) { err(`неизвестный ключ: ${args[0]}`); return 3; }

  const checks = TOOLS.reduce((n, t) => n + t.checks, 0);
  const probes = TOOLS.reduce((n, t) => n + t.probes, 0);
  out(`проверки пульта: инструментов ${TOOLS.length}, проверок ${checks}, проб ${probes}`);
  out('это НЕ машинная приёмка набора: блок CCKIT:VERIFY их не запускает и никогда не запускал');
  out('');

  const results = [];
  for (const tool of TOOLS) {
    process.stdout.write(`  ${tool.file.padEnd(20)} ${tool.title.padEnd(20)} …`);
    const r = runTool(tool);
    results.push(r);
    out(` код ${r.code}  ${word(r.code)}  (${r.seconds} с)`);
    if (r.code === 3) for (const w of unprovenWords(r.text)) out(`      • ${w}`);
    if (r.code !== 0 && r.code !== 3) {
      // Красное показывается СТРОКАМИ ИНСТРУМЕНТА, а не пересказом: он объясняет лучше.
      const said = r.text.split(/\r?\n/).filter((l) => l.trim().startsWith('•'));
      for (const line of said.slice(0, 6)) out(`      ${line.trim()}`);
    }
  }

  out('');
  const v = verdict(results);
  for (const line of v.lines) out(line);
  return v.code;
}

// ЗАПУСК ТОЛЬКО КОГДА ЭТОТ ФАЙЛ — ТОЧКА ВХОДА. Без этой развилки `import` модуля ради
// разбора (`verdict()`, `unprovenWords()`) запускал бы все пять инструментов: ревью так
// и мерило таблицу причин, и первый же вызов уводил прогон в сорок секунд чужой работы.
// Тот же приём стоит у самотеста `pult/lib/fs-safe.mjs`.
const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (entryPoint === import.meta.url) process.exit(main());
