#!/usr/bin/env node
/**
 * ПОСТОЯННЫЕ МАШИННЫЕ ПРОВЕРКИ СТРАНИЦЫ: полотно сравнения и кнопки редактора.
 *
 *   node pult/tools/page-check.mjs [каталог для стендов] [--negative <проба>]
 *
 * ЗАЧЕМ ЭТОТ ИНСТРУМЕНТ ВООБЩЕ ЕСТЬ. Два дефекта фазы 2 нашёл человек руками ПОСЛЕ вердикта
 * ревью: полотно сравнения схлопывалось в полосу в несколько пикселей после изменения размера
 * окна, а «Сохранить» была активна на только что открытом файле без единой правки. Описания
 * обеих проверок жили в `PLAN.md`, а папка задач выведена из-под git — закрытие задачи
 * уничтожило бы их вместе с задачей, и оба дефекта снова остались бы не стережёнными ничем.
 * Здесь они переписаны в исполняемый вид.
 *
 * ЧТО МЕРИТСЯ И КОГДА КРАСНЕЕТ — по одной строке на проверку, потому что проверка без
 * названного условия провала не проверка, а показания.
 *
 *   1. ПОЛОТНО СРАВНЕНИЯ. Меряется РЕДАКТОР СРАВНЕНИЯ ВНУТРИ полотна (`.monaco-diff-editor`
 *      внутри `#diff-host`), а не сам `#diff-host`. Краснеет, если высота редактора меньше
 *      0,9 высоты полотна или меньше 120 px, если высота полотна меньше половины панели
 *      `#pane-diff`, либо если видимых строк в нём меньше десяти. Мерить одну высоту
 *      `#diff-host` НЕДОСТАТОЧНО — именно так находка и проскочила мимо ревью: на больной
 *      странице `#diff-host` был 601 из 601, а полосой в 5 px был редактор ВНУТРИ него.
 *      Меряется ДВАЖДЫ: сразу после открытия файла и после полного пути болезни —
 *      «показать дифф → уйти на другую вкладку → позвать изменение размера → вернуться».
 *      Одного первого замера мало: на больном коде он зелёный.
 *
 *   2. КНОПКИ РЕДАКТОРА И ОТМЕТКА ПРАВКИ. Краснеет, если сразу после открытия файла
 *      «Сохранить» активна или отметка `#editor-dirty` видна; если после правки модели
 *      «Сохранить» осталась неактивной или отметка не появилась; если после сохранения
 *      «Сохранить» осталась активной, отметка не погасла или на диске старый текст.
 *      Отдельной строкой меряется «Перечитать»: при открытом файле она обязана быть активной.
 *
 *   3. СТРОКА ПРО НЕОТСЛЕЖИВАЕМЫЕ. Вкладка диффов считает `git diff HEAD` и новых файлов
 *      не показывает. Краснеет, если под списком нет строки про неотслеживаемые либо если
 *      число в ней разошлось с тем, что видит `git status` (на стенде их ровно два: файл
 *      и каталог целиком). Молчаливо неполный список — это дефект, а не особенность.
 *
 *   4. ПОЛОТНО СРАВНЕНИЯ ГОВОРИТ ПРИЧИНУ (фаза 3). Загрузчик редактора глушится БЛОКИРОВКОЙ
 *      ЕГО ЗАПРОСА через протокол отладчика с последующей перезагрузкой страницы — файлы
 *      стенда при этом не правятся ни одним байтом. Клик по файлу во вкладке диффов обязан
 *      оставить непустую строку итога С ПРИЧИНОЙ. Краснеет, если строка пуста или НЕ
 *      ИЗМЕНИЛАСЬ: молчащее полотно со стороны неотличимо от «пульт завис». Блокировка
 *      недоступна — код 3, а не тихий зелёный. Идёт ПОСЛЕДНЕЙ: после неё редактора на
 *      странице нет вовсе.
 *
 *   5. ТЕРМИНАЛ НЕ МЕРЯЕТСЯ СПРЯТАННЫМ (фаза 3). Спрятанному узлу браузер отдаёт нули,
 *      подгонка на нулях считает одну колонку и одну строку и ОТСЫЛАЕТ ЭТОТ РАЗМЕР ДЕМОНУ —
 *      псевдотерминал начинает переносить строки по одному знаку. Поднимается сессия оболочки,
 *      дальше уход на вкладку диффов, обе ручки (изменение размера окна и сворачивание правой
 *      колонки) и подсчёт строк БЕЗ возврата на вкладку терминала. Краснеет при числе строк
 *      меньше `TERM_MIN_ROWS`. Сессия не поднялась — код 3.
 *
 *   6. ПЕРЕКЛЮЧАТЕЛЬ РЕЖИМА НЕ ВРЁТ (фаза 3). Раньше редактор сравнения САМ уходил на ленту
 *      на узком полотне, а кнопка продолжала обещать две колонки. Окно сужается так, чтобы
 *      полотно стало уже порога, и меряется ширина ЛЕВОЙ СТОРОНЫ сравнения в обоих режимах,
 *      плюс подпись «узко». Пороги и запрет сравнивать с нулём — у `MODE_DEAD_PX`: в ленточном
 *      режиме левая сторона НЕ обнуляется, там остаётся фиксированная полоса.
 *
 *   7. ДЕРЕВО НЕ ТЕРЯЕТСЯ ПРИ ПЕРЕКЛЮЧЕНИИ ПРОЕКТОВ (фаза 3, по находке человека). В реестре
 *      прогона ДВА стенда, у второго свой файл-метка. Проверка уходит во второй, возвращается
 *      в первый и РАСКРЫВАЕТ каталог — то самое действие, на котором человек увидел отказ.
 *      Краснеет, если дерево показывает файлы предыдущего проекта, если своих файлов в нём нет
 *      или если раскрытый каталог сообщает об отказе. Предусловием считается только
 *      «дерево вообще наполнилось»: всё остальное обязано краснеть, а не выдавать «ничего
 *      не доказано», иначе больной код прячется за отказом проверки.
 *
 *   8. СТРАНИЦА ГОВОРИТ, ЧТО СВЯЗИ С ДЕМОНОМ НЕТ (фаза 3, по находке человека). Демон стенда
 *      гасится намеренно, поэтому проверка идёт САМОЙ ПОСЛЕДНЕЙ. Дальше делается то же, что
 *      делал человек, — переключение проекта, а не нажатие «Обновить»: та кнопка красит полосу
 *      сама и на прежнем коде, и проверка на ней была бы зелёной (выяснено пробой). Краснеет,
 *      если после обрыва полоса состояния осталась прежней или точка не стала тревожной.
 *
 * ОТРИЦАТЕЛЬНЫЕ ПРОБЫ ВСТРОЕНЫ, потому что «проверка обязана уметь провалиться» — это
 * свойство, которое надо уметь показать в любой день, а не только в день написания.
 * `--negative layout` возвращает `layout()` во вкладке диффов к прежней форме (вызов без
 * размеров), `--negative buttons` возвращает `setButtons()` к прежней («Сохранить» включена
 * писабельностью, а не правкой), `--negative diffnotice` снимает перехват исключения вокруг
 * подготовки полотна, `--negative termhidden` снимает проверку видимости в подгонке терминала,
 * `--negative diffmode` снимает явный порог при создании полотна. Полный список печатает
 * `--help`. ПРАВИТСЯ ТОЛЬКО КОПИЯ СТЕНДА, файлы репозитория не трогаются
 * ни в одном режиме. Проба, не наложившаяся на текст (код изменился), — это код 3, а не тихий
 * зелёный: непроверенное называется.
 *
 * СТЕНД СВОЙ И ПОРТ СВОЙ. Демон человека может быть поднят на боевом порту, и трогать его
 * нельзя: инструмент разворачивает КОПИЮ пульта во временном каталоге, ставит ей свободный
 * порт правкой её собственного `config.mjs` и поднимает демона на нём. Реестр тоже свой
 * (каталог настроек подменяется временным), проект в реестре один — стенд, заведённый этим же
 * прогоном. Ни одного запроса к чужому демону и ни одной записи в чужой проект.
 *
 * ЗАЧЕМ КОПИЯ, А НЕ КЛЮЧ ЗАПУСКА: порт лежит в `PORT` (`pult/config.mjs`), и из него же
 * считаются белые списки `Host` и `Origin`. Демон, поднятый на другом порту без правки этих
 * списков, отвечал бы браузеру 403 на каждый запрос — то есть страница не открылась бы вовсе.
 * Поэтому меняется одна строка в копии, а не поведение демона.
 *
 * КОПИЯ СОБИРАЕТСЯ ЖЁСТКИМИ ССЫЛКАМИ ТАМ, ГДЕ ЭТО БЕЗОПАСНО. Привезённые сборки (`web/vendor`,
 * 25 МБ) переносятся `link()`: для читателя страницы это обычные файлы, а `realpath` у них
 * свой собственный — то есть проверка вложенности в каталог страницы (`findStatic()`
 * в `pult/lib/static.mjs`) проходит, чего символическая ссылка не дала бы. Исходники
 * копируются побайтно: жёсткая ссылка делит содержимое с оригиналом, и правка стенда испортила
 * бы репозиторий. `node_modules` подключается точкой соединения — разрешение модулей Node
 * канонизацию путей переживает, а проверок вложенности там нет.
 *
 * ГРАНИЦА УТВЕРЖДЕНИЯ. Инструмент меряет СТРАНИЦУ на стенде в headless-браузере: раскладку,
 * состояние кнопок и текст под списком. Он не говорит ничего ни о границе записи (это
 * `pult/tools/write-scope-check.mjs`), ни о целости набора (`pult/tools/no-write-check.mjs`),
 * ни о том, как страница выглядит в другом движке: браузер здесь один и тот, что нашёлся
 * на машине.
 *
 * Инструмент читает и пишет диск напрямую (`node:fs/promises`) намеренно: он не часть демона,
 * и правило «только примитивы `pult/lib/fs-safe.mjs`» относится к читателям, чьё содержимое
 * уезжает в HTTP-ответ. Наружу отсюда не уходит ничего, кроме строк в консоли.
 *
 * Коды возврата: 0 — все проверки зелёные; 1 — проверка провалилась (в отрицательной пробе
 * это ожидаемый исход); 2 — отрицательная проба НЕ покраснела, то есть проверка ничего
 * не стережёт; 3 — прогон ничего не доказывает (нет браузера, нет git, демон не поднялся,
 * страница не открылась, проба не наложилась).
 */

