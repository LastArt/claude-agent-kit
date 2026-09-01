#!/usr/bin/env node
/**
 * Содержимое ОДНОГО каталога проекта — правая колонка страницы.
 *
 * Лениво по каталогам (решение 7 человека): дерево целиком не обходится никогда, и потолки
 * фазы 1 остаются в силе.
 *
 * ПОРЯДОК ПРОВЕРОК — ТОТ ЖЕ, ЧТО В ШЛЮЗЕ И У ЧИТАТЕЛЯ ФАЙЛА, И ТОЙ ЖЕ ФУНКЦИЕЙ
 * (`resolveTarget()` в `pult/lib/fs-safe.mjs`, режим чтения, вид `dir`): канонизированный
 * корень, вложенность, `realpath` САМОГО каталога перед перечислением, повторная сверка обеих
 * вложенностей по вернувшемуся пути. Перечисление ведётся по разрешённому пути.
 *
 * Без `realpath` каталога симлинк на каталог (клон такие переносит — это ровно подготовленный
 * чужой проект из модели угроз) проходит проверку строкой, а перечисление уходит наружу
 * проекта, то есть отдаёт имена любого каталога машины. Но опаснее самой дыры АСИММЕТРИЯ:
 * два соседних читателя с разным порядком проверок при первой же правке сходятся по слабому —
 * поэтому своего порядка здесь нет вовсе.
 *
 * ПРЯМОГО `node:fs` В ЭТОМ ФАЙЛЕ НЕТ.
 *
 * ЧТО ПОМЕЧАЕТСЯ И ПОЧЕМУ:
 *   • `.git` не показывается вовсе и НИ НА КАКОМ УРОВНЕ — это машинерия, а не работа
 *     человека; доступом к ней управляет шлюз (`insideGitDir()` в `pult/lib/fs-safe.mjs`),
 *     а здесь только список, и правило имени берётся оттуда же, чтобы список и шлюз
 *     не разошлись;
 *   • игнорируемое по `.gitignore` помечается признаком (git спрашивается порцией на каталог);
 *   • метки изменённого и нового берутся из состояния git и означают ОТЛИЧИЕ ОТ КОММИТА,
 *     кем бы правка ни была сделана (решение 4 человека: признака «агент правит прямо сейчас»
 *     в наборе нет);
 *   • всё, что внутри `.claude`, помечается «только чтение» — показываем, писать не даём;
 *     тем же признаком помечается ВСЁ содержимое проекта БЕЗ набора (`no_kit`): запись туда
 *     отказывает всегда, и «писать можно» у таких записей было бы обманом страницы;
 *   • всё, что совпало с образцами секретов, помечается «скрыто» И «только чтение»: имя видно,
 *     содержимое по умолчанию не отдаётся, а запись в такой файл отказывает всегда — правило
 *     имени берётся у шлюза (`isSecretPath()` в `pult/lib/fs-safe.mjs`), чтобы дерево и отказ
 *     режима записи не разошлись;
 *   • симлинк ПОКАЗЫВАЕТСЯ и не разворачивается — вид `other`.
 *
 * НАРУЖУ УХОДЯТ ТОЛЬКО ПОЛЯ БЕЛОГО СПИСКА: имя, вид, признак игнорирования, метка, признак
 * записи, признак секрета, признак обрезки списка. ИМЕНА ФАЙЛОВ — СВОБОДНЫЙ ТЕКСТ, и
 * экранировать их обязан потребитель (пункт 16 раздела 1.5 контракта).
 */

import path from 'node:path';

import { resolveTarget, readDirCapped, statSafe, isGitDirName, isSecretPath } from '../lib/fs-safe.mjs';
import { status, checkIgnored } from '../lib/git.mjs';
import { MAX_TREE_ENTRIES } from '../config.mjs';

/** Метки состояния git по относительным путям: `new` у неотслеживаемых, `changed` у прочих. */
function marksFrom(st) {
  const marks = new Map();
  if (!st.ok || !st.repo) return marks;
  for (const e of st.entries) {
    marks.set(e.path, e.kind === 'untracked' ? 'new' : 'changed');
  }
  return marks;
}

