/**
 * Дерево файлов проекта — правая колонка.
 *
 * ЛЕНИВО ПО КАТАЛОГАМ. Раскрытие каталога — это запрос за ЕГО содержимым, и не более того:
 * дерево целиком не обходится никогда, потолки демона остаются в силе, а свёрнутая ветка
 * ничего не стоит. Видно это во вкладке сети — на каждый раскрытый каталог ровно один
 * запрос.
 *
 * ЧТО ЗНАЧАТ МЕТКИ. `changed` и `new` приходят от демона из состояния git и означают
 * ОТЛИЧИЕ ОТ КОММИТА, кем бы правка ни была сделана. Признака «агент правит этот файл
 * прямо сейчас» в наборе нет вовсе (решение человека от 01.09.2026), и рисовать его
 * догадкой страница не имеет права.
 *
 * ПОМЕТКИ ЗАПРЕТА И СЕКРЕТА БЕРУТСЯ ОТ ДЕМОНА, а не вычисляются здесь по имени пути:
 * `writable: false` (внутри набора, в проекте без набора, у файла под образцом секрета)
 * и `secret: true` считает шлюз, и кнопка сохранения в редакторе рисуется по тому же
 * признаку. Посчитать это на странице «заодно» — значит завести второй источник правды,
 * который разъедется со шлюзом при первой правке одной из сторон и нарисует активную
 * кнопку сохранения на файле секретов.
 *
 * ФАЙЛ ПОД ОБРАЗЦОМ СЕКРЕТА ОБЫЧНЫМ КЛИКОМ НЕ ОТКРЫВАЕТСЯ. У него отдельное действие
 * «показать» — потому что осознанный шаг обязан выглядеть как шаг: демон на такой запрос
 * печатает строку следа в свой stdout, и человек должен понимать, что он её только что
 * оставил.
 *
 * ИМЕНА ФАЙЛОВ ВСТАВЛЯЮТСЯ ТОЛЬКО ТЕКСТОМ: это свободный текст из чужого каталога,
 * демон его не экранирует (и не должен), а разметка строкой здесь не вставляется нигде.
 */

export function createTree({ root, note, api, ui, onOpenFile }) {
  const { el, clear, setText } = ui;
  let projectId = null;

  function noteFor(data) {
    const bits = [];
    if (!data.git) bits.push('git недоступен: меток изменённого и нового нет');
    else if (!data.ignored_checked) bits.push('игнорируемые пути не проверены');
    if (data.truncated) bits.push('список каталога обрезан по потолку');
    return bits.join(' · ');
  }

  /** Строка дерева. Возвращает `<li>` с уже подвешенными обработчиками. */
  function row(entry, dirPath) {
    const li = el('li');
    const node = el('div', 'node');
    const path = dirPath ? `${dirPath}/${entry.name}` : entry.name;

    const isDir = entry.kind === 'dir';
    const glyph = el('span', 'glyph', isDir ? '▸' : (entry.kind === 'file' ? '·' : '~'));
    node.appendChild(glyph);
    node.appendChild(el('span', 'label', entry.name));

    if (entry.mark === 'changed') node.classList.add('is-changed');
    if (entry.mark === 'new') node.classList.add('is-new');
    if (entry.ignored) node.classList.add('is-ignored');

    if (entry.secret) node.appendChild(el('span', 'tag is-secret', 'скрыто'));
    else if (entry.writable === false && entry.kind === 'file') node.appendChild(el('span', 'tag', 'только чтение'));

    const children = el('ul');
    children.hidden = true;
    let loaded = false;

    if (isDir) {
      node.addEventListener('click', async () => {
        if (!loaded) {
          loaded = true;
          glyph.textContent = '…';
          await fill(children, path);
        }
        children.hidden = !children.hidden;
        glyph.textContent = children.hidden ? '▸' : '▾';
      });
    } else if (entry.secret) {
      // Обычный клик по секрету не делает НИЧЕГО, и это видно: рядом стоит отдельная кнопка.
      const show = el('button', 'btn btn-quiet', 'показать');
      show.type = 'button';
      show.addEventListener('click', (ev) => {
        ev.stopPropagation();
        onOpenFile(path, { reveal: true });
      });
      node.appendChild(show);
    } else if (entry.kind === 'file') {
      node.addEventListener('click', () => { onOpenFile(path, {}); });
    }

    li.appendChild(node);
    if (isDir) li.appendChild(children);
    return li;
  }

  /** Наполнить список содержимым одного каталога. */
  async function fill(list, dirPath) {
    clear(list);
    const r = await api.tree(projectId, dirPath);
    const data = r.body || {};
    if (!r.ok || !data.ok) {
      list.appendChild(el('li', 'muted small', `каталог не прочитан: ${data.code || r.status || 'нет связи с демоном'}`));
      return;
    }
    for (const entry of data.entries || []) list.appendChild(row(entry, data.dir || ''));
    if (!(data.entries || []).length) list.appendChild(el('li', 'muted small', 'пусто'));
    if (data.truncated) list.appendChild(el('li', 'muted small', 'список обрезан по потолку'));
    if (!dirPath) setText(note, noteFor(data));
  }

  async function load(id) {
    projectId = id;
    clear(root);
    setText(note, '');
    if (!id) {
      root.appendChild(el('li', 'muted small', 'проект не выбран'));
      return;
    }
    await fill(root, '');
  }

  return {
    load,
    reload: () => load(projectId),
  };
}