import {
  mkdtemp, mkdir, readdir, lstat, copyFile, link, symlink, readFile, writeFile, rm, realpath,
} from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

import { WebSocket } from 'ws';

import { resolveCommand, withArgs, gitEnv } from '../lib/fs-safe.mjs';
import { PENDING_REASONS } from '../config.mjs';
import { pathToFileURL } from 'node:url';
import { addProject } from '../lib/registry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PULT = path.resolve(HERE, '..');
const REPO = path.resolve(PULT, '..');

const DAEMON_START_MS = 20000;
const BROWSER_START_MS = 20000;
const WAIT_MS = 20000;
const CDP_CALL_MS = 30000;
const WINDOW = Object.freeze({ width: 1584, height: 749 });
const WINDOW_RESIZED = Object.freeze({ width: 1280, height: 880 });

// --- фаза 3: числа трёх новых проверок ----------------------------------------

/**
/**
 * Узкое окно для проверки 6: полотно диффа при нём заведомо уже порога `NARROW_PX`.
 *
 * Замер, а не глазомер: при окне 1584 полотно 644 px, при 1200 — 260 px, при 1000 — 254 px.
 * Ниже примерно 1200 полотно почти не сжимается: у колонок страницы и списка файлов свои
 * минимумы. Поэтому точное число окна здесь не несущее, и судить по абсолютной ширине сторон
 * нельзя — суждение ниже идёт ДОЛЯМИ.
 */
const WINDOW_NARROW = Object.freeze({ width: 1200, height: 800 });

/**
 * Порог «узко» — ТО ЖЕ ЧИСЛО, что `NARROW_PX` в `pult/web/diff.mjs`.
 *
 * Копия здесь намеренная и работает сторожем: разойдутся — проверка 6 покраснеет на подписи,
 * и это верный исход, а не ложная тревога. Число не выдумано ни там, ни здесь: 900 —
 * собственное значение редактора сравнения по умолчанию (`renderSideBySideInlineBreakpoint`),
 * на котором он раньше САМ уходил на ленту.
 */
const NARROW_PX = 900;

/**
 * ПОЧЕМУ РЕЖИМ МЕРЯЕТСЯ ДОЛЯМИ, А НЕ СРАВНЕНИЕМ С НУЛЁМ.
 *
 * В ленточном режиме левая сторона НЕ обнуляется: редактор сравнения оставляет узкую полосу.
 * Замерено трижды, на разных ширинах полотна: 484 px → 38, около 1100 px → 38, 260 px → 38.
 * Остаток ФИКСИРОВАННЫЙ и от ширины не зависит. Живая сторона, наоборот, идёт долей полотна:
 * 227 при 484, 515 при ~1100, 115 при 260 — то есть 44–47% в каждом замере.
 *
 * Отсюда суждение долями, а не пикселями: доля переживает и другой шрифт, и другую полосу
 * прокрутки, и другую машину. `MODE_LIVE_RATIO = 0.30` взято с запасом от измеренных 44–47%;
 * `MODE_DEAD_RATIO = 0.20` — сверху от измеренных 15% (38 из 260) на самом узком полотне,
 * какое инструмент вообще делает. Между 0,20 и 0,30 остаётся полоса неопределённости,
 * и попасть в неё случайно неоткуда. `MODE_DEAD_PX` держит вторую, независимую от доли
 * дорогу к тому же выводу: фиксированный остаток измерен как 38 px, порог стоит в 2,6 раза
 * выше него.
 *
 * СРАВНЕНИЕ С НУЛЁМ ЗАПРЕЩЕНО ПРЯМО: оно покраснеет на ЗДОРОВОЙ странице (замечено
 * исполнителем на шаге 21 и подтверждено ревью 02.09.2026 своим замером).
 */
const MODE_LIVE_RATIO = 0.30;
const MODE_DEAD_RATIO = 0.20;
const MODE_DEAD_PX = 100;
/** Меньше этого числа строк в терминале — он смерян спрятанным (здоровый держит десятки). */
const TERM_MIN_ROWS = 10;

/** Высота узла, ниже которой не помещается ни одной строки: знакоместо при кегле 13 около 17 px. */
const TERM_ZERO_PX = 20;

// Стенд: сколько строк в файле, по которому смотрится дифф. Число не круглое ради красоты —
// полотну нужно заведомо больше строк, чем помещается в окно, иначе «мало видимых строк»
// перестало бы отличать больное полотно от короткого файла.
const STAND_LINES = 120;
const STAND_UNTRACKED = 2;   // `new.txt` и каталог `newdir/` целиком

/** Файл-метка второго стенда: по нему видно, чьё дерево показано после переключения. */
const SECOND_MARK = 'метка-второго.txt';

const out = (s = '') => process.stdout.write(`${s}\n`);
const err = (s = '') => process.stderr.write(`[pult] ${s}\n`);
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// --- окружение ----------------------------------------------------------------

/** Где искать браузер. Первым — явное указание человека, дальше обычные места установки. */
function browserCandidates() {
  const env = process.env;
  const list = [];
  if (env.CCKIT_CHROME) list.push(env.CCKIT_CHROME);
  for (const base of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]) {
    if (!base) continue;
    list.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    list.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    list.push(path.join(base, 'Chromium', 'Application', 'chrome.exe'));
  }
  list.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
    '/usr/bin/chromium-browser', '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  return list;
}

async function findBrowser() {
  for (const p of browserCandidates()) {
    try {
      const st = await lstat(p);
      if (st.isFile()) return p;
    } catch { /* нет такого — пробуем следующий */ }
  }
  return null;
}

/** Свободный порт: занимаем и тут же отпускаем. Гонка возможна и лечится повтором прогона. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// --- копия пульта под стенд ---------------------------------------------------

/**
 * Разложить копию пульта. Возвращает счётчики — их видно в выводе: молчаливая копия,
 * потерявшая половину файлов, дала бы «страница не открылась» без объяснения.
 */
async function mirror(src, dst, rel = '', tally = { copied: 0, linked: 0 }) {
  await mkdir(dst, { recursive: true });
  for (const name of (await readdir(src)).sort()) {
    if (!rel && name === 'node_modules') continue;   // подключается точкой соединения
    const from = path.join(src, name);
    const to = path.join(dst, name);
    const childRel = rel ? `${rel}/${name}` : name;
    let st;
    try {
      st = await lstat(from);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      await mirror(from, to, childRel, tally);
      continue;
    }
    // Ни симлинков, ни устройств в поставке нет; чужое в стенд не тащим.
    if (!st.isFile()) continue;
    // ЖЁСТКАЯ ССЫЛКА ТОЛЬКО НА ПРИВЕЗЁННЫЕ СБОРКИ: они не правятся ни стендом, ни пробами.
    // Исходники копируются побайтно — правка стенда по жёсткой ссылке испортила бы репозиторий.
    if (childRel.startsWith('web/vendor/')) {
      try {
        await link(from, to);
        tally.linked += 1;
        continue;
      } catch { /* другой том или нет права — копируем */ }
    }
    await copyFile(from, to);
    tally.copied += 1;
  }
  return tally;
}

/**
 * Правка одной строки в копии. Замена — ПО СТРОКАМ, а не `replace()` со строкой: в тексте
 * набора живут `$` и обратные кавычки, и спецпоследовательности замены дважды портили файлы.
 */
async function patchPort(dir, port) {
  const file = path.join(dir, 'config.mjs');
  const lines = (await readFile(file, 'utf8')).split('\n');
  let hits = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('export const PORT = ')) {
      lines[i] = `export const PORT = ${port};`;
      hits += 1;
    }
  }
  if (hits !== 1) return { ok: false, hits };
  await writeFile(file, lines.join('\n'), 'utf8');
  return { ok: true, hits };
}

/**
 * ОТРИЦАТЕЛЬНЫЕ ПРОБЫ: вернуть в КОПИЮ прежнюю (больную) форму кода.
 *
 * Замена через `split/join` намеренно: спецпоследовательностей она не знает. Число вхождений
 * сверяется — не совпало, значит код изменился и проба ничего не докажет.
 */
