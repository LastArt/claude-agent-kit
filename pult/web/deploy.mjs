/**
 * ЭКРАН МАСТЕРА УСТАНОВКИ: три состояния одного экрана.
 *
 *   «выберите папку» → «вот что нашлось / вот что будет добавлено / ничего из вашего
 *   не пропадёт» → «отчёт».
 *
 * СРЕДНЕЕ СОСТОЯНИЕ — ГЛАВНОЕ, И ОНО ТРЕБОВАНИЕ §4.2, А НЕ УКРАШЕНИЕ. Человек обязан увидеть
 * ДО раскладки: чужих агентов и команды, ЧУЖИЕ ХУКИ НАБОРА (они будут пропущены и НЕ ЗАПУЩЕНЫ),
 * есть ли у него файл настроек и `CLAUDE.md`, версию мастер-копии и строки его `CLAUDE.md`,
 * способные спорить с контрольными точками конвейера.
 *
 * ПРО ЧУЖИЕ ХУКИ ОТДЕЛЬНО. По замыслу экрана человек думает, что раскладывает набор, — а на
 * деле в этот момент он решает судьбу ЧУЖОГО КОДА: хук, который уже лежит в проекте, останется
 * и продолжит запускаться самим Claude Code, но пультом он не запускается никогда (сверка хеша
 * с мастер-копией). Молчать об этом нельзя.
 *
 * ПУТЬ НА ЭКРАНЕ ЕСТЬ, И ЭТО НЕ ПРОТИВОРЕЧИЕ. Инвариант фазы — НАПРАВЛЕНИЕ: путь рождается
 * в системном диалоге главного процесса и на страницу только ПРИХОДИТ; назначить каталог
 * страница не может ничем. §4.2 требует показать, куда ставим и где будет резервная копия.
 *
 * ВЕСЬ ЧУЖОЙ ТЕКСТ — ТОЛЬКО ТЕКСТОВЫМ СОДЕРЖИМЫМ УЗЛОВ. Присваивания разметки строкой здесь
 * нет ни одного: имена чужих файлов и строки чужого `CLAUDE.md` — это чужой текст.
 *
 * ОТЧЁТ ПОКАЗЫВАЕТСЯ ДОСЛОВНО, ВКЛЮЧАЯ ОТКАЗ ИНСТРУМЕНТА (§4.6 и критерий готовности фазы).
 */

/** Профили: ключ, имя и что человек получит. Копия словаря `PRESETS` (`pult/lib/profiles.mjs`). */
const PRESETS = Object.freeze([
  { key: 'full', title: 'полный', about: 'весь набор: девять агентов, все команды, хуки' },
  { key: 'no-docs', title: 'без документации', about: 'без агентов и команд документации, FAQ и релиза' },
  { key: 'checks-only', title: 'только проверки', about: 'без агентов вовсе: хуки, приёмка, гейт и обслуживание' },
]);

/**
 * Мастер-копия ниже этой версии не умеет неполных профилей — копия `MIN_PRESET_VERSION`
 * (`pult/deploy/deploy.mjs`). Причина: правило про отсутствующего агента появилось в промте
 * оркестратора только с 1.18.0, и без него неполный профиль оставил бы конвейер звать агентов,
 * которых в проекте нет.
 */
const MIN_PRESET_VERSION = '1.18.0';

const FAULT_WORDS = Object.freeze({
  bad_sender: 'запрос пришёл не от страницы пульта',
  bad_preset: 'профиль бывает только из закрытого словаря',
  bad_path: 'выбранный путь не годится',
  slot_empty: 'каталог не выбран — начните с осмотра',
  slot_expired: 'выбор устарел — выберите папку заново',
  run_busy: 'мастер уже занят',
  cancelled: 'отменено человеком',
  tool_missing: 'инструмент пульта не найден рядом с оболочкой',
  tool_timeout: 'инструмент не уложился в отведённое время',
  no_node: 'системный Node не найден',
  root_rejected: 'выбранный каталог отвергнут как корень проекта',
  root_is_kit_source: 'это папка с исходниками самого набора, а не проект',
  reference_missing: 'мастер-копии набора нет или её версия не читается',
});

const fault = (code, message) => FAULT_WORDS[code] || message || `отказ: ${code || 'неизвестно'}`;

/** Сравнение версий ПО ЧИСЛАМ: строковое делает `1.9.0` больше `1.18.0`. */
function versionAtLeast(have, min) {
  const parse = (v) => (typeof v === 'string' ? v.trim().match(/^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/) : null);
  const a = parse(have);
  const b = parse(min);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i += 1) {
    if (Number(a[i]) > Number(b[i])) return true;
    if (Number(a[i]) < Number(b[i])) return false;
  }
  return true;
}

/**
 * @param {object} deps узлы экрана, мост и общие помощники страницы; `onDeployed` — дверь
 *                      обратно в список проектов (обновить и выбрать новый).
 */
