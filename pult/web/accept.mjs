/**
 * ПРИЁМКА ЗАДАЧИ И ПАНЕЛЬ НАСТРОЕК ПРОЕКТА — оба показывают, и только один действует.
 *
 * (а) ПРИЁМКА `DONE.md`. Показывает итог задачи тем же маршрутом чтения, что и остальная
 * страница, и даёт три решения: принять, вернуть в работу, заблокировать. Каждое — это
 * МЕНЯЮЩИЙ КЛЮЧ словаря команд набора, то есть каждое проходит через системное подтверждение
 * главного процесса, а вывод показывается дословно.
 *
 * КНОПКИ ПОКАЗЫВАЮТСЯ, ТОЛЬКО КОГДА СХОДИТСЯ ВСЁ: проект в реестре, корень не отвергнут,
 * мост жив, статус задачи — ожидание приёмки, и ОТКРЫТАЯ ЗАДАЧА СОВПАДАЕТ С АКТИВНОЙ.
 * Последнее условие несущее, и причина записана здесь: команда набора работает с АКТИВНОЙ
 * задачей проекта, другой она не знает. Нажать «принять», глядя на итог одной задачи,
 * и перевести статус другой — худшее, что здесь может случиться, и заметить это человеку
 * будет нечем. Не сошлось — строка, ЧТО ИМЕННО не сошлось, а не молчаливо серая кнопка.
 *
 * (б) НАСТРОЙКИ ПРОЕКТА — ТОЛЬКО ПОКАЗ. Профиль состава, поимённые списки исключённого
 * и пропущенного ядра, содержимое служебного ключа владения из файла настроек и кнопка сноса.
 * Правок настроек из интерфейса в этой фазе нет вовсе.
 *
 * НАЗВАННАЯ ГРАНИЦА, БЕЗ КОТОРОЙ ПАНЕЛЬ ОБЕЩАЕТ БОЛЬШЕ, ЧЕМ ЗНАЕТ: файл настроек отпечатком
 * НЕ СВЕРЯЕТСЯ НИКОГДА — он стоит в списке пропускаемых у самого алгоритма набора. Поэтому
 * владение здесь ПОКАЗЫВАЕТСЯ ЧЕЛОВЕКУ, а не проверяется машиной: подмена внутри `_cckit`
 * не видна ни сверке отпечатка, ни этой панели — она видна только глазами.
 *
 * Весь чужой текст — только текстовым содержимым узлов; присваивания разметки строкой здесь
 * нет ни одного.
 */

/** Ключи решений приёмки — из закрытого словаря команд набора (`pult/config.mjs`). */
const DECISIONS = Object.freeze([
  { key: 'status_done', title: 'Принять', about: 'статус задачи → done' },
  { key: 'status_implementing', title: 'Вернуть в работу', about: 'статус задачи → implementing' },
  { key: 'status_blocked', title: 'Заблокировать', about: 'статус задачи → blocked' },
]);

/** Статус, в котором приёмка вообще уместна. Слово из словаря статусов набора. */
const READY_STATUS = 'awaiting_acceptance';

const FAULT_WORDS = Object.freeze({
  path_unreachable: 'файла итога нет',
  not_text_file: 'файл итога не разбирается как текст',
  secret_hidden: 'файл закрыт как секрет',
  bad_sender: 'запрос пришёл не от страницы пульта',
  cancelled: 'отменено человеком',
  run_busy: 'команда набора уже выполняется',
});

const fault = (code, message) => FAULT_WORDS[code] || message || `отказ: ${code || 'неизвестно'}`;

/**
 * @param {object} deps `host`/`taskLine`/`body`/`checklist`/`notice` — узлы приёмки;
 *                      `settings*` — узлы панели настроек; `api` — чтение с демона;
 *                      `shell` — мост; `ui` — общие помощники страницы.
 */
