/**
 * ПАНЕЛЬ КОМАНД НАБОРА: кнопки из закрытого словаря ключей и ДОСЛОВНЫЙ вывод.
 *
 * §4.6 контракта: команды набора запускаются как процессы, а вывод показывается КАК ЕСТЬ.
 * Отсюда три правила этого файла, и все три проверяемые:
 *
 *   1. ВЫВОД ПОКАЗЫВАЕТСЯ ТОЛЬКО ТЕКСТОВЫМ СОДЕРЖИМЫМ УЗЛОВ. Присваивания разметки строкой
 *      здесь нет ни одного: вывод чужой команды — это чужой текст, и вставлять его разметкой
 *      значит отдать странице то, чего мы не разбирали;
 *   2. ОТКАЗ НЕ ПЕРЕСКАЗЫВАЕТСЯ. Ненулевой код возврата показывается ЧИСЛОМ рядом с выводом,
 *      а не превращается в слово «ошибка»: команда объясняет отказ лучше, чем мог бы объяснить
 *      пересказ, и критерий готовности фазы требует именно дословности;
 *   3. МЕНЯЮЩИЕ СОСТОЯНИЕ ОТДЕЛЕНЫ ВИЗУАЛЬНО — человек обязан видеть разницу ДО нажатия,
 *      а не узнавать о ней из окна подтверждения.
 *
 * СПИСОК КЛЮЧЕЙ ПОВТОРЁН ЗДЕСЬ С УКАЗАНИЕМ ИСТОЧНИКА: страница констант демона не импортирует
 * (у неё нет доступа к `pult/config.mjs`), поэтому копия вынужденная. Источник — `KIT_READ_KEYS`
 * и `KIT_WRITE_KEYS` в `pult/config.mjs`, таблица аргументов — `pult/shell/kit-commands.mjs`.
 * АРГУМЕНТОВ ЗДЕСЬ НЕТ НИ ОДНОГО И БЫТЬ НЕ МОЖЕТ: страница присылает мосту только ключ.
 *
 * БЕЗ ОБОЛОЧКИ ПАНЕЛИ НЕТ ВОВСЕ. В браузере `window.cckitShell` не существует, запускать
 * команды нечем, и панель остаётся скрытой — как кнопка добавления проекта в фазе 3.
 */

/**
 * Ключи и подписи. Порядок — порядок кнопок; `changes` повторяет деление словарей.
 * Подписи здесь свои: человек читает кнопку, а не ключ.
 */
const KEYS = Object.freeze([
  { key: 'task_list', title: 'Задачи', changes: false },
  { key: 'task_path', title: 'Путь активной', changes: false },
  { key: 'verify_dry', title: 'Приёмка: что настроено', changes: false },
  { key: 'verify_selftest', title: 'Приёмка: самопроверка', changes: false },
  { key: 'gate_status', title: 'Гейт: состояние', changes: false },
  { key: 'gate_dry', title: 'Гейт: решение', changes: false },
  { key: 'banner', title: 'Версия и отпечаток', changes: false },
  { key: 'status_implementing', title: 'Статус: в работе', changes: true },
  { key: 'status_reviewing', title: 'Статус: на ревью', changes: true },
  { key: 'status_done', title: 'Статус: готово', changes: true },
  { key: 'status_blocked', title: 'Статус: заблокирована', changes: true },
  { key: 'task_close', title: 'Закрыть задачу', changes: true },
]);

/**
 * Коды отказов моста и главного процесса переводятся ПОИМЁННО и только те, у которых перевод
 * что-то добавляет. Всё прочее уходит общей строкой С САМИМ КОДОМ — то же правило, что
 * во вкладке диффов: выдумывать объяснение незнакомому коду хуже, чем показать код.
 */
const FAULT_WORDS = Object.freeze({
  bad_sender: 'запрос пришёл не от страницы пульта',
  bad_params: 'параметр не той формы',
  unknown_key: 'такой команды набора нет',
  unknown_project: 'проекта нет в реестре пульта',
  root_rejected: 'корень проекта отвергнут — команды в нём не запускаются',
  hook_missing: 'в проекте нет такого хука набора',
  not_confirmed: 'команда меняет состояние и требует подтверждения',
  cancelled: 'отменено человеком',
  run_busy: 'команда набора уже выполняется',
  no_node: 'системный Node не найден',
});

const fault = (code, message) => FAULT_WORDS[code] || message || `отказ: ${code || 'неизвестно'}`;

