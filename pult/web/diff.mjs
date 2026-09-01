/**
 * Вкладка диффов: весь дифф задачи целиком — список изменённых файлов и полотно сравнения.
 *
 * ПОЛОТНО — РЕДАКТОР СРАВНЕНИЯ ИЗ УЖЕ ПРИВЕЗЁННОЙ ПОСТАВКИ, а не отдельная библиотека.
 * Библиотека, отдающая готовую разметку строкой, здесь не берётся НАМЕРЕННО: её вывод
 * строится из имён и содержимого чужих файлов, вставить его можно только разметкой, и
 * правило «разметка строкой на страницу не вставляется» пришлось бы нарушить или объявить
 * исключение. Редактор сравнения снимает вопрос целиком и не тянет третью зависимость.
 *
 * ОБЕ СТОРОНЫ СРАВНЕНИЯ ПРИХОДЯТ ГОТОВЫМИ С МАРШРУТА ДЕМОНА. Страница не зовёт систему
 * контроля версий, не разбирает единый дифф и не дорисовывает вторую сторону по месту:
 * там, на демоне, стоят разделитель аргументов, потолки размера, фильтр секретов и ключи,
 * которыми закрыт исполняемый вход через чужой конфиг репозитория. Дорисовать сторону
 * здесь — значит обойти всё перечисленное разом; поэтому в этом файле нет ни одного вызова
 * наружу, кроме двух маршрутов чтения.
 *
 * ВКЛАДКА ОТВЕЧАЕТ НА ДРУГОЙ ВОПРОС, ЧЕМ ЦЕНТР: там правка по одному файлу, здесь всё
 * дерево против последнего коммита. Обе нужны, и одна другую не заменяет.
 *
 * ФАЙЛЫ ПОД ОБРАЗЦАМИ СЕКРЕТОВ В ДИФФ НЕ ВХОДЯТ — их исключает демон, а вкладка честно
 * говорит, сколько их скрыто: молчание здесь читалось бы как «изменений нет».
 *
 * НЕОТСЛЕЖИВАЕМЫХ ФАЙЛОВ ЗДЕСЬ НЕТ ТОЖЕ, И ОБ ЭТОМ СКАЗАНО СТРОКОЙ. Дифф считается против
 * последнего коммита (`git diff HEAD`), а новых файлов он не показывает вовсе: задача,
 * которая только добавляет файлы, давала бы ПУСТУЮ вкладку при непустом дереве. Человек
 * при этом видит в дереве справа метку «новый», открывает вкладку — и файла нет, а список
 * выглядит ПОЛНЫМ. Поддержки неотслеживаемых фаза 2 не делает; молчания про них она тоже
 * не делает — число приходит от демона (`changedFiles()` в `pult/lib/git.mjs`) и печатается
 * ДВАЖДЫ: в итоговой строке сверху, которая видна всегда, и строкой под списком, где человек
 * ищет пропавший файл. Длинный список прокручивается, и одной строки внизу было бы мало.
 *
 * Проект без хранилища — не пустота, а объяснение: пустой список неотличим от «всё чисто».
 */

import { loadMonaco } from './editor.mjs';

// Коды отказов демона переводятся ПОИМЁННО и только те, у которых перевод что-то
// добавляет. Всё прочее уходит общей строкой С САМИМ КОДОМ: выдумывать объяснение
// незнакомому коду хуже, чем показать код как есть.
const FAULT_WORDS = Object.freeze({
  path_unreachable: 'путь недоступен',
  secret_hidden: 'файл закрыт как секрет',
  not_text_file: 'сторона сравнения не разбирается как текст',
  read_timeout: 'чтение не уложилось в отведённое время',
});

const fault = (code) => FAULT_WORDS[code] || `отказ демона: ${code || 'неизвестно'}`;