const PROBES = Object.freeze({
  layout: {
    file: 'web/diff.mjs',
    what: 'layout() без размеров — прежняя форма вызова',
    from: [
      '    const width = host.clientWidth;',
      '    const height = host.clientHeight;',
      '    if (!width || !height) return;',
      '    try { view.layout({ width, height }); } catch { /* полотно не показано */ }',
    ].join('\n'),
    to: '    try { view.layout(); } catch { /* полотно не показано */ }',
  },
  buttons: {
    file: 'web/editor.mjs',
    what: '«Сохранить» включена писабельностью, а не правкой — прежняя форма setButtons()',
    from: '    saveButton.disabled = !(writable && dirty);',
    to: '    saveButton.disabled = !writable;',
  },
  // --- фаза 3: три отложенных дефекта §2.8 контракта --------------------------
  diffnotice: {
    file: 'web/diff.mjs',
    what: 'подготовка полотна без перехвата исключения — прежняя (молчащая) форма showFile()',
    // `while (false) { … }` оставляет ТЕЛО прежнего перехвата синтаксически целым, но
    // недостижимым: получается ровно прежний код — голый вызов и ни слова человеку.
    from: [
      '    try {',
      '      await ensureView();',
      '    } catch (e) {',
    ].join('\n'),
    to: [
      '    await ensureView();',
      '    while (false) {',
      '      const e = new Error(\'проба\');',
    ].join('\n'),
  },
  termhidden: {
    file: 'web/terminal.mjs',
    what: 'подгонка без проверки помещающегося размера — прежняя форма layout()',
    from: [
      '    let dims = null;',
      '    try { dims = fit.proposeDimensions(); } catch { dims = null; }',
      '    // Спрятанная вкладка (`display: none`) даёт здесь нечисловой расчёт — он тоже мимо.',
      '    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;',
      '    if (dims.cols < MIN_COLS || dims.rows < MIN_ROWS) return;',
    ].join('\n'),
    to: '    // проба: подгонка без проверки помещающегося размера',
  },
  diffmode: {
    file: 'web/diff.mjs',
    what: 'создание полотна без явного порога — редактор сравнения сам уходит на ленту',
    from: '      useInlineViewWhenSpaceIsLimited: false,',
    to: '      // проба: без явного порога',
  },
  treeid: {
    file: 'web/tree.mjs',
    what: 'дерево не запоминает новый проект — показывает предыдущий после переключения',
    from: '    projectId = id;',
    to: '    projectId = projectId || id;',
  },
  // --- фаза 4: адреса назначения по причине ожидания -------------------------
  address: {
    file: 'web/addresses.mjs',
    what: 'у причины «заблокировано» пропадает свой адрес — уведомление ведёт в общее окно',
    from: "  blocked: 'state',",
    to: '',
  },
  branch: {
    file: 'web/addresses.mjs',
    what: 'адрес есть, а ветви под него в маршрутизаторе нет — причина молча уходит в общее окно',
    from: "  blocked: 'state',",
    to: "  blocked: 'nowhere',",
  },
  daemondown: {
    file: 'web/app.mjs',
    what: 'обрыв связи ничего не меняет на странице — прежняя форма req()',
    from: '    setDaemonReachable(false);',
    to: '    void 0;',
  },
});

async function applyProbe(dir, kind) {
  const probe = PROBES[kind];
  const file = path.join(dir, ...probe.file.split('/'));
  const text = await readFile(file, 'utf8');
  const parts = text.split(probe.from);
  if (parts.length !== 2) return { ok: false, hits: parts.length - 1 };
  await writeFile(file, parts.join(probe.to), 'utf8');
  return { ok: true, hits: 1 };
}

// --- стенд --------------------------------------------------------------------

let gitForm;

/** Один вызов git на стенде: та же дисциплина, что у демона, — абсолютная команда и служебное окружение. */
async function git(cwd, args) {
  if (gitForm === undefined) gitForm = await resolveCommand('git');
  if (!gitForm) return { ok: false, exit: null, out: '' };
  const form = withArgs(gitForm, args);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(form.file, form.args, {
        cwd,
        env: gitEnv(),
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: form.verbatim === true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve({ ok: false, exit: null, out: '' });
      return;
    }
    let text = '';
    child.stdout.on('data', (c) => { text += c.toString('utf8'); });
    child.stderr.on('data', () => {});
    child.on('error', () => resolve({ ok: false, exit: null, out: '' }));
    child.on('close', (exit) => resolve({ ok: exit === 0, exit, out: text }));
  });
}

/**
 * Проект-стенд: репозиторий с одним коммитом, правкой в рабочем дереве и двумя
 * неотслеживаемыми записями (файл и каталог целиком — `git status` считает его ОДНОЙ).
 */
async function makeStand(dir) {
  const base = [];
  for (let i = 1; i <= STAND_LINES; i += 1) base.push(`строка ${i} — стенд проверки страницы`);

  await mkdir(path.join(dir, '.claude'), { recursive: true });
  await writeFile(path.join(dir, '.claude', 'VERSION'), '1.0.0\n');
  await writeFile(path.join(dir, '.claude', 'settings.json'), '{}\n');
  await writeFile(path.join(dir, 'a.txt'), `${base.join('\n')}\n`);
  await writeFile(path.join(dir, 'b.txt'), 'первая строка\nвторая строка\n');

  if (!(await git(dir, ['init'])).ok) return { ok: false, why: 'git init не прошёл' };
  if (!(await git(dir, ['add', '-A'])).ok) return { ok: false, why: 'git add не прошёл' };
  const commit = await git(dir, [
    '-c', 'user.email=stand@pult', '-c', 'user.name=pult stand', '-c', 'commit.gpgsign=false',
    'commit', '-m', 'стенд',
  ]);
  if (!commit.ok) return { ok: false, why: 'git commit не прошёл' };

  // Рабочая сторона расходится с коммитом — иначе во вкладке диффов сравнивать нечего.
  const changed = base.slice();
  changed[2] = 'строка 3 — правка рабочего дерева';
  changed.push('дописанная строка A', 'дописанная строка B');
  await writeFile(path.join(dir, 'a.txt'), `${changed.join('\n')}\n`);

  // Неотслеживаемое: `git diff HEAD` его не видит вовсе — ради этого и заведено.
  await writeFile(path.join(dir, 'new.txt'), 'новый файл\n');
  await mkdir(path.join(dir, 'newdir'), { recursive: true });
  await writeFile(path.join(dir, 'newdir', 'inside.txt'), 'файл в новом каталоге\n');

  const st = await git(dir, ['status', '--porcelain']);
  const untracked = st.out.split('\n').filter((l) => l.startsWith('??')).length;
  return { ok: true, untracked };
}

// --- разговор с демоном стенда ------------------------------------------------

function ask(port, method, pathname) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method, headers: { Host: `127.0.0.1:${port}` } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { json = null; }
          resolve({ status: res.statusCode, json, text });
        });
      },
    );
    req.on('error', () => resolve({ status: 0, json: null, text: '' }));
    req.end();
  });
}

async function waitHealth(port, deadline) {
  while (Date.now() < deadline) {
    const r = await ask(port, 'GET', '/health');
    if (r.status === 200) return true;
    await sleep(200);
  }
  return false;
}

// --- браузер: протокол отладчика ---------------------------------------------

/** Точка входа протокола. Браузер печатает её в `/json/version` не сразу — ждём. */
async function browserSocket(port, deadline) {
  while (Date.now() < deadline) {
    const r = await ask(port, 'GET', '/json/version');
    if (r.status === 200 && r.json && r.json.webSocketDebuggerUrl) return r.json.webSocketDebuggerUrl;
    await sleep(200);
  }
  return null;
}

/**
 * Минимальный клиент протокола: пары «запрос — ответ» по номеру. События не разбираются
 * вовсе — все ожидания здесь построены на опросе состояния страницы, а не на подписках:
 * опрос переживает пропущенное событие, подписка — нет.
 */
function connectCdp(url) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 128 * 1024 * 1024 });
    } catch (e) {
      reject(e);
      return;
    }
    const pending = new Map();
    let seq = 0;

    ws.on('message', (raw) => {
      let msg = null;
      try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (!msg || typeof msg.id !== 'number') return;
      const waiting = pending.get(msg.id);
      if (!waiting) return;
      pending.delete(msg.id);
      clearTimeout(waiting.timer);
      waiting.resolve(msg);
    });
    ws.on('error', (e) => {
      for (const [, w] of pending) { clearTimeout(w.timer); w.reject(e); }
      pending.clear();
      reject(e);
    });
    ws.on('open', () => resolve({
      send(method, params, sessionId) {
        return new Promise((res, rej) => {
          const id = (seq += 1);
          const timer = setTimeout(() => {
            pending.delete(id);
            rej(new Error(`нет ответа на ${method}`));
          }, CDP_CALL_MS);
          pending.set(id, { resolve: res, reject: rej, timer });
          const frame = { id, method, params: params || {} };
          if (sessionId) frame.sessionId = sessionId;
          try {
            ws.send(JSON.stringify(frame));
          } catch (e) {
            clearTimeout(timer);
            pending.delete(id);
            rej(e);
          }
        });
      },
      close() { try { ws.close(); } catch { /* уже закрыт */ } },
    }));
  });
}

/**
 * Страница как объект: выполнить выражение, дождаться условия, изменить размер окна.
 *
 * Все выражения оборачиваются в асинхронную функцию и возвращаются ЗНАЧЕНИЕМ, а не ссылкой:
 * ссылка на узел здесь бесполезна, а значение печатается в отчёт как есть.
 */
