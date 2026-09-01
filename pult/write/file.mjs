#!/usr/bin/env node
/**
 * Сохранение ОДНОГО файла проекта. Единственный модуль пульта, который меняет чужие файлы.
 *
 * ГЛАВНОЕ, ЧТО НАДО ЗНАТЬ ПРО ЭТОТ ФАЙЛ. Гарантия «в набор не пишем» на фазе 2 стала
 * ПРОВЕРОЧНОЙ, а не структурной: раньше её держало отсутствие методов записи, теперь её
 * держат проверки шлюза `resolveTarget()` в `pult/lib/fs-safe.mjs`. Ослабление ЛЮБОЙ из них
 * открывает запись в кит, и снаружи это невидимо. Поэтому здесь нет и не должно быть
 * собственных проверок пути: свой порядок проверок рядом с чужим — это две гарантии, которые
 * при первой правке сойдутся по слабой.
 *
 * ФАЙЛЫ ПОД ОБРАЗЦОМ СЕКРЕТА СЮДА НЕ ДОХОДЯТ ВОВСЕ: шлюз отбивает их кодом `write_into_secret`
 * до всякой сверки токена. Признака, симметричного `reveal` у чтения, здесь нет намеренно —
 * показ секрета обратим и оставляет след, перезапись `.env` не лечится ничем (обоснование
 * выбора — у `writeRefusal()` в `pult/lib/fs-safe.mjs`).
 *
 * СВЕРКА ВМЕСТО БЛОКИРОВКИ. Клиент присылает токен, полученный при открытии файла; токен
 * пересчитывается по диску ЗАНОВО и обязан совпасть. Не совпал — отказ «файл изменился
 * с момента открытия» и НИКАКОЙ ЗАПИСИ, чтобы чужая правка не пропала молча.
 *
 * Это защита ОТ ГОНКИ, А НЕ ОТ АГЕНТА (решение 4 человека), и помешать агенту писать она
 * не может: агент пишет мимо демона. Она отвечает на другой вопрос — «изменился ли файл
 * с тех пор, как его показали человеку».
 *
 * СОДЕРЖИМОЕ ПИШЕТСЯ БАЙТ В БАЙТ ПРИСЛАННЫМ. Окончания строк не «чинятся» ни в какую
 * сторону: редактор, отдавший CRLF там, где в файле был LF, раздул бы дифф на весь файл,
 * а «починка» на нашей стороне сделала бы то же самое в обратную сторону.
 *
 * СЛЕД. Каждое успешное сохранение печатает ОДНУ строку в stdout: идентификатор проекта,
 * относительный путь, размер. Демон становится третьим пишущим в файлы человека (после него
 * самого и агента), и след превращает «файл изменился непонятно почему» в разбираемый случай.
 * Секретов в такой строке нет: ни содержимого, ни абсолютного пути.
 */

import path from 'node:path';
import process from 'node:process';

import { resolveTarget, writeProjectFile, readBytesCapped } from '../lib/fs-safe.mjs';
import { stateToken } from '../read/file.mjs';
import { FAULT, MAX_EDIT_FILE } from '../config.mjs';

const say = (s) => process.stdout.write(`[pult] ${s}\n`);

/**
 * Сохранить файл проекта.
 *
 * @param {string} root       корень проекта из записи реестра
 * @param {string} rel        относительный путь от клиента
 * @param {string} text       содержимое от клиента
 * @param {string} token      токен, полученный при открытии
 * @param {object} options    `projectId` — для строки следа в stdout
 */
export async function saveProjectFile(root, rel, text, token, options = {}) {
  if (typeof text !== 'string') return { ok: false, code: FAULT.BAD_BODY, token: null };
  if (typeof token !== 'string' || token.length === 0) return { ok: false, code: FAULT.BAD_BODY, token: null };

  const data = Buffer.from(text, 'utf8');

  // 1. ШЛЮЗ. Дальше работаем ТОЛЬКО по разрешённому пути: иначе между проверкой и записью
  //    родитель подменяется симлинком, и проверка становится совещательной.
  const t = await resolveTarget(root, rel, {
    mode: 'write', kind: 'file', size: data.length, limit: MAX_EDIT_FILE,
  });
  if (!t.ok) return { ok: false, code: t.code, token: null };

  // 2. СВЕРКА. Пересчитывается по диску заново — присланному токену на слово не верим.
  //    Файла нет вовсе (`t.stat === null`) — сохранение по неизвестному токену не проходит:
  //    создание файла в фазу не входит, и «его нет» здесь то же расхождение, что и «он другой».
  if (!t.stat) return { ok: false, code: FAULT.FILE_CHANGED, token: null };
  const current = await readBytesCapped(t.path, MAX_EDIT_FILE);
  if (!current.ok) return { ok: false, code: current.code, token: null };
  if (stateToken(t.stat, current.buf) !== token) {
    return { ok: false, code: FAULT.FILE_CHANGED, token: null };
  }

  // 3. ЗАПИСЬ. Временный файл рядом плюс переименование — это же и единственное, что отбивает
  //    жёсткую ссылку внутри проекта на файл снаружи (проверкой она не ловится вовсе).
  const written = await writeProjectFile(t.path, data);
  if (!written.ok) return { ok: false, code: written.code, token: null };

  const after = await resolveTarget(root, rel, { mode: 'write', kind: 'file' });
  const fresh = after.ok && after.stat ? stateToken(after.stat, data) : null;

  const id = typeof options.projectId === 'string' ? options.projectId : '-';
  // В след идёт путь, ВЫЧИСЛЕННЫЙ от разрешённого, а не присланная строка: печатать в свой
  // stdout чужой текст — та же ошибка, что печатать чужой заголовок.
  const shown = path.relative(t.root, t.path).split(path.sep).join('/');
  say(`сохранено: проект ${id}, ${shown}, ${data.length} Б`);

  return { ok: true, code: null, token: fresh, bytes: data.length };
}