/**
 * @param {object} deps `read`/`write` — узлы под кнопки, `output` — узел вывода,
 *                      `status` — строка состояния, `code` — значок кода возврата,
 *                      `host` — вся панель, `shell` — мост (без него панели нет),
 *                      `ui` — общие помощники страницы.
 */
export function createKitRun({ host, read, write, output, status, code, shell, ui }) {
  const { el, clear, setText } = ui;
  let projectId = null;
  let busy = false;

  const buttons = [];

  /** Пока команда идёт — кнопки заблокированы: второй запуск главный процесс всё равно отобьёт. */
  function setBusy(on) {
    busy = on;
    for (const b of buttons) b.disabled = on || !projectId;
  }

  function showCode(value) {
    if (!code) return;
    if (value === null) { code.hidden = true; setText(code, 'код: —'); return; }
    code.hidden = false;
    setText(code, `код: ${value}`);
  }

  /**
   * ВЫВОД — ДОСЛОВНО. Два потока показываются подряд и разделяются ОДНОЙ нашей строкой,
   * потому что человеку нужно видеть, где кончается один и начинается другой; текст самих
   * потоков при этом НЕ ТРОГАЕТСЯ НИ ОДНИМ СИМВОЛОМ — включая хвостовые пробелы и перевод
   * строки в конце.
   *
   * Снятие хвостовых пробелов здесь БЫЛО и убрано (⚪ ревью 03.09.2026): это ровно то самое
   * «улучшение» вывода, ради запрета которого заведена проба `kitverbatim`
   * в `pult/tools/kitrun-check.mjs`, — только слоем выше неё: там сторожится модуль
   * оболочки, а здесь то же правило обходила страница. §4.6 контракта и критерий готовности
   * фазы требуют дословности, и аккуратность вывода её не стоит.
   */
  function showResult(result) {
    const parts = [];
    if (result.stdout) parts.push(result.stdout);
    if (result.stderr) {
      if (parts.length) parts.push('');
      parts.push('— поток ошибок —');
      parts.push(result.stderr);
    }
    if (result.killed) parts.push('— команда снята по таймауту —');
    if (result.truncated) parts.push('— вывод обрезан по потолку —');
    setText(output, parts.join('\n') || '(команда ничего не напечатала)');
    showCode(result.code);
  }

  /** Запуск одной команды. Ключ уходит мосту как есть; аргументов у страницы нет. */
  async function run(key) {
    if (!shell || !projectId || busy) return;
    setBusy(true);
    setText(status, 'выполняется…');
    showCode(null);
    setText(output, '');
    let result;
    try {
      result = await shell.runKitCommand(projectId, key);
    } catch (e) {
      result = { ok: false, code: 'bridge_failed', message: (e && e.message) || 'мост не ответил' };
    }
    setBusy(false);
    if (!result || result.ok !== true) {
      const reason = fault(result && result.code, result && result.message);
      setText(status, 'не выполнено');
      // ОТКАЗ ПОКАЗЫВАЕТСЯ ТЕКСТОМ, а не всплывающим окном: он остаётся на экране, пока
      // человек его читает, и попадает в тот же узел, что и вывод команды.
      setText(output, reason);
      showCode(null);
      return;
    }
    setText(status, result.title || 'готово');
    showResult(result);
  }

  /** Кнопки строятся из списка ключей, а не из разметки: разъехаться им негде. */
  function build() {
    clear(read);
    clear(write);
    buttons.length = 0;
    for (const item of KEYS) {
      // Меняющие состояние — заметная кнопка, читающие — тихая. Разница видна ДО нажатия.
      const button = el('button', item.changes ? 'btn' : 'btn btn-quiet', item.title);
      button.type = 'button';
      button.disabled = true;
      button.title = item.changes
        ? 'Меняет состояние проекта: спросит системное подтверждение'
        : 'Только читает';
      button.addEventListener('click', () => { run(item.key); });
      buttons.push(button);
      (item.changes ? write : read).appendChild(button);
    }
  }

  /** Показать панель для выбранного проекта. Без моста панель не показывается вовсе. */
  function show(id) {
    projectId = typeof id === 'string' && id ? id : null;
    if (!shell) { host.hidden = true; return; }
    host.hidden = false;
    setText(status, projectId ? 'выберите команду' : 'выберите проект');
    setBusy(false);
  }

  /** Сброс при смене проекта: вывод чужой команды не должен пережить переключение. */
  function reset() {
    setText(output, '');
    setText(status, 'выберите проект');
    showCode(null);
    projectId = null;
    setBusy(false);
  }

  build();
  return { show, reset, run };
}