export function createDiff({ host, files, summary, modeButton, api, ui }) {
  const { el, clear, setText } = ui;

  let monaco = null;
  let view = null;          // редактор сравнения
  let sideBySide = true;
  let projectId = null;
  let selected = null;

  async function ensureView() {
    if (view) return view;
    monaco = await loadMonaco();
    view = monaco.editor.createDiffEditor(host, {
      theme: 'vs-dark',
      automaticLayout: false,
      readOnly: true,
      renderSideBySide: sideBySide,
      minimap: { enabled: false },
      fontFamily: 'ui-monospace, "Cascadia Mono", Consolas, Menlo, monospace',
      fontSize: 13,
      scrollBeyondLastLine: false,
    });
    return view;
  }

  /**
   * Пересчёт размеров полотна. ДВЕ ОГОВОРКИ, И ОБЕ ИЗМЕРЕНЫ, А НЕ ВЫВЕДЕНЫ ИЗ ДОКУМЕНТАЦИИ.
   *
   * 1. СПРЯТАННОЕ ПОЛОТНО НЕ МЕРЯЕТСЯ ВОВСЕ. `layout()` у скрытой вкладки запоминает ноль,
   *    и следующий вызов — уже на показанной вкладке — высоту НЕ восстанавливает: редактор
   *    сравнения остаётся полосой в 5 px, а под ней чёрное поле на всю высоту `#diff-host`.
   *    Зовут нас именно так: обработчик изменения размера окна и кнопка сворачивания правой
   *    колонки в `app.mjs` дёргают все три полотна разом, не глядя, какая вкладка открыта.
   * 2. РАЗМЕРЫ ПЕРЕДАЮТСЯ ЯВНО. Замер: отравленный редактор сравнения после `view.layout()`
   *    без аргументов — 644×5, после `view.layout({width, height})` — 644×601 и все 67 строк.
   *    Явная пара лечит и второй путь той же болезни: полотно, СОЗДАННОЕ пока вкладка была
   *    спрятана (вкладку успели переключить, пока летел ответ демона).
   *
   * Обычный редактор в центре этим не болеет — он восстанавливается сам (проверено там же),
   * поэтому правило стоит здесь, а не в общем месте: разное поведение — разный код.
   */
  function layout() {
    if (!view) return;
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (!width || !height) return;
    try { view.layout({ width, height }); } catch { /* полотно не показано */ }
  }

  /** Показать одну пару сторон. Обе строки приходят от демона и здесь только рисуются. */
  async function showFile(path) {
    selected = path;
    const r = await api.diffFile(projectId, path);
    const data = r.body || {};
    if (!r.ok || !data.ok) {
      setText(summary, fault(data.code));
      return;
    }
    if (data.hidden) {
      setText(summary, `${path}: содержимое скрыто как секрет`);
      return;
    }

    await ensureView();
    const head = data.head || { exists: false, text: '', binary: false };
    const work = data.work || { exists: false, text: '' };

    const lang = 'plaintext';
    const original = monaco.editor.createModel(head.binary ? '' : (head.text || ''), lang);
    const modified = monaco.editor.createModel(work.text || '', lang);
    const prev = view.getModel();
    view.setModel({ original, modified });
    if (prev) {
      if (prev.original) prev.original.dispose();
      if (prev.modified) prev.modified.dispose();
    }

    const notes = [];
    if (!head.exists) notes.push('нового файла в последнем коммите нет');
    if (head.binary) notes.push('сторона коммита двоичная — не показана');
    if (head.truncated || work.truncated) notes.push('сторона обрезана по потолку');
    if (!work.exists) notes.push(`рабочей стороны нет${work.code ? ` (${work.code})` : ''}`);
    setText(summary, `${path}${notes.length ? ` · ${notes.join(' · ')}` : ''}`);
    layout();
  }

  function fileRow(item) {
    const li = el('li', 'diff-file');
    if (item.path === selected) li.classList.add('is-active');
    li.appendChild(el('span', 'path', item.path));
    li.appendChild(el('span', 'plus', item.added === null ? '·' : `+${item.added}`));
    li.appendChild(el('span', 'minus', item.deleted === null ? '·' : `−${item.deleted}`));
    li.addEventListener('click', () => {
      for (const node of files.children) node.classList.remove('is-active');
      li.classList.add('is-active');
      showFile(item.path);
    });
    return li;
  }

  async function load(id) {
    projectId = id;
    clear(files);
    selected = null;
    if (!id) {
      setText(summary, 'проект не выбран');
      return;
    }

    const r = await api.diffList(id);
    const data = r.body || {};
    if (!r.ok || !data.ok) {
      setText(summary, fault(data.code));
      return;
    }
    if (data.repo === false) {
      // Объяснение, а не пустота: пустой список неотличим от «изменений нет».
      setText(summary, 'проект не под контролем версий — сравнивать не с чем');
      files.appendChild(el('li', 'muted small', 'диффа нет'));
      return;
    }

    const list = data.files || [];
    for (const item of list) files.appendChild(fileRow(item));
    if (!list.length) files.appendChild(el('li', 'muted small', 'отличий от коммита нет'));

    // НЕПОЛНОТА СПИСКА НАЗЫВАЕТСЯ ВСЛУХ. `null` — это «не сосчитано», и он не равен нулю:
    // ноль означал бы «новых файлов нет», а тут git просто не ответил на запрос состояния.
    // Проект без хранилища сюда не доходит — он ушёл выше, своей веткой с объяснением.
    if (data.untracked === null || data.untracked === undefined) {
      files.appendChild(el('li', 'muted small',
        'неотслеживаемые не сосчитаны — git не ответил на запрос состояния'));
    } else if (data.untracked > 0) {
      files.appendChild(el('li', 'muted small',
        `и ещё ${data.untracked} неотслеживаемых — «git diff HEAD» их не показывает;`
        + ' целиком новый каталог считается одной записью'));
    }

    const bits = [`файлов: ${list.length}`];
    if (data.hidden) bits.push(`скрыто как секреты: ${data.hidden}`);
    if (data.untracked) bits.push(`неотслеживаемых вне диффа: ${data.untracked}`);
    if (data.truncated) bits.push('вывод обрезан по потолку');
    setText(summary, bits.join(' · '));
  }

  /**
   * Сброс при смене проекта. ПОЛОТНО ЧИСТИТСЯ ВМЕСТЕ СО СПИСКОМ: иначе во вкладке остаётся
   * файл ПРОШЛОГО проекта, а подписи, что это чужое, нет — список пуст, итог говорит «дифф
   * не загружен», и человек читает сравнение не того проекта, который выбрал.
   */
  function reset() {
    projectId = null;
    selected = null;
    clear(files);
    setText(summary, 'дифф не загружен');
    if (view && monaco) {
      const prev = view.getModel();
      view.setModel({
        original: monaco.editor.createModel('', 'plaintext'),
        modified: monaco.editor.createModel('', 'plaintext'),
      });
      if (prev) {
        if (prev.original) prev.original.dispose();
        if (prev.modified) prev.modified.dispose();
      }
    }
  }

  modeButton.addEventListener('click', () => {
    sideBySide = !sideBySide;
    modeButton.textContent = sideBySide ? 'Показать лентой' : 'Показать в две колонки';
    if (view) view.updateOptions({ renderSideBySide: sideBySide });
    layout();
  });

  return { load, layout, reset };
}
