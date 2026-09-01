/**
 * Терминал в центре: `xterm.js` поверх вебсокета демона.
 *
 * СБОРКА БЕРЁТСЯ ИЗ ГЛОБАЛЬНЫХ ИМЁН (`Terminal`, `FitAddon`), а не импортом: `vendor/xterm`
 * — это UMD, и подключается он обычным `<script src>` ДО загрузчика AMD редактора. Порядок
 * подключения объяснён в `index.html` и переставлять его нельзя: увидев глобальный `define`,
 * та же сборка уходит в ветку AMD и глобальных имён не заводит.
 *
 * ДОПОЛНЕНИЕ ОДНО И ПОИМЁННО — подгонка размера. Работа с буфером обмена через управляющие
 * последовательности (OSC 52) и разбор ссылок с произвольными схемами НЕ включаются:
 * вывод в терминале — недоверенный текст (достаточно вывести чужой файл), и оба дополнения
 * превращают этот текст в действие, которое человек не начинал.
 *
 * ВИД СЕССИИ — ОДНО ИЗ ДВУХ СЛОВ, которые знает демон (`PTY_KINDS` в `pult/config.mjs`).
 * Произвольная команда клиентом не задаётся вовсе: ни команды, ни аргументов, ни рабочего
 * каталога в кадре нет — их вычисляет демон по слову.
 *
 * ПЕРЕПОДКЛЮЧЕНИЕ. Сессия живёт на демоне и переживает перезагрузку страницы: буфер
 * последнего экрана приходит первым кадром и просто печатается. Автоматически поднимать
 * сессию страница не имеет права — оболочка машины не должна заводиться от клика по списку
 * проектов, поэтому подключение всегда действие человека (кнопка).
 *
 * РАЗРЫВ СВЯЗИ ПОКАЗЫВАЕТСЯ СТРОКОЙ СОСТОЯНИЯ, А НЕ МОЛЧАНИЕМ: молчащий терминал
 * неотличим от терминала, где просто ничего не происходит, и человек продолжает печатать
 * в никуда. В строку идёт наше собственное машинное слово из закрытого словаря отказов
 * (демон присылает его причиной закрытия) — чужой текст сюда не попадает.
 */

const WS_PATH = '/ws/pty';        // тот же путь, что `WS_PATH` в `pult/config.mjs`
const MAX_INPUT_BYTES = 8192;     // тот же потолок, что `MAX_PTY_INPUT` там же
const CHUNK_BYTES = 3072;         // запас под обёртку кадра и экранирование JSON
const MAX_COLS = 500;
const MAX_ROWS = 200;

const KIND_WORDS = Object.freeze({ shell: 'оболочка', claude: 'Claude Code' });

/** Длина строки в байтах — потолок ввода у демона считается именно в байтах. */
function bytes(s) {
  return new TextEncoder().encode(s).length;
}

/**
 * Разбить ввод на куски под потолок кадра.
 *
 * Вставка из буфера обмена приходит одной строкой и легко перебивает потолок, а демон
 * на таком кадре ЗАКРЫВАЕТ СОЕДИНЕНИЕ — то есть человек потерял бы сессию за вставку
 * большого куска. Режем по кодовым точкам: резать по байтам нельзя, разрубленный символ
 * приедет в оболочку мусором.
 */
function chunks(data) {
  if (bytes(data) <= CHUNK_BYTES) return [data];
  const out = [];
  let buf = '';
  for (const ch of data) {
    if (bytes(buf) + bytes(ch) > CHUNK_BYTES) {
      out.push(buf);
      buf = '';
    }
    buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.trunc(v) || lo));

