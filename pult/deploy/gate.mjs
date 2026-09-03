#!/usr/bin/env node
/**
 * ЕДИНСТВЕННАЯ ДВЕРЬ ПИШУЩЕЙ РАСКЛАДКИ: через `deployTarget()` проходит КАЖДАЯ запись
 * и КАЖДОЕ удаление раскладчика набора.
 *
 * ПОЧЕМУ ДВЕРЬ СВОЯ, А НЕ `resolveTarget()` ИЗ `pult/lib/fs-safe.mjs`. Та дверь стоит у демона
 * и запрещает запись в папку набора (`write_into_kit`) — это критерий готовности фазы 1
 * и предмет доказательства `pult/tools/no-write-check.mjs`. Раскладчику надо ровно обратное:
 * он пишет ИМЕННО в папку набора. Добавить туда флаг «а этому можно» значит снять запрет
 * у всех, кто умеет позвать шлюз с флагом, и снаружи это невидимо. Договор с фазой 4 (§3.4,
 * пункт 2) запрещает такое расширение прямым текстом, а аудит назвал его главным риском фазы.
 * Поэтому дверей две, и они ведут в разные стороны:
 *
 *   демон       `resolveTarget()`  — пишет в проект, но НИКОГДА в папку набора;
 *   раскладчик  `deployTarget()`   — пишет ТОЛЬКО в три места и удаляет ТОЛЬКО из одного.
 *
 * ДВА РЕЖИМА С РАЗНЫМИ ПРАВИЛАМИ МЕСТ — это главное, что надо понять перед правкой:
 *
 *   запись   три места: внутри `<root>/.claude`, внутри КОНКРЕТНОГО каталога резервной копии
 *            этого прогона и ровно файл `<root>/.gitignore`;
 *   удаление ОДНО место: внутри `<root>/.claude`. Каталог копии и файл игнорирования
 *            исключены ЯВНОЙ строкой с причиной — копия единственный откат, и запись,
 *            приехавшая вместе с копией чужой папки, не имеет права его снести.
 *
 * КАТАЛОГ КОПИИ ПРИХОДИТ КОНКРЕТНЫМ ЗНАЧЕНИЕМ В КОНТЕКСТЕ ВЫЗОВА, а не подбирается образцом
 * `.claude.backup-*`: образец разрешил бы запись в любой каталог с подходящим именем, в том
 * числе в чужую копию, сделанную человеком год назад.
 *
 * ЗАПРЕТ НА ПАМЯТЬ ПРОЕКТА НЕ ЗАВИСИТ НИ ОТ КАКОЙ ЗАПИСИ. Пути из `MEMORY_PATHS`
 * (`pult/config.mjs`) не удаляются никогда, ЧТО БЫ НИ ЛЕЖАЛО в записи о раскладке: журнал
 * событий и папки задач не восстанавливаются ничем, а запись — недоверенный вход.
 *
 * ОБЩИЙ ПРИНЦИП, тот же, что у двери демона: НЕСОСТОЯВШАЯСЯ КАНОНИЗАЦИЯ НИКОГДА НЕ ОЗНАЧАЕТ
 * «ПРОВЕРКУ ПРОПУСКАЕМ». Не канонизировался корень или родитель — это отказ, а не молчаливое
 * разрешение.
 *
 * И ПОСЛЕДНЕЕ, ЧЕГО НЕТ В КОДЕ ЭТОГО ФАЙЛА, НО ЧТО ДЕРЖИТСЯ ИМ ЖЕ: дальше работа идёт
 * ПО РАЗРЕШЁННОМУ ПУТИ, а не по присланной строке, и запись «на месте» запрещена — пишет
 * `pult/deploy/fs.mjs` временным файлом с переименованием. Иначе жёсткая ссылка внутри папки
 * набора на файл снаружи пропускает нашу запись мимо всех проверок: `lstat` показывает обычный
 * файл, родитель честно внутри корня (тот же довод записан у `writeProjectFile()`
 * в `pult/lib/fs-safe.mjs`).
 */

import path from 'node:path';

import {
  inside, isUncPath, sanePath, isDeviceName, isPlainFileStat, statSafe, realPath,
} from '../lib/fs-safe.mjs';
import { FAULT, MAX_REL_PATH, MAX_PLACED, MEMORY_PATHS } from '../config.mjs';

/** Два режима двери. Третьего не бывает: всё, что не удаление, — запись. */
export const DEPLOY_MODE = Object.freeze({ WRITE: 'write', REMOVE: 'remove' });