export function createAccept({
  host, taskLine, body, checklist, notice, closeButton,
  settingsHost, settingsPreset, settingsExcluded, settingsSkippedCore, settingsOwns, removeButton,
  api, shell, ui, onChanged,
}) {
  const { el, clear, setText } = ui;
  let project = null;
  let task = null;
  let busy = false;

  /** Условия, при которых решения вообще доступны. Возвращает причину отказа либо `null`. */
  function blockedReason() {
    if (!shell) return 'решения доступны только в оболочке пульта';
    if (!project) return 'проект не выбран';
    if (project.state === 'root_rejected') return 'корень проекта отвергнут — команды в нём не запускаются';
    if (!task) return 'задача не выбрана';
    if (task.status !== READY_STATUS) return `задача в статусе «${task.status || '—'}», а приёмка ждёт «${READY_STATUS}»`;
    const active = project.active_task && project.active_task.id;
    if (!active) return 'у проекта нет активной задачи';
    if (active !== task.id) {
      return `открыта задача ${task.id}, а активна ${active} — команда набора работает только с активной`;
    }
    return null;
  }

  /** Запустить решение. Подтверждение спрашивает главный процесс, не мы. */
  async function decide(key) {
    if (!shell || busy || !project) return;
    busy = true;
    setText(notice, 'выполняется…');
    notice.hidden = false;
    let res;
    try {
      res = await shell.runKitCommand(project.id, key);
    } catch (e) {
      res = { ok: false, code: 'bridge_failed', message: (e && e.message) || 'мост не ответил' };
    }
    busy = false;
    if (!res || res.ok !== true) {
      setText(notice, fault(res && res.code, res && res.message));
      return;
    }
    // ВЫВОД ДОСЛОВНО, включая код возврата: пересказывать отказ команды набора нельзя.
    const parts = [];
    if (res.stdout) parts.push(res.stdout);
    if (res.stderr) parts.push(res.stderr);
    parts.push(`код возврата: ${res.code}`);
    setText(notice, parts.join('\n'));
    if (res.code === 0 && typeof onChanged === 'function') onChanged();
  }

  /** Кнопки решений. Строятся заново на каждый показ: условия могли измениться. */
  function buildDecisions() {
    clear(checklist);
    const reason = blockedReason();
    if (reason) {
      const li = el('li', 'small muted', `решения недоступны: ${reason}`);
      checklist.appendChild(li);
      return;
    }
    for (const d of DECISIONS) {
      const li = el('li', 'small');
      const button = el('button', 'btn', d.title);
      button.type = 'button';
      button.title = `${d.about} · спросит системное подтверждение`;
      button.addEventListener('click', () => { decide(d.key); });
      li.appendChild(button);
      li.appendChild(el('span', 'small muted', ` ${d.about}`));
      checklist.appendChild(li);
    }
  }

  /** Прочитать `DONE.md` открытой задачи тем же маршрутом чтения, что и весь остальной пульт. */
  async function loadDone() {
    setText(body, '');
    if (!project || !task) return;
    const rel = `.claude/tasks/${task.id}/DONE.md`;
    const res = await api.file(project.id, rel);
    if (!res || !res.ok || !res.body) {
      setText(body, `итог задачи не прочитан: ${fault(res && res.body && res.body.code)}`);
      return;
    }
    setText(body, typeof res.body.text === 'string' ? res.body.text : '');
  }

  /**
   * Панель настроек: профиль состава, исключённое, пропущенное ядро и владение.
   *
   * Владение читается из файла настроек ТЕМ ЖЕ маршрутом чтения: файл лежит внутри папки
   * набора и доступен только на чтение — шлюз демона запись туда не пропускает.
   */
  async function loadSettings() {
    if (!settingsHost) return;
    if (!project) { settingsHost.hidden = true; return; }
    settingsHost.hidden = false;
    const comp = project.fingerprint && project.fingerprint.composition;
    setText(settingsPreset, comp ? comp.profile : 'записи о раскладке нет — профиль неизвестен');
    setText(settingsExcluded, comp && comp.excluded.length
      ? `исключено из сверки (${comp.excluded.length}): ${comp.excluded.join(', ')}`
      : 'из сверки ничего не исключено');
    setText(settingsSkippedCore, comp && comp.skipped_core.length
      ? `ядро, которое уже было у вас (${comp.skipped_core.length}): ${comp.skipped_core.join(', ')}`
      : 'пропущенного ядра нет');

    const res = await api.file(project.id, '.claude/settings.json');
    if (!res || !res.ok || !res.body || typeof res.body.text !== 'string') {
      setText(settingsOwns, 'файл настроек не прочитан');
      return;
    }
    let owns = null;
    try {
      const data = JSON.parse(res.body.text);
      owns = data && data._cckit ? data._cckit : null;
    } catch {
      setText(settingsOwns, 'файл настроек не разбирается как JSON');
      return;
    }
    if (!owns) { setText(settingsOwns, 'во владении пульта в этом файле ничего не числится'); return; }
    const allow = owns.owns && Array.isArray(owns.owns.allow) ? owns.owns.allow.length : 0;
    const deny = owns.owns && Array.isArray(owns.owns.deny) ? owns.owns.deny.length : 0;
    const hooks = owns.owns && owns.owns.hooks ? Object.keys(owns.owns.hooks) : [];
    setText(settingsOwns, `владение пульта: прав ${allow + deny}, групп хуков ${hooks.length}`
      + `${hooks.length ? ` (${hooks.join(', ')})` : ''}`
      + ` · файл создан пультом: ${owns.created_file === true ? 'да' : 'нет'}`
      + ' · отпечатком этот файл не сверяется никогда');
  }

  /** Снос набора: подтверждение спрашивает главный процесс, число файлов — сухой прогон. */
  async function remove() {
    if (!shell || !project || busy) return;
    busy = true;
    setText(settingsOwns, 'снос…');
    let res;
    try {
      res = await shell.removeKit(project.id);
    } catch (e) {
      res = { ok: false, code: 'bridge_failed', message: (e && e.message) || 'мост не ответил' };
    }
    busy = false;
    if (!res || res.ok !== true) {
      setText(settingsOwns, fault(res && res.code, res && res.message));
      return;
    }
    const r = res.remove;
    setText(settingsOwns, [
      r.ok ? `снято файлов: ${r.removed}` : `снос не прошёл: ${fault(r.code)}`,
      `оставлено не нашего: ${r.kept}`,
      r.settings ? `настройки: ${r.settings}` : '',
      ...r.notes.map((n) => `· ${n}`),
    ].filter(Boolean).join('\n'));
    if (typeof onChanged === 'function') onChanged();
  }

  /** Показать приёмку для выбранной задачи. */
  async function show(currentProject, currentTask) {
    project = currentProject || null;
    task = currentTask || null;
    if (!project || !task) { host.hidden = true; return; }
    host.hidden = false;
    setText(taskLine, `${task.title || task.id} · статус: ${task.status || '—'}`);
    notice.hidden = true;
    setText(notice, '');
    buildDecisions();
    await loadDone();
  }

  /** Показать панель настроек проекта (она живёт отдельно от экрана приёмки). */
  async function showSettings(currentProject) {
    project = currentProject || null;
    await loadSettings();
    if (removeButton) removeButton.disabled = !shell || !project;
  }

  function hide() {
    host.hidden = true;
  }

  function reset() {
    project = null;
    task = null;
    hide();
    if (settingsHost) settingsHost.hidden = true;
  }

  if (closeButton) closeButton.addEventListener('click', () => { hide(); });
  if (removeButton) removeButton.addEventListener('click', () => { remove(); });

  return { show, showSettings, hide, reset };
}