export function createTerminal({ host, button, kindSelect, status, dot, ui }) {
  let term = null;
  let fit = null;
  let ws = null;
  let live = false;
  let kind = 'shell';

  function say(text, tone) {
    ui.setText(status, text);
    if (dot) {
      dot.classList.remove('is-ok', 'is-warn', 'is-alarm');
      if (tone) dot.classList.add(tone);
    }
  }

  function setButton(label) {
    if (button) button.textContent = label;
    if (kindSelect) kindSelect.disabled = live;
  }

  function send(frame) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // Сокет умер между проверкой и отправкой: закрытие придёт своим событием.
    }
  }

  function ensureTerm() {
    if (term) return term;
    const Term = globalThis.Terminal;
    const Fit = globalThis.FitAddon && globalThis.FitAddon.FitAddon;
    if (typeof Term !== 'function') {
      say('сборка терминала не загрузилась', 'is-alarm');
      return null;
    }
    term = new Term({
      fontFamily: 'ui-monospace, "Cascadia Mono", Consolas, Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      // Тема — те же цвета, что у полотна в стилях страницы.
      theme: { background: '#101214', foreground: '#dfe2e4', cursor: '#94bce3' },
    });
    if (typeof Fit === 'function') {
      fit = new Fit();
      term.loadAddon(fit);
    }
    term.open(host);
    term.onData((data) => {
      if (!live) return;
      if (bytes(data) > MAX_INPUT_BYTES) return;   // страховка поверх нарезки
      for (const part of chunks(data)) send({ t: 'input', d: part });
    });
    term.onResize(({ cols, rows }) => {
      if (!live) return;
      send({ t: 'resize', cols: clamp(cols, 1, MAX_COLS), rows: clamp(rows, 1, MAX_ROWS) });
    });
    return term;
  }

  function layout() {
    if (!term || !fit) return;
    // Спрятанному узлу браузер отдаёт нулевой размер, и подгонка бросается: вкладка может
    // быть закрыта, это законно.
    try { fit.fit(); } catch { /* полотно не показано */ }
  }

  function connect(projectId, sessionKind) {
    if (live) return;
    kind = sessionKind === 'claude' ? 'claude' : 'shell';
    const t = ensureTerm();
    if (!t) return;
    layout();

    const cols = clamp(t.cols || 80, 1, MAX_COLS);
    const rows = clamp(t.rows || 24, 1, MAX_ROWS);
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}${WS_PATH}`
      + `?project=${encodeURIComponent(projectId)}&kind=${encodeURIComponent(kind)}`
      + `&cols=${cols}&rows=${rows}`;

    say(`подключаюсь (${KIND_WORDS[kind]})…`, 'is-warn');
    try {
      ws = new WebSocket(url);
    } catch {
      say('подключиться не удалось', 'is-alarm');
      return;
    }

    ws.onopen = () => {
      live = true;
      setButton('Отключить');
      say(`подключено (${KIND_WORDS[kind]})`, 'is-ok');
      send({ t: 'resize', cols, rows });
      t.focus();
    };

    // Кадры вывода приходят текстом: демон отдаёт то, что дал псевдотерминал, как есть.
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') t.write(ev.data);
    };

    ws.onerror = () => {
      // Подробности ошибки браузер не отдаёт, и выдумывать их нельзя: скажем только факт.
      say('связь с демоном оборвалась', 'is-alarm');
    };

    ws.onclose = (ev) => {
      const wasLive = live;
      live = false;
      ws = null;
      setButton('Подключить');
      // Причина — наше собственное машинное слово из закрытого словаря отказов демона.
      const why = typeof ev.reason === 'string' && ev.reason ? `: ${ev.reason}` : '';
      say(wasLive ? `связь разорвана${why}` : `подключиться не удалось${why}`, 'is-alarm');
    };
  }

  function disconnect(why) {
    if (ws) {
      try { ws.close(1000, 'client'); } catch { /* уже мёртв */ }
      ws = null;
    }
    if (live) live = false;
    setButton('Подключить');
    say(why || 'сессия не подключена', null);
  }

  setButton('Подключить');

  return {
    connect,
    disconnect,
    layout,
    connected: () => live,
  };
}