/** Имя папки набора внутри проекта — одно на весь раскладчик. */
export const KIT_DIR_NAME = '.claude';

/** Имя файла игнорирования — тоже одно, и правится он единственной строкой правил мест. */
export const GITIGNORE_NAME = '.gitignore';

/** Относительный путь внутри папки набора в форме состава (со слэшами) либо `null`. */
function kitRelative(kitDir, target) {
  const rel = path.relative(kitDir, target);
  if (rel === '') return '';
  if (path.isAbsolute(rel)) return null;
  const norm = rel.split(path.sep).join('/');
  return norm.split('/').includes('..') ? null : norm;
}

/**
 * Путь из перечня памяти проекта? Сверка точная, по сегментам: `tasks/` закрывает `tasks`
 * и всё, что внутри, `artifacts/events.jsonl` — ровно этот файл.
 */
function isProjectMemory(kitRel) {
  if (kitRel === null) return false;
  for (const mem of MEMORY_PATHS) {
    if (mem.endsWith('/')) {
      const dir = mem.slice(0, -1);
      if (kitRel === dir || kitRel.startsWith(`${dir}/`)) return true;
    } else if (kitRel === mem) return true;
  }
  return false;
}

/**
 * ИМЯ ВРЕМЕННОГО СОСЕДА для цели с базовым именем `base`.
 *
 * Форму строит `putBytes()` в `pult/deploy/fs.mjs`: `.<имя цели>.<pid>.<время>.tmp`. Сверка
 * идёт разбором строки, а не регуляркой: базовое имя цели приходит с точками и другими знаками,
 * которые в регулярке пришлось бы экранировать, — а забытое экранирование здесь означает
 * разрешение лишнего.
 */
function isTempNameOf(name, base) {
  const prefix = `.${base}.`;
  if (!name.startsWith(prefix) || !name.endsWith('.tmp')) return false;
  const middle = name.slice(prefix.length, -'.tmp'.length);
  const parts = middle.split('.');
  if (parts.length !== 2) return false;
  return parts.every((part) => part.length > 0 && part.length <= 20 && /^[0-9]+$/.test(part));
}

/**
 * Разрешить путь раскладки. Возвращает `{ok:true, path, root, kit}` либо `{ok:false, code}`.
 *
 * Порядок проверок — не украшение: перестановка любой пары превращает гарантию
 * в совещательную. Он повторяет порядок `resolveTarget()` там, где предмет тот же, и
 * расходится там, где предмет другой (правило мест и запрет памяти).
 *
 * @param {string} root  корень проекта (уже проверенный `rootRejection()` вызывающим)
 * @param {string} rel   путь ОТ КОРНЯ ПРОЕКТА (`.claude/hooks/gate.mjs`, `.gitignore`)
 * @param {string} mode  `write` или `remove`
 * @param {object} ctx   `backupDir` — каталог копии ЭТОГО прогона; `kind` — `file` (умолчание)
 *                       или `dir`; `tally` — счётчик удалений `{n}` для потолка числа
 */