/**
 * Прочитать содержимое каталога.
 *
 * @param {string} root   корень проекта из записи реестра
 * @param {string} dir    относительный путь каталога (пустая строка — корень проекта)
 */
export async function readTree(root, dir) {
  const t = await resolveTarget(root, dir, { mode: 'read', kind: 'dir' });
  if (!t.ok) {
    return { ok: false, code: t.code, dir: null, entries: [], truncated: false, git: false, ignored_checked: false };
  }
  const rel = path.relative(t.root, t.path).split(path.sep).join('/');

  const listing = await readDirCapped(t.path, MAX_TREE_ENTRIES);
  if (!listing.ok) {
    return { ok: false, code: listing.code, dir: rel, entries: [], truncated: false, git: false, ignored_checked: false };
  }

  // Папка `.git` не показывается НИ НА КАКОМ УРОВНЕ: вложенный репозиторий показывал свою,
  // хотя доступ к ней закрыт шлюзом одинаково везде. Список и шлюз обязаны говорить одно
  // и то же, иначе человек видит папку, которая ни на что не отвечает.
  const names = listing.names.filter((n) => !isGitDirName(n));

  const st = await status(t.root);
  const marks = marksFrom(st);
  const ign = await checkIgnored(t.root, rel, names);

  const entries = [];
  for (const name of names) {
    const full = path.join(t.path, name);
    const childRel = rel ? `${rel}/${name}` : name;
    const s = await statSafe(full);
    let kind = 'other';
    if (s.ok) {
      if (s.stat.isSymbolicLink()) kind = 'other';
      else if (s.stat.isDirectory()) kind = 'dir';
      else if (s.stat.isFile()) kind = 'file';
    }
    // Внутри набора мы уже сами (`t.inKit`) либо это сама папка набора в корне проекта.
    const inKit = t.inKit || (rel === '' && name === '.claude');
    // ПИСАБЕЛЬНОСТЬ БЕРЁТСЯ ОТ ИСХОДА РЕЖИМА ЗАПИСИ у шлюза (`t.writable`), а не считается
    // здесь по одному признаку «внутри набора»: в проекте БЕЗ набора запись отказывает
    // всегда, и дерево, отвечавшее «писать можно» у всех записей, врало странице.
    //
    // Два уточнения на ЗАПИСЬ каталога добавляются здесь по одной причине: шлюз позвался
    // на каталог, а признаки нужны на каждую его запись. Оба берутся ТЕМИ ЖЕ функциями,
    // что и отказ режима записи (`isGitDirName()` выше и `isSecretPath()`
    // в `pult/lib/fs-safe.mjs`), а не переписываются условиями по соседству: файл под
    // образцом секрета закрыт на запись насовсем, и `writable: true` на нём — это активная
    // кнопка сохранения на файле секретов (находка ревью фазы 2, круг по части C).
    const secret = isSecretPath(name);
    const writable = t.writable === true && !inKit && !secret;
    // У каталога метка ставится, если под ним есть хоть одно отличие от коммита: свёрнутая
    // ветка иначе выглядит нетронутой, а внутри неё правка.
    let mark = marks.get(childRel) || null;
    if (!mark && kind === 'dir') {
      const prefix = `${childRel}/`;
      for (const p of marks.keys()) {
        if (p.startsWith(prefix)) { mark = 'changed'; break; }
      }
    }
    entries.push({
      name,
      kind,
      ignored: ign.ignored.has(childRel),
      mark,
      writable,
      secret,
    });
  }

  return {
    ok: true,
    code: null,
    dir: rel,
    entries,
    truncated: listing.truncated,
    // Признаки «чем мы пользовались»: без git нет ни меток, ни игнорирования, и молчать
    // об этом нельзя — иначе чистое дерево неотличимо от дерева без git.
    git: st.ok && st.repo,
    ignored_checked: ign.checked === true,
  };
}