function makePage(cdp, sessionId) {
  const ev = async (body) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {\n${body}\n})()`,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);
    if (r.error) throw new Error(`протокол отказал: ${r.error.message || 'без причины'}`);
    const res = r.result || {};
    if (res.exceptionDetails) {
      const ex = res.exceptionDetails.exception || {};
      throw new Error(`страница отказала: ${ex.description || ex.value || 'без причины'}`);
    }
    return res.result ? res.result.value : undefined;
  };

  const waitFor = async (body, ms = WAIT_MS) => {
    const deadline = Date.now() + ms;
    for (;;) {
      let value = false;
      try { value = await ev(body); } catch { value = false; }
      if (value) return true;
      if (Date.now() >= deadline) return false;
      await sleep(120);
    }
  };

  const resize = async (size) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false,
    }, sessionId);
    // Размер меняется не мгновенно: обработчик `resize` на странице отрабатывает следующим
    // кадром, и замер без паузы поймал бы прежнюю раскладку.
    await sleep(400);
  };

  return { ev, waitFor, resize };
}

// --- проверки -----------------------------------------------------------------

/** Замер полотна: панель, полотно, редактор ВНУТРИ полотна и видимые строки. */
const MEASURE = `
  const pane = document.getElementById('pane-diff');
  const host = document.getElementById('diff-host');
  const view = host ? host.querySelector('.monaco-diff-editor') : null;
  return {
    pane: pane ? pane.clientHeight : null,
    host: host ? host.clientHeight : null,
    width: host ? host.clientWidth : null,
    view: view ? Math.round(view.getBoundingClientRect().height) : null,
    lines: host ? host.querySelectorAll('.view-line').length : 0,
  };
