#!/usr/bin/env node
/**
 * Сверка происхождения — одна на ДВА входа в демон.
 *
 * Входов действительно два, и это главное, что нужно понимать про этот файл: обработчик
 * обычного запроса и событие `upgrade` — разные точки, маршрутизатор до второй не доходит.
 * Пока проверка жила внутри обработчика запроса, вебсокет обходил её целиком, а за адресом
 * вебсокета стоит оболочка машины.
 *
 * ЧТО ПРОВЕРЯЕТСЯ И ПОЧЕМУ ИМЕННО ЭТО:
 *
 *   • `Host` — точь-в-точь из закрытого списка. Привязка к `127.0.0.1` границей для браузера
 *     НЕ является: страница заводит домен, который переезжает на петлю, и запрос
 *     к `http://evil.example:7331/` для браузера становится однопроисхожденным. Сам `Host`
 *     Node не проверяет никогда.
 *   • `Sec-Fetch-Site` — если он есть, обязан быть `same-origin` или `none`. Отсутствие
 *     законно: консольные клиенты его не шлют.
 *   • `Origin` — ТОЛЬКО на апгрейде и по той же логике «есть — обязан совпасть, нет —
 *     проходит». Браузер шлёт `Origin` на рукопожатии ВСЕГДА, а консольный клиент не шлёт
 *     его вовсе, и именно браузер здесь — угроза.
 *
 * ПУСТОЙ `Origin:` СЧИТАЕТСЯ ОТСУТСТВУЮЩИМ, и это решение, а не случайность — условие
 * `origin.length > 0` стоит там намеренно. Из браузера такое недостижимо: он шлёт либо
 * сериализованное происхождение, либо слово `null` (второе отбивается верно, оно не в списке).
 * Пустое значение означает клиента, который заголовок выставил руками, — то есть тот же
 * консольный клиент, что проходит и вовсе без заголовка. Следующему читателю: «починка»
 * этого условия ничего не закрывает, а расширение его на пустую строку закрыло бы законный
 * случай — но и то и другое надо делать осознанно, а не «заодно».
 *
 * НАРУЖУ ВОЗВРАЩАЕТСЯ СВОЁ МАШИННОЕ СЛОВО (`host`, `site`, `origin`) либо `null`. Чужой
 * заголовок не попадает ни в возврат, ни в лог никогда: он пришёл извне. Слова различаются
 * ради stdout демона, а не ради ответа — наружу уходит одно `forbidden`, потому что какая
 * именно проверка отбила запрос, атакующему знать незачем, а человеку, разбирающему «почему
 * пульт не отвечает браузеру», знать необходимо.
 *
 * К ДИСКУ ЭТОТ МОДУЛЬ НЕ ОБРАЩАЕТСЯ ВОВСЕ.
 *
 *   node pult/lib/origin.mjs --selftest    шесть случаев на выдуманных заголовках
 */

import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { HOST_ALLOW, ORIGIN_ALLOW } from '../config.mjs';

/** `Host` и `Sec-Fetch-Site` — общая часть обеих проверок, слово отказа либо `null`. */
function commonRefusal(headers) {
  const host = headers && headers.host;
  if (typeof host !== 'string' || !host || !HOST_ALLOW.includes(host)) return 'host';
  const site = headers && headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return 'site';
  return null;
}

/**
 * Обычный запрос. Поведение фазы 1 сохранено БЕЗ ИЗМЕНЕНИЙ — это перенос, а не правка:
 * два заголовка, те же условия, те же два слова.
 */
export function requestRefusal(req) {
  return commonRefusal(req && req.headers);
}

/**
 * Апгрейд вебсокета: те же две проверки плюс `Origin`.
 *
 * Порядок важен только тем, что `Host` идёт первым: он отбивает больше и дешевле.
 */
export function upgradeRefusal(req) {
  const common = commonRefusal(req && req.headers);
  if (common) return common;
  const origin = req && req.headers && req.headers.origin;
  if (typeof origin === 'string' && origin.length > 0 && !ORIGIN_ALLOW.includes(origin)) {
    return 'origin';
  }
  return null;
}

// --- самопроверка ------------------------------------------------------------

function selftest() {
  const out = (s) => process.stdout.write(`${s}\n`);
  const good = HOST_ALLOW[0];
  const goodOrigin = ORIGIN_ALLOW[0];
  const cases = [
    ['пустой Host', { headers: {} }, upgradeRefusal, 'host'],
    ['чужой Host', { headers: { host: 'evil.example:7331' } }, upgradeRefusal, 'host'],
    ['годный Host', { headers: { host: good } }, requestRefusal, null],
    ['чужой Sec-Fetch-Site', { headers: { host: good, 'sec-fetch-site': 'cross-site' } }, requestRefusal, 'site'],
    ['чужой Origin', { headers: { host: good, origin: 'http://evil.example' } }, upgradeRefusal, 'origin'],
    ['Origin отсутствует', { headers: { host: good, origin: undefined } }, upgradeRefusal, null],
  ];
  let ok = 0;
  for (const [name, req, fn, expect] of cases) {
    const got = fn(req);
    const hit = got === expect;
    if (hit) ok += 1;
    out(`${name.padEnd(22)}: ${JSON.stringify(got)} (ожидание ${JSON.stringify(expect)})${hit ? '' : '  <-- РАСХОЖДЕНИЕ'}`);
  }
  out('');
  out(`годный Origin из списка: ${JSON.stringify(upgradeRefusal({ headers: { host: good, origin: goodOrigin } }))}`);
  out(`совпало: ${ok} из ${cases.length}`);
  return ok === cases.length ? 0 : 1;
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';

if (import.meta.url === entryPoint && process.argv[2] === '--selftest') {
  process.exit(selftest());
}