export async function deployTarget(root, rel, mode, ctx = {}) {
  const remove = mode === DEPLOY_MODE.REMOVE;
  const kind = ctx.kind === 'dir' ? 'dir' : 'file';
  const outside = remove ? FAULT.REMOVE_OUTSIDE_KIT : FAULT.WRITE_OUTSIDE_ROOT;

  // 1. Пригодность строк. Сетевая форма отбивается ДО любого обращения к диску: обращение
  //    по такому пути уходит в сеть к чужому хосту с попыткой аутентификации.
  if (!sanePath(root) || isUncPath(root) || !path.isAbsolute(root)) {
    return { ok: false, code: FAULT.PATH_UNREACHABLE };
  }
  const relRaw = String(rel == null ? '' : rel);
  if (!relRaw || relRaw.length > MAX_REL_PATH) return { ok: false, code: outside };
  if (!sanePath(relRaw) || isUncPath(relRaw)) return { ok: false, code: outside };
  if (path.isAbsolute(relRaw) || /^[A-Za-z]:/.test(relRaw)) return { ok: false, code: outside };
  // Две точки запрещены В ОБОИХ режимах. Плану они нужны в режиме удаления (там путь приходит
  // из недоверенной записи), а в режиме записи запрет бесплатен: законного пути с двумя
  // точками у раскладки нет ни одного, а вложенность ловила бы его на шаг позже.
  if (relRaw.split(/[\\/]/).includes('..')) return { ok: false, code: outside };

  // 2. Корень канонизируется ОДИН раз, дальше канонизированное сравнивается только
  //    с канонизированным.
  const rootReal = await realPath(root);
  if (!rootReal.ok) return { ok: false, code: FAULT.PATH_UNREACHABLE };
  const canonRoot = rootReal.path;

  const kitDir = path.join(canonRoot, KIT_DIR_NAME);
  const gitignore = path.join(canonRoot, GITIGNORE_NAME);

  // КАТАЛОГ КОПИИ СЧИТАЕТСЯ В ДВУХ ФОРМАХ — лексической и канонизированной, — и проверяются
  // ОБЕ. Причина практическая и уже пойманная на стенде: временный каталог Windows приходит
  // коротким именем (`MANUKY~1`), корень канонизируется в длинное, и сравнение одной формы
  // с другой не совпадает ни разу. В режиме записи это давало бы отказ на собственной копии,
  // а в режиме удаления — что хуже — молча снимало бы ЯВНОЕ исключение каталога копии.
  const backupDirs = [];
  if (typeof ctx.backupDir === 'string' && ctx.backupDir) {
    const lex = path.resolve(ctx.backupDir);
    backupDirs.push(lex);
    const real = await realPath(lex);
    if (real.ok && real.path !== lex) backupDirs.push(real.path);
    // Каталог копии ещё не создан, а канонизировать нечего — тогда он переносится на
    // КАНОНИЗИРОВАННЫЙ корень по своему относительному пути. Без этого короткое имя Windows
    // в корне давало отказ на собственной резервной копии ещё до её создания.
    const relToRoot = path.relative(path.resolve(root), lex);
    if (relToRoot && !path.isAbsolute(relToRoot) && !relToRoot.split(path.sep).includes('..')) {
      backupDirs.push(path.join(canonRoot, relToRoot));
    }
  }
  const inBackup = (p) => backupDirs.some((b) => inside(b, p));

  /**
   * ПРАВИЛО МЕСТ — РАЗНОЕ У РЕЖИМОВ. Каталог копии и файл игнорирования в режиме удаления
   * исключены явной строкой, а не «не попали в список»: разница в том, что явную строку
   * нельзя снять, не заметив, что именно снимаешь.
   */
  const placeRefusal = (p) => {
    if (remove) {
      if (inBackup(p)) return FAULT.REMOVE_OUTSIDE_KIT;
      if (path.resolve(p) === gitignore) return FAULT.REMOVE_OUTSIDE_KIT;
      return inside(kitDir, p) ? null : FAULT.REMOVE_OUTSIDE_KIT;
    }
    if (inside(kitDir, p)) return null;
    if (inBackup(p)) return null;
    if (path.resolve(p) === gitignore) return null;
    // ВРЕМЕННЫЙ ФАЙЛ УЖЕ РАЗРЕШЁННОЙ ЦЕЛИ. Запись «на месте» запрещена (`pult/deploy/fs.mjs`),
    // значит у каждой записи есть временный сосед, и он лежит в том же каталоге, что цель.
    // Для `<root>/.gitignore` этот каталог — корень проекта, то есть по общему правилу мест
    // временный файл был бы отбит, и атомарная замена стала бы невозможной.
    //
    // ПРАВИЛО СУЖЕНО ПО 🟡 1 РЕВЬЮ 03.09.2026 — и вот чем оно было плохо. Первая редакция
    // сверяла только КАТАЛОГ («владелец проходит правило мест и каталоги совпадают»), а каталог
    // владельца `<root>/.gitignore` — это корень проекта: шлюз разрешал ЛЮБОЙ файл в корне,
    // включая `package.json`, `README.md` и `.env` (правила имени секрета в этой двери нет,
    // в отличие от `resolveTarget()`). Комментарий обещал «ровно один временный файл» — код
    // обещал весь верхний уровень.
    //
    // Теперь сверяется ИМЯ, и сверяется по той самой форме, которой его строит `putBytes()`:
    // точка, базовое имя цели, точка, число, точка, число, `.tmp`. Ни `.env`, ни `package.json`
    // под неё не подходят, а смошенничать можно ровно на один временный файл рядом с уже
    // разрешённой целью — то есть на то, что и обещано.
    if (typeof ctx.tmpFor === 'string' && ctx.tmpFor) {
      const owner = path.resolve(ctx.tmpFor);
      const ownerOk = inside(kitDir, owner) || inBackup(owner) || owner === gitignore;
      if (ownerOk && path.dirname(path.resolve(p)) === path.dirname(owner)) {
        if (isTempNameOf(path.basename(path.resolve(p)), path.basename(owner))) return null;
      }
    }
    return FAULT.WRITE_OUTSIDE_PLACES;
  };

  /** Независимый от записи запрет: память проекта не удаляется никогда. */
  const memoryRefusal = (p) => {
    if (!remove) return null;
    return isProjectMemory(kitRelative(kitDir, p)) ? FAULT.REMOVE_PROJECT_MEMORY : null;
  };

  // 3. Вложенность в корень.
  const target = path.resolve(canonRoot, relRaw);
  if (!inside(canonRoot, target)) return { ok: false, code: outside };

  // 4 и 5. Правило мест и запрет памяти — по лексическому пути.
  const place = placeRefusal(target);
  if (place) return { ok: false, code: place };
  const memory = memoryRefusal(target);
  if (memory) return { ok: false, code: memory };

  // 6. Родитель канонизируется, и ОБА правила проверяются заново по вернувшемуся пути.
  //    Симлинк каталога хуков наружу остаётся внутри корня лексически и мимо правила мест
  //    проходит; на Windows этой же проверкой снимаются короткие имена вида `CLAUD~1`.
  //    Несуществующий родитель — отказ: каталоги раскладчик создаёт сам, сверху вниз,
  //    и каждый из них проходит эту же дверь.
  let resolved = target;
  const parentReal = await realPath(path.dirname(target));
  if (!parentReal.ok) return { ok: false, code: parentReal.code };
  resolved = path.join(parentReal.path, path.basename(target));
  if (!inside(canonRoot, resolved)) return { ok: false, code: outside };
  const place2 = placeRefusal(resolved);
  if (place2) return { ok: false, code: place2 };
  const memory2 = memoryRefusal(resolved);
  if (memory2) return { ok: false, code: memory2 };

  // 7. Папка набора и файл игнорирования, оказавшиеся ССЫЛКОЙ ИЛИ ТОЧКОЙ СОЕДИНЕНИЯ, — отказ
  //    раскладки ЦЕЛИКОМ, а не пропуск одного пути: обе базы правил мест держатся на том, что
  //    это настоящий каталог и настоящий файл внутри корня. Проверка стоит после правила мест
  //    и до обращения к самой цели.
  for (const anchor of [kitDir, gitignore]) {
    const st = await statSafe(anchor);
    if (!st.ok) {
      if (st.code === FAULT.PATH_UNREACHABLE) continue;   // ещё не создан — законно
      return { ok: false, code: st.code };
    }
    if (st.stat.isSymbolicLink()) return { ok: false, code: FAULT.NOT_PLAIN_FILE };
  }

  // 8. Вид цели. Зарезервированное имя устройства отбивается и тогда, когда файла ещё нет:
  //    `lstat` по `COM1` его не покажет, а открытие на запись уйдёт в последовательный порт.
  if (isDeviceName(resolved)) {
    return { ok: false, code: remove ? FAULT.NOT_PLAIN_FILE : FAULT.TARGET_NOT_PLAIN_FILE };
  }
  const st = await statSafe(resolved);
  if (st.ok) {
    if (st.stat.isSymbolicLink()) {
      // БЕЗ РАЗЫМЕНОВАНИЯ: за ссылкой раскладчик не идёт ни на запись, ни на удаление.
      return { ok: false, code: remove ? FAULT.NOT_PLAIN_FILE : FAULT.TARGET_NOT_PLAIN_FILE };
    }
    if (kind === 'dir') {
      if (!st.stat.isDirectory()) return { ok: false, code: FAULT.NOT_PLAIN_FILE };
    } else if (!isPlainFileStat(st.stat, resolved)) {
      return { ok: false, code: remove ? FAULT.NOT_PLAIN_FILE : FAULT.TARGET_NOT_PLAIN_FILE };
    }
  } else if (st.code !== FAULT.PATH_UNREACHABLE) {
    return { ok: false, code: st.code };
  } else if (remove) {
    return { ok: false, code: FAULT.PATH_UNREACHABLE };   // удалять нечего
  }

  // 9. Режим удаления: потолок числа путей. Список приходит из записи о раскладке, то есть
  //    из недоверенного входа, и «сколько мы удалим в худшем случае» обязано иметь ответ.
  if (remove && ctx.tally && typeof ctx.tally === 'object') {
    ctx.tally.n = (Number(ctx.tally.n) || 0) + 1;
    if (ctx.tally.n > MAX_PLACED) return { ok: false, code: FAULT.BUDGET_EXHAUSTED };
  }

  return { ok: true, path: resolved, root: canonRoot, kit: kitDir, code: null };
}