`;

function judgeCanvas(m) {
  const bad = [];
  if (!m || m.pane === null || m.host === null) { bad.push('панели или полотна нет в разметке'); return bad; }
  if (m.view === null) { bad.push('редактора сравнения внутри полотна нет'); return bad; }
  if (m.host < m.pane * 0.5 || m.host < 200) bad.push(`полотно ${m.host} px при панели ${m.pane} px`);
  if (m.view < m.host * 0.9 || m.view < 120) bad.push(`редактор сравнения ${m.view} px при полотне ${m.host} px`);
  if (m.lines < 10) bad.push(`видимых строк ${m.lines}`);
  return bad;
}

const shape = (m) => `панель ${m.pane} · полотно ${m.host}×${m.width} · редактор сравнения ${m.view} · строк ${m.lines}`;

/**
 * ПРОВЕРКА 1: полотно сравнения. Второй замер — после полного пути болезни; без него
 * проверка была бы зелёной и на больном коде.
 */
async function checkCanvas(page) {
  const notes = [];

  if (!await page.waitFor("return document.querySelectorAll('#diff-files .diff-file').length > 0;")) {
    return { fatal: 'список изменённых файлов не появился — мерить нечего' };
  }
  await page.ev("document.querySelector('#diff-files .diff-file').click(); return true;");
  if (!await page.waitFor("return !!document.querySelector('#diff-host .monaco-diff-editor');")) {
    return { fatal: 'редактор сравнения не поднялся — мерить нечего' };
  }
  await sleep(600);

  const first = await page.ev(MEASURE);
  out(`  замер после открытия файла: ${shape(first)}`);
  for (const b of judgeCanvas(first)) notes.push(`полотно после открытия: ${b}`);

  // ПУТЬ БОЛЕЗНИ ЦЕЛИКОМ: дифф → другая вкладка → изменение размера окна → назад.
  await page.ev("document.getElementById('tab-terminal').click(); return true;");
  await sleep(200);
  await page.resize(WINDOW_RESIZED);
  await page.ev("document.getElementById('tab-diff').click(); return true;");
  await sleep(800);

  const second = await page.ev(MEASURE);
  out(`  замер после «вкладка → размер окна → назад»: ${shape(second)}`);
  for (const b of judgeCanvas(second)) notes.push(`полотно после пути болезни: ${b}`);

  return { notes };
}

/** ПРОВЕРКА 3: строка про неотслеживаемые под списком диффа. */
async function checkUntracked(page, expected) {
  const notes = [];
  const text = await page.ev("return document.getElementById('diff-files').textContent;");
  const hit = /неотслеж/i.test(text);
  const num = text.match(/(\d+)\s*неотслеж/i);
  out(`  строка под списком: ${hit ? 'есть' : 'НЕТ'}${num ? ` · число ${num[1]} (ожидание ${expected})` : ''}`);
  if (!hit) {
    notes.push('под списком диффа нет строки про неотслеживаемые — список выглядит полным, а он неполон');
    return { notes };
  }
  if (!num || Number(num[1]) !== expected) {
    notes.push(`число неотслеживаемых на странице ${num ? num[1] : '—'}, а git видит ${expected}`);
  }
  return { notes };
}

/** ПРОВЕРКА 2: кнопки редактора и отметка правки. */
async function checkButtons(page, standDir) {
  const notes = [];

  await page.ev("document.getElementById('tab-editor').click(); return true;");
  const opened = await page.ev(`
    const nodes = Array.from(document.querySelectorAll('#tree-root .node'));
    const want = nodes.find((n) => {
      const label = n.querySelector('.label');
      return label && label.textContent === 'b.txt';
    });
    if (!want) return false;
    want.click();
    return true;
  `);
  if (!opened) return { fatal: 'файла b.txt нет в дереве — открывать нечего' };
  if (!await page.waitFor("return document.getElementById('editor-path').textContent === 'b.txt' && !!document.querySelector('#editor-host .monaco-editor');")) {
    return { fatal: 'редактор не открыл файл — мерить нечего' };
  }
  await sleep(400);

  const state = `
    const save = document.getElementById('btn-save');
    const reload = document.getElementById('btn-reload');
    const dirty = document.getElementById('editor-dirty');
    return {
      save: save ? save.disabled : null,
      reload: reload ? reload.disabled : null,
      dirty: dirty ? dirty.hidden : null,
      dirtyExists: !!dirty,
      notice: document.getElementById('editor-notice').textContent,
    };
  `;

  const afterOpen = await page.ev(state);
  out(`  после открытия: «Сохранить» ${afterOpen.save ? 'неактивна' : 'АКТИВНА'}`
    + ` · отметка ${afterOpen.dirtyExists ? (afterOpen.dirty ? 'скрыта' : 'ВИДНА') : 'УЗЛА НЕТ'}`
    + ` · «Перечитать» ${afterOpen.reload ? 'НЕАКТИВНА' : 'активна'}`);
  if (afterOpen.save !== true) notes.push('«Сохранить» активна сразу после открытия файла без единой правки');
  if (!afterOpen.dirtyExists) notes.push('узла отметки правок #editor-dirty на странице нет');
  else if (afterOpen.dirty !== true) notes.push('отметка правок видна на только что открытом файле');
  if (afterOpen.reload !== false) notes.push('«Перечитать» неактивна при открытом файле');

  // ПРАВКА ИДЁТ В МОДЕЛЬ РЕДАКТОРА — тем же событием, что и нажатие клавиши: подписка
  // страницы висит на `onDidChangeModelContent`, и различать эти два пути ей нечем.
  const typed = await page.ev(`
    const list = (window.monaco && monaco.editor.getEditors) ? monaco.editor.getEditors() : [];
    const host = document.getElementById('editor-host');
    const ed = list.find((e) => e.getDomNode() && host.contains(e.getDomNode()));
    if (!ed) return false;
    ed.getModel().applyEdits([{ range: new monaco.Range(1, 1, 1, 1), text: 'X' }]);
    return true;
  `);
  if (!typed) return { fatal: 'редактор не найден среди поднятых — правку внести нечем', notes };
  await sleep(300);

  const afterEdit = await page.ev(state);
  out(`  после правки: «Сохранить» ${afterEdit.save ? 'НЕАКТИВНА' : 'активна'}`
    + ` · отметка ${afterEdit.dirty ? 'СКРЫТА' : 'видна'}`);
  if (afterEdit.save !== false) notes.push('«Сохранить» осталась неактивной после правки');
  if (afterEdit.dirty !== false) notes.push('отметка правок не появилась после правки');

  await page.ev("document.getElementById('btn-save').click(); return true;");
  if (!await page.waitFor("return document.getElementById('editor-notice').textContent.indexOf('сохранено') >= 0;")) {
    notes.push('после нажатия «Сохранить» страница не сказала «сохранено»');
  }
  await sleep(300);

  const afterSave = await page.ev(state);
  out(`  после сохранения: «Сохранить» ${afterSave.save ? 'неактивна' : 'АКТИВНА'}`
    + ` · отметка ${afterSave.dirty ? 'скрыта' : 'ВИДНА'} · ответ «${afterSave.notice}»`);
  if (afterSave.save !== true) notes.push('«Сохранить» осталась активной после сохранения');
  if (afterSave.dirty !== true) notes.push('отметка правок не погасла после сохранения');

  let disk = '';
  try {
    disk = await readFile(path.join(standDir, 'b.txt'), 'utf8');
  } catch {
    disk = '';
  }
  const onDisk = disk.startsWith('X');
  out(`  на диске: ${onDisk ? 'новый текст' : 'ПРЕЖНИЙ ТЕКСТ'} (${JSON.stringify(disk.split('\n')[0] || '')})`);
  if (!onDisk) notes.push('на диске остался прежний текст — сохранение не доехало');

  return { notes };
}

/**
 * ПРОВЕРКА 5: терминал не меряется при нулевом размере узла.
 *
 * Узлу нулевого размера браузер отдаёт нули, подгонка на нулях считает одну колонку и одну
 * строку и ОТСЫЛАЕТ ЭТОТ РАЗМЕР ДЕМОНУ: псевдотерминал начинает переносить строки по одному
 * знаку, и вернувшийся человек видит мусор.
 *
 * ДВА ПУТИ, И ВТОРОЙ — НЕСУЩИЙ. Первый — тот, которым дефект нашли: сессия, уход на вкладку
 * диффов и обе ручки, зовущие все три полотна разом (изменение размера окна и сворачивание
 * правой колонки). Он остаётся замером, но КРАСНОГО сам по себе не даёт, и это выяснено
 * замером, а не рассуждением: спрятанная вкладка — это `display: none`, при нём
 * `getComputedStyle` отдаёт `auto`, и `fit()` привезённой сборки `addon-fit` бросает свой
 * расчёт по `isNaN`. То есть на ЭТОМ пути сборка защищает нас сама, а проба, снимающая нашу
 * проверку, не краснеет — и зелёный тут ничего бы не доказывал.
 *
 * Второй путь доводит узел до состояния, от которого наша проверка и стоит: узел ПОКАЗАН,
 * но имеет нулевую высоту (свёрнутый контейнер, доля раскладки, промежуточный кадр). Тогда
 * `getComputedStyle` отдаёт честный `0px`, расчёт даёт одну строку, и подгонка уходит демону.
 * Состояние наводится намеренно — временным стилем на узле терминала, и снимается сразу после
 * замера. Краснеет при числе строк меньше `TERM_MIN_ROWS`. Сессия не поднялась — код 3.
 */
async function checkTermHidden(page) {
  const notes = [];
  const rows = "return document.querySelectorAll('#terminal-host .xterm-rows > div').length;";

  await page.ev("document.getElementById('tab-terminal').click(); return true;");
  await sleep(300);
  await page.ev("document.getElementById('btn-session').click(); return true;");
  const up = await page.waitFor("return document.getElementById('terminal-status').textContent.indexOf('подключено') >= 0;");
  if (!up) {
    const why = await page.ev("return document.getElementById('terminal-status').textContent;");
    return { fatal: `сессия терминала не поднялась (${why}) — мерить нечего` };
  }
  await sleep(900);

  const before = await page.ev(rows);
  await page.ev("document.getElementById('tab-diff').click(); return true;");
  await sleep(250);
  await page.resize(WINDOW_RESIZED);
  await page.ev("document.getElementById('btn-tree-collapse').click(); return true;");
  await sleep(900);
  const hiddenRows = await page.ev(rows);
  out(`  путь 1 (спрятанная вкладка): строк до ухода ${before} · после рывка ${hiddenRows}`);
  if (hiddenRows < TERM_MIN_ROWS) {
    notes.push(`терминал смерян спрятанным: строк осталось ${hiddenRows} при ${before} до ухода`);
  }

  // Колонка обратно, вкладка терминала снова показана — второй путь меряет ПОКАЗАННЫЙ узел.
  await page.ev("document.getElementById('btn-tree-collapse').click(); return true;");
  await page.ev("document.getElementById('tab-terminal').click(); return true;");
  await sleep(500);

  // ПУТЬ 2, НЕСУЩИЙ: узел показан, но высоты у него нет. Стиль наводится временно и снимается
  // сразу после замера — файлы стенда при этом не правятся ни одним байтом.
  const zero = await page.ev(`
    const host = document.getElementById('terminal-host');
    const keep = host.getAttribute('style') || '';
    // 'flex: none' обязателен: узел — растягивающийся элемент колонки, и одна только
    // 'height: 0' ему ничего не сделает — 'flex-grow' вернёт высоту обратно.
    host.style.cssText = keep + ';flex:none;height:0px;min-height:0;';
    // Меряем ТО ЖЕ, что читает подгонка: высоту по вычисленному стилю. Свойство clientHeight
    // здесь не годится — оно считает вместе с отступами узла и на нулевой высоте даёт 12.
    const reached = parseInt(window.getComputedStyle(host).getPropertyValue('height'), 10);
    window.dispatchEvent(new Event('resize'));
    await new Promise((r) => setTimeout(r, 700));
    const n = document.querySelectorAll('#terminal-host .xterm-rows > div').length;
    host.setAttribute('style', keep);
    window.dispatchEvent(new Event('resize'));
    return { reached, rows: n };
  `);
  // Состояние считается наведённым, если высоты не хватает даже на ОДНУ строку текста.
  // Ровный ноль здесь недостижим и не нужен: узел считает размер вместе с отступами
  // (border-box), поэтому на «нулевой» высоте вычисленный стиль отдаёт 12 px — это меньше
  // высоты знакоместа (около 17 px при кегле 13), и расчёт подгонки всё равно даёт одну строку.
  if (!(zero.reached >= 0 && zero.reached < TERM_ZERO_PX)) {
    return { fatal: `узел терминала не удалось довести до нулевой высоты (${zero.reached} px) — путь 2 ничего не доказывает`, notes };
  }
  out(`  путь 2 (узел показан, высота ноль): строк ${zero.rows} (порог ${TERM_MIN_ROWS})`);
  if (zero.rows < TERM_MIN_ROWS) {
    notes.push(`терминал смерян при нулевой высоте узла: строк осталось ${zero.rows} при ${before} до этого`);
  }

  // Прибираем за собой: сессия отпущена — она бы держала процесс пять минут.
  await sleep(400);
  await page.ev("document.getElementById('btn-session').click(); return true;");
  await sleep(400);
  return { notes };
}

/**
 * ПРОВЕРКА 6: переключатель режима не врёт.
 *
 * Раньше редактор сравнения САМ уходил на ленту, когда полотно становилось уже порога,
 * а кнопка продолжала обещать две колонки. Меряется ширина ЛЕВОЙ СТОРОНЫ сравнения в обоих
 * режимах при полотне ЗАВЕДОМО УЖЕ ПОРОГА — то есть ровно там, где прежний код врал.
 * Пороги и причина, по которой сравнение с нулём запрещено, — у `MODE_DEAD_PX`.
 */
async function checkDiffMode(page) {
  const notes = [];
  const shot = `
    const host = document.getElementById('diff-host');
    const left = host ? host.querySelector('.editor.original') : null;
    const note = document.getElementById('diff-mode-note');
    return {
      width: host ? host.clientWidth : null,
      left: left ? left.clientWidth : null,
      button: document.getElementById('btn-diff-mode').textContent,
      note: note ? note.textContent.trim() : null,
      noteExists: !!note,
    };
  `;

  await page.resize(WINDOW_NARROW);
  await page.ev("document.getElementById('tab-diff').click(); return true;");
  await sleep(400);
  if (!await page.waitFor("return !!document.querySelector('#diff-host .editor.original');")) {
    return { fatal: 'левой стороны сравнения нет в разметке — мерить нечего' };
  }
  await sleep(500);

  const wide = await page.ev(shot);
  if (wide.width === null || wide.width >= NARROW_PX) {
    return { fatal: `полотно ${wide.width} px не уже порога ${NARROW_PX} — проверка ничего не докажет` };
  }
  const liveShare = wide.left === null ? null : Math.round((wide.left / wide.width) * 100);
  out(`  две колонки: полотно ${wide.width} px · левая сторона ${wide.left} px (${liveShare}% при пороге ${Math.round(MODE_LIVE_RATIO * 100)}%) · кнопка «${wide.button}»`);
  if (wide.left === null || wide.left < wide.width * MODE_LIVE_RATIO) {
    notes.push(`кнопка обещает две колонки, а левая сторона ${wide.left} px при полотне ${wide.width} px — редактор ушёл на ленту сам`);
  }

  // Подпись «узко» — часть того же обещания: она объясняет тесноту, но режим не меняет.
  if (!wide.noteExists) notes.push('узла подписи режима #diff-mode-note на странице нет');
  else if (wide.note !== 'узко') notes.push(`полотно ${wide.width} px уже порога ${NARROW_PX}, а подписи «узко» нет (в узле «${wide.note}»)`);

  await page.ev("document.getElementById('btn-diff-mode').click(); return true;");
  await sleep(700);
  const inline = await page.ev(shot);
  const deadShare = inline.left === null ? null : Math.round((inline.left / inline.width) * 100);
  const collapsed = inline.left !== null
    && (inline.left < MODE_DEAD_PX || inline.left <= inline.width * MODE_DEAD_RATIO);
  out(`  лента: левая сторона ${inline.left} px (${deadShare}%) · кнопка «${inline.button}»`
    + ` · схлопнулась — меньше ${MODE_DEAD_PX} px либо ${Math.round(MODE_DEAD_RATIO * 100)}% полотна`);
  if (!collapsed) {
    notes.push(`кнопка обещает ленту, а левая сторона ${inline.left} px при полотне ${inline.width} px — режим не сменился`);
  }

  // Возвращаем две колонки: следующая проверка не должна получить чужой режим.
  await page.ev("document.getElementById('btn-diff-mode').click(); return true;");
  await sleep(500);
  await page.resize(WINDOW);
  return { notes };
}

/**
 * ПРОВЕРКА 4: полотно сравнения говорит причину, а не молчит.
 *
 * Загрузчик редактора глушится БЛОКИРОВКОЙ ЕГО ЗАПРОСА через протокол отладчика — файлы стенда
 * не правятся ни одним байтом. Дальше страница перезагружается, и клик по файлу во вкладке
 * диффов обязан оставить непустую строку итога С ПРИЧИНОЙ.
 *
 * Краснеет, если строка итога пуста или НЕ ИЗМЕНИЛАСЬ: молчащее полотно со стороны неотличимо
 * от «пульт завис». Блокировка недоступна — код 3, а не тихий зелёный.
 *
 * Проверка идёт ПОСЛЕДНЕЙ намеренно: после неё на странице нет редактора вовсе.
 */
async function checkDiffNotice(page, cdp, sessionId, port) {
  const notes = [];
  const summary = "return document.getElementById('diff-summary').textContent;";

  for (const [method, params] of [
    ['Page.enable', {}],
    ['Network.enable', {}],
    ['Network.setBlockedURLs', { urls: ['*vendor/monaco/vs/loader.js*'] }],
  ]) {
    const r = await cdp.send(method, params, sessionId);
    if (r.error) return { fatal: `протокол отладчика не даёт блокировать запросы (${method}): ${r.error.message || 'без причины'}` };
  }

  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` }, sessionId);
  if (!await page.waitFor("return document.querySelectorAll('#projects-list .project').length > 0;", 30000)) {
    return { fatal: 'страница не поднялась после перезагрузки — мерить нечего' };
  }
  if (await page.ev('return typeof window.require;') !== 'undefined') {
    return { fatal: 'загрузчик редактора всё равно подключился — блокировка не сработала, доказывать нечего' };
  }

  // ВЫБИРАЕМ СТЕНД ПО ИМЕНИ, а не первый в списке: проектов в реестре прогона два,
    // и порядок строк — не наше дело.
    await page.ev(`
      const rows = Array.from(document.querySelectorAll('#projects-list .project'));
      const want = rows.find((r) => r.textContent.indexOf('стенд страницы') >= 0);
      if (!want) return false;
      want.click();
      return true;
    `);
  // ЖДЁМ КОНЦА ВЫБОРА ПРОЕКТА, а не просто клика. Выбор заканчивается сбросом вкладки диффов,
  // и вкладка, открытая ДО его конца, получает список файлов уже без идентификатора проекта:
  // клик по файлу тогда уходит на `/projects//diff` и даёт отказ демона — то есть проверка
  // мерила бы совсем другую ветвь. Признак конца тот же, что в основном прогоне, — дерево.
  if (!await page.waitFor("return document.querySelectorAll('#tree-root .node').length > 0;")) {
    return { fatal: 'дерево проекта не наполнилось — выбор проекта не закончился' };
  }
  await page.ev("document.getElementById('tab-diff').click(); return true;");
  if (!await page.waitFor("return document.querySelectorAll('#diff-files .diff-file').length > 0;")) {
    return { fatal: 'список изменённых файлов не появился — кликать нечего' };
  }
  await sleep(400);

  const before = await page.ev(summary);
  await page.ev("document.querySelector('#diff-files .diff-file').click(); return true;");
  await page.waitFor(`return document.getElementById('diff-summary').textContent !== ${JSON.stringify(before)};`, 8000);
  const after = await page.ev(summary);
  out(`  строка итога до клика: «${before}»`);
  out(`  строка итога после клика: «${after}»`);
  if (!after || !after.trim()) notes.push('строка итога пуста — полотно молчит о том, что не загрузилось');
  else if (after === before) notes.push('строка итога не изменилась после клика — полотно молчит, а со стороны это «пульт завис»');

  return { notes };
}