export function createDeployWizard({
  host, master, found, present, hooks, claudeMd, presetSelect, deployButton, backup, report,
  closeButton, shell, ui, onDeployed,
}) {
  const { el, clear, setText } = ui;
  let inspected = null;
  let busy = false;

  function setBusy(on) {
    busy = on;
    deployButton.disabled = on || !inspected;
    if (closeButton) closeButton.disabled = on;
  }

  /** Строка списка. Чужой текст уходит ТОЛЬКО текстовым содержимым. */
  function row(list, text, cls) {
    const li = el('li', cls || 'small', text);
    list.appendChild(li);
  }

  /** Профили: неполные при старой мастер-копии показываются НЕДОСТУПНЫМИ и с причиной. */
  function fillPresets(version) {
    clear(presetSelect);
    const modern = versionAtLeast(version, MIN_PRESET_VERSION);
    for (const preset of PRESETS) {
      const option = el('option', null, `${preset.title} — ${preset.about}`);
      option.value = preset.key;
      if (preset.key !== 'full' && !modern) {
        option.disabled = true;
        setText(option, `${preset.title} — недоступен: мастер-копия ${version || '—'} старше ${MIN_PRESET_VERSION}`);
      }
      presetSelect.appendChild(option);
    }
  }

  /** Состояние «вот что нашлось». Всё, что показывается, приходит из отчёта осмотра. */
  function showInspect(data) {
    inspected = data;
    setText(master, `мастер-копия: ${data.master || '—'} (версия ${data.masterVersion || '—'})`);
    setText(found, `выбран каталог: ${data.root || '—'} · будет добавлено файлов: ${data.willPlace.length}`
      + ` · уже есть и не будет тронуто: ${data.willSkip.length + data.willSkipCore.length}`);

    clear(present);
    if (data.marker) row(present, `ВНИМАНИЕ: ${data.marker} — раскладка в исходники набора отказывается`, 'small');
    row(present, data.kitPresent ? 'папка набора в проекте уже есть' : 'папки набора в проекте нет', 'small');
    row(present, data.settingsPresent
      ? 'файл настроек уже есть: наши строки будут ДОПИСАНЫ, чужие останутся'
      : 'файла настроек нет: он будет создан', 'small');
    row(present, data.claudeMdPresent
      ? 'у вас есть свой CLAUDE.md — набор его не трогает'
      : 'своего CLAUDE.md нет — набор его не создаёт', 'small');
    for (const rel of data.willSkip.slice(0, 40)) row(present, `уже есть, пропустим: ${rel}`, 'small muted');
    if (data.willSkip.length > 40) row(present, `…и ещё ${data.willSkip.length - 40}`, 'small muted');

    clear(hooks);
    if (data.hooksPresent.length) {
      row(hooks, 'ЧУЖИЕ ХУКИ НАБОРА в проекте — они останутся на месте и пультом НЕ ЗАПУСКАЮТСЯ:', 'small');
      for (const rel of data.hooksPresent.slice(0, 40)) row(hooks, rel, 'small muted');
    }

    clear(claudeMd);
    if (data.claudeMd.length) {
      row(claudeMd, 'В вашем CLAUDE.md есть строки, способные спорить с контрольными точками:', 'small');
      for (const line of data.claudeMd.slice(0, 20)) row(claudeMd, line, 'small muted');
    }

    fillPresets(data.masterVersion);
    setText(backup, 'Резервная копия папки набора делается ДО первой записи, в соседнюю'
      + ' .claude.backup-<дата>. Не сошлась — раскладка не начинается.');
    setText(report, '');
    setBusy(false);
  }

  /** Осмотр: открыть системный диалог и показать найденное. */
  async function inspect() {
    if (!shell || busy) return;
    setBusy(true);
    setText(found, 'выбор каталога…');
    let res;
    try {
      res = await shell.inspectProject();
    } catch (e) {
      res = { ok: false, code: 'bridge_failed', message: (e && e.message) || 'мост не ответил' };
    }
    setBusy(false);
    if (res && res.cancelled) { setText(found, 'каталог не выбран'); return; }
    if (!res || res.ok !== true) {
      inspected = null;
      setText(found, 'осмотр не прошёл');
      setText(report, fault(res && res.code, res && res.message));
      return;
    }
    showInspect(res.inspect);
  }

  /** Раскладка: ключ профиля из списка; путь берёт главный процесс из слота. */
  async function deploy() {
    if (!shell || busy || !inspected) return;
    const preset = presetSelect.value;
    setBusy(true);
    setText(report, 'раскладка…');
    let res;
    try {
      res = await shell.deployKit(preset);
    } catch (e) {
      res = { ok: false, code: 'bridge_failed', message: (e && e.message) || 'мост не ответил' };
    }
    setBusy(false);
    if (!res || res.ok !== true) {
      setText(report, fault(res && res.code, res && res.message));
      return;
    }
    const d = res.deploy;
    const lines = [
      d.ok ? 'раскладка прошла' : `раскладка не прошла: ${fault(d.code)}`,
      `профиль: ${d.presetTitle || d.preset || '—'}`,
      `каталог: ${d.root || '—'}`,
      `положено: ${d.placed} · пропущено: ${d.skipped} в agents/ и commands/, ${d.skippedCore} в ядре`,
      d.backup && d.backup.dir ? `резервная копия: ${d.backup.dir}` : 'резервная копия: не понадобилась',
      ...d.hooks.map((h) => `хук ${h}`),
      ...d.notes.map((n) => `· ${n}`),
      d.stderr ? `— поток ошибок —${'\n'}${d.stderr}` : '',
    ].filter(Boolean);
    setText(report, lines.join('\n'));
    // Слот использован: следующая раскладка обязана начинаться с осмотра заново.
    inspected = null;
    deployButton.disabled = true;
    if (d.ok && typeof onDeployed === 'function') onDeployed(d.registry && d.registry.id);
  }

  /** Показать экран. Без моста мастера нет вовсе: раскладывать нечем. */
  function show() {
    if (!shell) { host.hidden = true; return; }
    host.hidden = false;
    inspected = null;
    setText(found, 'каталог не выбран');
    setText(master, 'мастер-копия: —');
    setText(report, '');
    clear(present);
    clear(hooks);
    clear(claudeMd);
    fillPresets(null);
    setBusy(false);
  }

  function hide() {
    host.hidden = true;
  }

  if (deployButton) deployButton.addEventListener('click', () => { deploy(); });
  if (closeButton) closeButton.addEventListener('click', () => { hide(); });

  return { show, hide, inspect, deploy };
}