/**
 * ПРОВЕРКА 7: дерево не теряется при переключении проектов (фаза 3, находка человека).
 *
 * Человек сообщил: открыл проект — дерево работает; ушёл в другой и вернулся — «каталог
 * не прочитан». Корень оказался в другом (демон был остановлен), но сам путь «туда-обратно
 * и потрогать дерево» до этого не проверялся ничем. Проверка ходит именно им.
 *
 * Меряется ДВЕ вещи: чьё дерево показано (у второго стенда свой файл-метка) и читается ли
 * содержимое каталога ПОСЛЕ возврата. Краснеет, если после переключения дерево показывает
 * чужой проект, если корень пуст или если раскрытый каталог сообщает об отказе.
 */
async function checkSwitchTree(page) {
  const notes = [];
  const rootText = "return document.getElementById('tree-root').textContent;";
  const pick = (name) => `
    const rows = Array.from(document.querySelectorAll('#projects-list .project'));
    const want = rows.find((r) => r.textContent.indexOf(${JSON.stringify(name)}) >= 0);
    if (!want) return false;
    want.click();
    return true;
  `;

  if (!await page.ev(pick('второй стенд'))) return { fatal: 'второго стенда нет в списке проектов' };
  // ПРЕДУСЛОВИЕМ здесь считается только «дерево вообще наполнилось». Чьё оно — это уже ЗАМЕР,
  // и расхождение обязано краснеть, а не выдавать «ничего не доказано»: иначе больной код
  // прячется за «не смог проверить».
  if (!await page.waitFor("return document.querySelectorAll('#tree-root .node').length > 0;")) {
    return { fatal: 'дерево второго стенда не наполнилось вовсе — переключаться не с чего' };
  }
  await sleep(400);
  const second = await page.ev(rootText);
  const secondOwn = second.indexOf(SECOND_MARK) >= 0;
  out(`  ушли во второй стенд: его метка в дереве ${secondOwn ? 'есть' : 'НЕ ПОЯВИЛАСЬ'}`);
  if (!secondOwn) notes.push('после перехода во второй проект дерево показывает не его файлы');

  if (!await page.ev(pick('стенд страницы'))) return { fatal: 'первого стенда нет в списке проектов' };
  if (!await page.waitFor("return document.querySelectorAll('#tree-root .node').length > 0;")) {
    return { fatal: 'дерево первого стенда не наполнилось после возврата' };
  }
  await sleep(400);

  const back = await page.ev(rootText);
  const foreign = back.indexOf(SECOND_MARK) >= 0;
  const own = back.indexOf('a.txt') >= 0;
  out(`  вернулись: свои файлы ${own ? 'видно' : 'НЕ ВИДНО'} · чужая метка ${foreign ? 'ОСТАЛАСЬ' : 'ушла'}`);
  if (foreign) notes.push('после возврата дерево показывает файлы ПРЕДЫДУЩЕГО проекта');
  if (!own) notes.push('после возврата в дереве нет файлов выбранного проекта');

  // Обращение к дереву ПОСЛЕ возврата — то самое действие, на котором человек увидел отказ.
  const opened = await page.ev(`
    const nodes = Array.from(document.querySelectorAll('#tree-root .node'));
    const dir = nodes.find((n) => {
      const label = n.querySelector('.label');
      return label && label.textContent === '.claude';
    });
    if (!dir) return false;
    dir.click();
    return true;
  `);
  if (!opened) return { fatal: 'каталога .claude нет в дереве — раскрывать нечего', notes };
  await sleep(1200);

  const after = await page.ev(rootText);
  const refused = /не прочитан/.test(after);
  out(`  раскрыли каталог после возврата: ${refused ? 'ОТКАЗ' : 'прочитан'}`);
  if (refused) {
    const line = (after.match(/каталог не прочитан:[^\n]{0,40}/) || ['—'])[0];
    notes.push(`после возврата в проект дерево отказало: «${line}»`);
  }
  return { notes };
}

/**
 * ПРОВЕРКА 8: страница ГОВОРИТ, что связи с демоном нет (фаза 3, находка человека).
 *
 * Демон стенда гасится намеренно, и это делает проверку ПОСЛЕДНЕЙ: после неё мерить нечего.
 * Раньше страница в этом состоянии продолжала показывать зелёную точку и «демон 0.3.0»,
 * а каждый виджет говорил своё — человек читал это как поломку дерева.
 *
 * Краснеет, если после обрыва полоса состояния осталась зелёной или её текст не изменился.
 */
async function checkDaemonDown(page, daemon) {
  const notes = [];
  const before = await page.ev("return document.getElementById('daemon-text').textContent;");
  try { daemon.kill(); } catch { /* уже мёртв */ }
  await sleep(1500);

  // ДЕЙСТВИЕ ВЫБРАНО НЕ ЛЮБОЕ. Кнопка обновления зовёт `/health` и красит полосу САМА —
  // на ней проверка была бы зелёной и на прежнем коде (выяснено пробой). Человек в этот
  // момент делает другое: переключает проект. Этот путь идёт мимо `/health`, и красить
  // полосу обязана общая дверь запросов.
  await page.ev(`
    const rows = Array.from(document.querySelectorAll('#projects-list .project'));
    const want = rows.find((r) => r.textContent.indexOf('второй стенд') >= 0);
    if (want) want.click();
    return true;
  `);
  await sleep(3000);

  const text = await page.ev("return document.getElementById('daemon-text').textContent;");
  const cls = await page.ev("return document.getElementById('daemon-dot').className;");
  out(`  до обрыва: «${before}»`);
  out(`  после обрыва: «${text}» · точка «${cls}»`);
  if (!/is-alarm/.test(cls)) notes.push('демон не отвечает, а точка в полосе состояния не тревожная');
  if (text === before) notes.push('демон не отвечает, а полоса состояния говорит то же, что и раньше');
  return { notes };
}

// --- прогон -------------------------------------------------------------------

function parseArgs(argv) {
  const args = { dir: null, negative: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { args.help = true; continue; }
    if (a === '--negative') { args.negative = argv[i + 1] || ''; i += 1; continue; }
    if (a.startsWith('--negative=')) { args.negative = a.slice('--negative='.length); continue; }
    if (a.startsWith('-')) return { ...args, bad: a };
    args.dir = a;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    out('Постоянные машинные проверки страницы пульта:');
    out(`  node pult/tools/page-check.mjs [каталог для стендов] [--negative ${Object.keys(PROBES).join('|')}]`);
    out('Отрицательные пробы правят ТОЛЬКО копию стенда и возвращают в неё прежнюю (больную)');
    out('форму кода:');
    for (const [name, probe] of Object.entries(PROBES)) out(`  ${name.padEnd(11)} ${probe.what}`);
    return 0;
  }
  if (args.bad) { err(`неизвестный ключ: ${args.bad}`); return 3; }
  if (args.negative !== null && !PROBES[args.negative]) {
    err(`проба бывает только: ${Object.keys(PROBES).join(', ')}`);
    return 3;
  }

  const browser = await findBrowser();
  if (!browser) {
    err('headless-браузера в окружении нет: не найден ни Chrome, ни Edge, ни Chromium');
    err('путь можно указать переменной CCKIT_CHROME; проверка страницы без браузера невозможна');
    return 3;
  }
  if (!await resolveCommand('git')) {
    err('git не разрешился по PATH — стенд-репозиторий не собрать, вкладку диффов мерить нечем');
    return 3;
  }

  const base = args.dir ? path.resolve(args.dir) : os.tmpdir();
  // Стенд внутри этого репозитория запрещён: демон стенда писал бы в рабочее дерево,
  // а копия пульта попадала бы под git и под приёмку.
  if (base === REPO || base.startsWith(`${REPO}${path.sep}`)) {
    err('каталог стендов обязан быть ВНЕ этого репозитория');
    return 3;
  }

  // КАНОНИЗАЦИЯ ОБЯЗАТЕЛЬНА, И ЭТО НЕ ПРИДИРКА. На Windows временный каталог приходит
  // КОРОТКИМ именем (`C:\Users\MANUKY~1\...`), а `findStatic()` в `pult/lib/static.mjs`
  // сверяет `realpath` файла с каталогом страницы — тот возвращает ДЛИННОЕ имя, вложенность
  // не сходится, и демон отвечает 404 на саму страницу. Прогон при этом выглядит как
  // «страница не показала проектов», то есть уводит разбор совсем в другую сторону.
  const parent = await realpath(await mkdtemp(path.join(base, 'pult-page-')));
  const cfg = await realpath(await mkdtemp(path.join(base, 'pult-cfg-')));
  // Реестр прогона СВОЙ: боевой — список проектов человека, и прогон, оборвавшийся посередине,
  // оставил бы в нём запись про временный каталог.
  process.env.APPDATA = cfg;
  process.env.XDG_CONFIG_HOME = cfg;

  const standPult = path.join(parent, 'pult');
  const standProject = path.join(parent, 'project');
  const standSecond = path.join(parent, 'project2');
  const profile = path.join(parent, 'chrome');

  let daemon = null;
  let chrome = null;
  let cdp = null;
  let code = 0;
  const notes = [];
  const daemonLog = [];

  try {
    out(`браузер: ${browser}`);
    out(`стенды:  ${parent}`);

    const tally = await mirror(PULT, standPult);
    try {
      await symlink(path.join(PULT, 'node_modules'), path.join(standPult, 'node_modules'), 'junction');
    } catch (e) {
      err(`node_modules не подключились к стенду (${(e && e.code) || 'ошибка'}) — демон не поднимется`);
      return 3;
    }
    out(`копия пульта: скопировано ${tally.copied}, жёстких ссылок ${tally.linked}`);

    const port = await freePort();
    const patched = await patchPort(standPult, port);
    if (!patched.ok) {
      err(`строка порта в копии не нашлась (вхождений ${patched.hits}) — прогон ничего не доказывает`);
      return 3;
    }
    out(`порт стенда: ${port} (боевой демон не трогается)`);

    if (args.negative) {
      const probe = PROBES[args.negative];
      const applied = await applyProbe(standPult, args.negative);
      if (!applied.ok) {
        err(`проба «${args.negative}» не наложилась (вхождений ${applied.hits}) — код изменился, проба ничего не докажет`);
        return 3;
      }
      out('');
      out(`ОТРИЦАТЕЛЬНАЯ ПРОБА «${args.negative}»: ${probe.what}`);
      out(`правится только копия: ${probe.file} в стенде; файлы репозитория не трогаются`);
      out('ожидаемый исход прогона — КРАСНЫЙ (код 1). Зелёный здесь означает, что проверка ничего не стережёт.');
      out('');
    }

    // 9. У КАЖДОЙ ПРИЧИНЫ ОЖИДАНИЯ — СВОЙ АДРЕС НАЗНАЧЕНИЯ.
    //
    // Проверка ЧИСТАЯ и идёт до браузера: таблица адресов (`pult/web/addresses.mjs`)
    // разметки не касается, поэтому её читает обычный Node. Утверждение ломается ТИХО —
    // добавили восьмую причину в набор, забыли адрес, и уведомление про неё стало вести
    // в общее окно, то есть ровно в то молчание, которое закрывала фаза 3.
    //
    // ЧЕГО ЭТА ПРОВЕРКА НЕ ДЕЛАЕТ: она не открывает экраны. Что адрес действительно
    // приводит человека куда обещано — предмет ручного пункта протокола приёмки.
    out('9. у каждой причины ожидания есть свой адрес:');
    {
      const mod = await import(pathToFileURL(path.join(standPult, 'web', 'addresses.mjs')).href);
      const missing = PENDING_REASONS.filter((r) => !mod.ADDRESSES[r]);
      const extra = Object.keys(mod.ADDRESSES).filter((r) => !PENDING_REASONS.includes(r));
      const fallback = mod.addressFor('такого-слова-нет') === mod.DEFAULT_ADDRESS;
      const kinds = new Set(PENDING_REASONS.map((r) => mod.addressFor(r)));

      // ВТОРАЯ ПОЛОВИНА УТВЕРЖДЕНИЯ: у каждого слова таблицы есть СВОЯ ВЕТВЬ
      // в маршрутизаторе. Первая половина («у каждой причины есть адрес») не ловит
      // восьмой адрес, для которого ветвь забыли завести: такой адрес молча уходил бы
      // в умолчание, то есть в общее окно.
      //
      // ГРАНИЦА НАЗЫВАЕТСЯ: сверяется НАЛИЧИЕ ветви по тексту, а не то, что она делает.
      // Подмену `plan` на `state` эта проверка не ловит и не должна — это остаётся
      // человеку и ручному пункту протокола.
      const routerSrc = await readFile(path.join(standPult, 'web', 'app.mjs'), 'utf8');
      const branchless = [...kinds].filter((w) => !routerSrc.includes(`address === '${w}'`));
      const branches = [...routerSrc.matchAll(/address === '([a-z]+)'/g)].map((m) => m[1]);
      const orphan = branches.filter((w) => !Object.values(mod.ADDRESSES).includes(w));
      out(`  ветвей маршрутизатора ${new Set(branches).size} · без ветви: ${branchless.length ? branchless.join(", ") : "нет"}`
        + ` · ветвей без адреса: ${orphan.length ? orphan.join(", ") : "нет"}`);
      if (branchless.length) { notes.push(`у адресов нет ветви в маршрутизаторе: ${branchless.join(", ")}`); code = 1; }
      if (orphan.length) { notes.push(`в маршрутизаторе есть ветви, которых нет в таблице адресов: ${orphan.join(", ")}`); code = 1; }
      out(`  причин ${PENDING_REASONS.length}, адресов ${Object.keys(mod.ADDRESSES).length},`
        + ` разных мест ${kinds.size} · без адреса: ${missing.length ? missing.join(", ") : "нет"}`
        + ` · лишних: ${extra.length ? extra.join(", ") : "нет"}`
        + ` · умолчание: ${fallback ? "есть" : "НЕТ"}`);
      if (missing.length) { notes.push(`без адреса назначения остались причины: ${missing.join(", ")}`); code = 1; }
      if (extra.length) { notes.push(`в таблице адресов есть слова, которых нет в словаре причин: ${extra.join(', ')}`); code = 1; }
      if (!fallback) { notes.push('у неопознанной причины нет адреса по умолчанию — человек попадёт в пустоту'); code = 1; }
      out(`  итог: ${missing.length || extra.length || !fallback || branchless.length || orphan.length ? 'КРАСНО' : 'зелено'}`);
    }
    out('');


    const stand = await makeStand(standProject);
    if (!stand.ok) {
      err(`${stand.why} — стенд не собрался`);
      return 3;
    }
    out(`стенд-проект: ${STAND_LINES} строк в a.txt, неотслеживаемых записей ${stand.untracked}`);
    if (stand.untracked !== STAND_UNTRACKED) {
      err(`ожидалось ${STAND_UNTRACKED} неотслеживаемых записи, git видит ${stand.untracked}`);
      return 3;
    }

    // ВТОРОЙ ПРОЕКТ НУЖЕН ОДНОЙ ПРОВЕРКЕ, И БЕЗ НЕГО ОНА НЕВОЗМОЖНА: переключение проектов
    // туда-обратно нечем сделать на одном. Он нарочно НЕ репозиторий и содержит свой,
    // ни на что не похожий файл-метку — по ней видно, чьё дерево показано.
    await mkdir(path.join(standSecond, '.claude'), { recursive: true });
    await writeFile(path.join(standSecond, '.claude', 'VERSION'), '1.0.0\n');
    await writeFile(path.join(standSecond, '.claude', 'settings.json'), '{}\n');
    await writeFile(path.join(standSecond, SECOND_MARK), 'метка второго стенда\n');
    await mkdir(path.join(standSecond, 'вложенный'), { recursive: true });
    await writeFile(path.join(standSecond, 'вложенный', 'внутри.txt'), 'файл внутри\n');

    const addedSecond = await addProject(standSecond, 'второй стенд');
    if (!addedSecond.ok) {
      err('второй стенд не завёлся в реестр прогона');
      return 3;
    }

    const added = await addProject(standProject, 'стенд страницы');
    if (!added.ok) {
      err('стенд не завёлся в реестр прогона');
      return 3;
    }

    daemon = spawn(process.execPath, [path.join(standPult, 'server.mjs')], {
      cwd: standPult,
      env: { ...process.env, APPDATA: cfg, XDG_CONFIG_HOME: cfg },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    daemon.stdout.on('data', (c) => daemonLog.push(c.toString('utf8')));
    daemon.stderr.on('data', (c) => daemonLog.push(c.toString('utf8')));
    if (!await waitHealth(port, Date.now() + DAEMON_START_MS)) {
      err('демон стенда не ответил — прогон ничего не доказывает');
      err(daemonLog.join('').split('\n').slice(0, 6).join('\n'));
      return 3;
    }

    const cdpPort = await freePort();
    chrome = spawn(browser, [
      '--headless=new',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profile}`,
      `--window-size=${WINDOW.width},${WINDOW.height}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-gpu',
      'about:blank',
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    chrome.stdout.on('data', () => {});
    chrome.stderr.on('data', () => {});

    const wsUrl = await browserSocket(cdpPort, Date.now() + BROWSER_START_MS);
    if (!wsUrl) {
      err('браузер не поднял протокол отладчика — прогон ничего не доказывает');
      return 3;
    }
    cdp = await connectCdp(wsUrl);

    const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const targetId = target.result && target.result.targetId;
    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = attached.result && attached.result.sessionId;
    if (!sessionId) {
      err('вкладка браузера не отдала сессию протокола — прогон ничего не доказывает');
      return 3;
    }

    const page = makePage(cdp, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: WINDOW.width, height: WINDOW.height, deviceScaleFactor: 1, mobile: false,
    }, sessionId);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` }, sessionId);

    if (!await page.waitFor("return document.querySelectorAll('#projects-list .project').length > 0;", 30000)) {
      // Диагностика печатается, а не проглатывается: «проектов нет» бывает и от неподнявшейся
      // страницы, и от пустого реестра, и это разные поломки.
      err('страница не показала ни одного проекта — прогон ничего не доказывает');
      try {
        const why = await page.ev(`
          return {
            href: location.href,
            ready: document.readyState,
            daemon: document.getElementById('daemon-text').textContent,
            list: document.getElementById('projects-list').textContent,
            title: document.title,
          };
        `);
        err(`страница: ${JSON.stringify(why)}`);
      } catch (e) {
        err(`страница не отвечает вовсе: ${(e && e.message) || 'без причины'}`);
      }
      const root = await ask(port, 'GET', '/');
      err(`демон на /: ${root.status} ${JSON.stringify(root.text.slice(0, 200))}`);
      const projects = await ask(port, 'GET', '/projects');
      err(`демон на /projects: ${projects.status} ${JSON.stringify(projects.json && projects.json.projects)}`);
      err(daemonLog.join('').split('\n').slice(0, 6).join('\n'));
      return 3;
    }
    // ВЫБИРАЕМ СТЕНД ПО ИМЕНИ, а не первый в списке: проектов в реестре прогона два,
    // и порядок строк — не наше дело.
    await page.ev(`
      const rows = Array.from(document.querySelectorAll('#projects-list .project'));
      const want = rows.find((r) => r.textContent.indexOf('стенд страницы') >= 0);
      if (!want) return false;
      want.click();
      return true;
    `);
    if (!await page.waitFor("return document.querySelectorAll('#tree-root .node').length > 0;")) {
      err('дерево проекта не наполнилось — прогон ничего не доказывает');
      return 3;
    }
    out(`окно: ${WINDOW.width}×${WINDOW.height}, проект выбран`);
    out('');

    // 1. ПОЛОТНО СРАВНЕНИЯ.
    out('1. полотно сравнения (мерится редактор ВНУТРИ полотна):');
    await page.ev("document.getElementById('tab-diff').click(); return true;");
    const canvas = await checkCanvas(page);
    if (canvas.fatal) {
      err(canvas.fatal);
      return 3;
    }
    for (const n of canvas.notes) { notes.push(n); code = 1; }
    out(`  итог: ${canvas.notes.length ? 'КРАСНО' : 'зелено'}`);
    out('');

    // 3. СТРОКА ПРО НЕОТСЛЕЖИВАЕМЫЕ — на той же вкладке, пока список перед глазами.
    out('3. строка про неотслеживаемые файлы:');
    const untracked = await checkUntracked(page, stand.untracked);
    for (const n of untracked.notes) { notes.push(n); code = 1; }
    out(`  итог: ${untracked.notes.length ? 'КРАСНО' : 'зелено'}`);
    out('');

    // 2. КНОПКИ РЕДАКТОРА.
    out('2. кнопки редактора и отметка правки:');
    const buttons = await checkButtons(page, standProject);
    for (const n of buttons.notes || []) { notes.push(n); code = 1; }
    if (buttons.fatal) {
      err(buttons.fatal);
      return 3;
    }
    out(`  итог: ${(buttons.notes || []).length ? 'КРАСНО' : 'зелено'}`);
    out('');

    // 5. ТЕРМИНАЛ, СМЕРЯННЫЙ СПРЯТАННЫМ. Идёт до проверки 6: та меняет размер окна и режим,
    // а этой нужна живая сессия и обе ручки в исходном положении.
    out('5. терминал не меряется при нулевом размере узла:');
    const term = await checkTermHidden(page);
    if (term.fatal) {
      err(term.fatal);
      return 3;
    }
    for (const n of term.notes) { notes.push(n); code = 1; }
    out(`  итог: ${term.notes.length ? 'КРАСНО' : 'зелено'}`);
    out('');

    // 6. ПЕРЕКЛЮЧАТЕЛЬ РЕЖИМА.
    out('6. переключатель режима не врёт:');
    const mode = await checkDiffMode(page);
    if (mode.fatal) {
      err(mode.fatal);
      return 3;
    }
    for (const n of mode.notes) { notes.push(n); code = 1; }
    out(`  итог: ${mode.notes.length ? 'КРАСНО' : 'зелено'}`);
    out('');

    // 7. ПЕРЕКЛЮЧЕНИЕ ПРОЕКТОВ И ДЕРЕВО — до проверки 4: та перезагружает страницу.
    out('7. дерево не теряется при переключении проектов:');
    const switched = await checkSwitchTree(page);
    if (switched.fatal) {
      err(switched.fatal);
      return 3;
    }
    for (const n of switched.notes) { notes.push(n); code = 1; }
    out(`  итог: ${switched.notes.length ? 'КРАСНО' : 'зелено'}`);
    out('');

    // 4. ПОЛОТНО ГОВОРИТ ПРИЧИНУ — предпоследней: она глушит загрузчик редактора
    // и перезагружает страницу, после чего мерить остальное уже нечем.
    out('4. полотно сравнения говорит причину (загрузчик заглушён блокировкой запроса):');
    const notice = await checkDiffNotice(page, cdp, sessionId, port);
    if (notice.fatal) {
      err(notice.fatal);
      return 3;
    }
    for (const n of notice.notes) { notes.push(n); code = 1; }
    out(`  итог: ${notice.notes.length ? 'КРАСНО' : 'зелено'}`);
    out('');

    // 8. ОБРЫВ СВЯЗИ — САМОЙ ПОСЛЕДНЕЙ: она гасит демон стенда.
    out('8. страница говорит, что связи с демоном нет:');
    const down = await checkDaemonDown(page, daemon);
    for (const n of down.notes) { notes.push(n); code = 1; }
    out(`  итог: ${down.notes.length ? 'КРАСНО' : 'зелено'}`);
    out('');
  } finally {
    // Уборка: сначала браузер (закрывается по протоколу — иначе его потомки переживут прогон
    // и удержат профиль), потом демон, потом каталоги. Занятость терпится и называется строкой.
    if (cdp) {
      try { await cdp.send('Browser.close', {}); } catch { /* уже закрыт */ }
      cdp.close();
    }
    if (chrome) { try { chrome.kill(); } catch { /* уже мёртв */ } }
    if (daemon) { try { daemon.kill(); } catch { /* уже мёртв */ } }
    await sleep(800);
    for (const dir of [parent, cfg]) {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch (e) {
        out(`стенд занят, удалить вручную: ${dir} (${(e && e.code) || 'ошибка'})`);
      }
    }
  }

  if (notes.length) {
    out('расхождения:');
    for (const n of notes) out(`  • ${n}`);
  } else {
    out('расхождений нет: полотно живо после изменения размера и говорит причину, когда');
    out('не загрузилось; «Сохранить» включается правкой; неполнота списка диффов названа строкой;');
    out('терминал не меряется в схлопнутом узле; переключатель режима не врёт');
  }

  if (args.negative) {
    out('');
    if (code === 0) {
      err(`ПРОБА «${args.negative}» НЕ ПОКРАСНЕЛА — проверка ничего не стережёт`);
      return 2;
    }
    out(`проба «${args.negative}» покраснела, как и обязана: проверка умеет провалиться`);
  }
  return code;
}

main().then((c) => process.exit(c)).catch((e) => {
  err(`прогон не состоялся: ${(e && (e.code || e.name || e.message)) || 'ошибка'}`);
  process.exit(3);
});
