# Готовые сборки страницы пульта — опись поставки

Здесь лежат **собранные** поставки двух сторонних библиотек и опись того, что именно
приехало. Шага сборки у пользователя быть не должно (решение 6 человека), поэтому сборки
живут в репозитории как есть, без бандлера и без установки пакетов.

**Зачем опись.** Эти файлы исполняются на странице, за которой стоит псевдотерминал
с доступом к оболочке машины: их подмена равна подмене терминала. Поэтому у каждого файла
записан sha256 — обновление вслепую видно **диффом описи**, а не только весом каталога,
а «мы обновили редактор» перестаёт быть непроверяемым утверждением.

Опись не заменяет доверия к апстриму и этого не обещает: она отвечает на вопрос «то же ли
лежит на диске, что лежало, когда это читали глазами», а не на вопрос «честен ли тот, кто
это собрал». Обе стороны названы ниже поимённо.

## Раскладка

```
pult/web/vendor/
  xterm/                 терминал: сборка, стили, дополнение подгонки размера
    xterm.js
    xterm.css
    addon-fit.js
  monaco/
    vs/                  редактор целиком, как он лежит в поставке (min/vs)
```

Всего **154 файла, 24 913 592 байта (23,8 МБ)**. Состав, размеры и хеши посчитаны на диске
и записаны в разделе «Опись» ниже.

Файлы отдаёт `serveStatic()` в `pult/lib/static.mjs` по закрытому словарю расширений
`STATIC_TYPES` в `pult/config.mjs`. Следствие, о котором надо знать заранее: тринадцать
файлов `nls/lang/*.d.ts` из поставки редактора **не отдаются** — расширения `.ts` в словаре
нет, и запрос к ним даёт 404. Странице они не нужны (это описания типов), но в описи они
есть: опись говорит, что приехало, а не что мы отдаём.

## 1. Терминал — `@xterm/xterm` 6.0.0 и `@xterm/addon-fit` 0.11.0

| Файл здесь | Пакет и путь внутри пакета |
|---|---|
| `xterm/xterm.js` | `@xterm/xterm@6.0.0`, `lib/xterm.js` |
| `xterm/xterm.css` | `@xterm/xterm@6.0.0`, `css/xterm.css` |
| `xterm/addon-fit.js` | `@xterm/addon-fit@0.11.0`, `lib/addon-fit.js` |

Канонические адреса происхождения — архивы реестра npm:
`https://registry.npmjs.org/@xterm/xterm/-/xterm-6.0.0.tgz` и
`https://registry.npmjs.org/@xterm/addon-fit/-/addon-fit-0.11.0.tgz`; путь внутри архива —
из таблицы, с приставкой `package/`.

Дополнение у терминала ровно одно — подгонка размера. Работа с буфером обмена через
управляющие последовательности (OSC 52) и разбор ссылок с произвольными схемами
не привозятся и не подключаются: вывод в терминале — недоверенный текст (достаточно
вывести чужой файл), и оба дополнения превращают этот текст в действие.

## 2. Редактор — `monaco-editor` 0.56.0, каталог `min/vs` целиком

Происхождение: `https://registry.npmjs.org/monaco-editor/-/monaco-editor-0.56.0.tgz`,
путь внутри архива `package/min/vs/**` → сюда как `monaco/vs/**` (151 файл).

Отдельной библиотеки показа диффов в поставке нет намеренно: дифф рисует **редактор
сравнения из этой же поставки**. Третья зависимость не привозится, и готовая разметка
на страницу не вставляется.

**Шрифта значков отдельным файлом в этой поставке нет вовсе.** Он встроен в
`monaco/vs/editor/editor.main.css` одним правилом `@font-face` с адресом
`url(data:font/ttf;base64,…)`; ссылок вида `url(...ttf)` в файле ноль. Отсюда несущее
следствие для политики содержимого: в `CSP` в `pult/config.mjs` директива шрифтов —
`font-src 'self' data:`. Под `font-src 'self'` браузер этот шрифт блокирует, и значки
редактора пропадают — с нарушением политики в консоли и пустыми местами на странице.

Воркеры редактор находит сам: адреса файлов из `monaco/vs/assets/` он считает от пути,
заданного загрузчику AMD, и поднимает их обычным `Worker` того же происхождения. Отсюда
`worker-src 'self' blob:` в политике; `script-src` при этом остаётся без `'unsafe-eval'`.

## 3. Нативный модуль демона — `node-pty` 1.1.0

Он не лежит в этом каталоге и в репозиторий не коммитится (`node_modules/` закрыт
в корневом `.gitignore`), но целостность поставки — один вопрос, поэтому раздел здесь.

| Что | Значение |
|---|---|
| Пакет | `node-pty`, версия `1.1.0`, точной строкой в `pult/package.json` |
| Файл блокировки | `pult/package-lock.json`, поле `integrity` архива: `sha512-20JqtutY6JPXTUnL0ij1uad7Qe1baT46lyolh2sSENDd4sTzKZ4nmAFkeAARDKwmlLjPx6XKRlwRUxwjOy+lUg==` |
| Платформа прогона | `win32`, `x64`, Node `v24.13.0` |
| Загруженный двоичный файл | `pult/node_modules/node-pty/prebuilds/win32-x64/pty.node`, 303 104 байта |
| sha256 этого файла | `ae323edd0835ee7b9e18cc96a7b2bb4b8173ff768317d178af2788406feb71ff` |

Готовые сборки везутся **внутри архива пакета**, на четыре платформы: `win32-x64`,
`win32-arm64`, `darwin-x64`, `darwin-arm64` — каталоги на месте, проверено списком.
Установочный сценарий пакета их только проверяет и по сети ничего не тянет.

Рядом, ради воспроизводимости, вторая зависимость демона: `ws` версии `8.21.3`,
`integrity` архива —
`sha512-201TZ/kPWxoPr/OKWjquZR1SWKXcvxdH+e1xrx89b3YbmzLMFCLfnaG1HFIgWzJOEWZ7MvpK++odZufgYR50Rw==`.

## Чем проверено и чем не проверено

**Чем проверено:**

1. Сборки приехали **внутри архива пакета**, а не были скачаны установочным сценарием,
   поэтому sha256 двоичного файла подпирается полем `integrity` архива в файле блокировки:
   подмена в цепочке поставки обнаружима диффом блокировки, а не только весом файла.
   Прогон шага 1 плана фазы 2 это подтвердил: `npm ci --ignore-scripts` плюс загрузка
   модуля (`require('node-pty').spawn` — `function`), без единого вызова `node-gyp`.
2. Сборка собрана на N-API: в `pty.node` **38 уникальных символов вида `napi_*`
   и ни одного `v8::`** (посчитано разбором самого файла). N-API стабилен по ABI между
   версиями Node, поэтому к версии Node сборка не привязана, обновление Node пересборки
   не требует, и поле `engines` остаётся `>=18`.
3. Состав и целостность файлов страницы: 154 файла, 23,8 МБ, sha256 каждого — в описи ниже.
4. Нормализация окончаний строк описи не мешает: **ни в одном из 154 файлов нет
   последовательности CRLF и нет нулевого байта** (посчитано побайтно). Корневое правило
   `* text=auto eol=lf` из `.gitattributes` переписывает CRLF в LF, а раз CRLF нет вовсе,
   в git файлы лягут байт в байт, и после свежего клона sha256 из описи обязан сойтись.
   Правила «двоичное» для `*.ttf`, `*.woff`, `*.woff2`, `*.otf`, `*.eot` к этой поставке
   не применяются вовсе — файлов таких расширений в ней нет (см. раздел 2 про шрифт
   значков); правила остаются на будущее, для библиотеки, которая привезёт шрифт файлом.
5. Наружу поставка не ходит: ни в `editor.main.css`, ни в `xterm.css` нет ни одного
   адреса ресурса со схемой (единственные вхождения `http` в `xterm.css` — текст лицензии
   в комментарии, а не адрес ресурса).

**Чего проверка не покрывает — поимённо, а не общей фразой:**

1. Прогон был на **одной машине и одной платформе** (`win32-x64`). Про остальные три
   платформы сказано **составом архива**, а не прогоном: каталоги сборок на месте, но
   ни одна из них здесь не загружалась.
2. `integrity` отвечает на вопрос «приехало ли то же, что записано при первой установке»,
   и **не отвечает** на вопрос «честен ли апстрим». Первая запись файла блокировки —
   доверие, и заменить его нечем.
3. N-API определён **разбором символов двоичного файла**, а не заявлением поставщика.
4. sha256 в описи фиксирует «что приехало **сюда**». Соответствие содержимому архивов
   реестра машинно здесь **не проверялось**: агент в сеть не ходит, файлы скачал человек,
   и адреса происхождения записаны с его слов. Внутри самих файлов строки версии нет
   (искали — не нашли), то есть «6.0.0», «0.11.0» и «0.56.0» подтверждаются адресом
   скачивания, а байты — только хешами ниже.
5. Работа в браузере хешами не проверяется вовсе: то, что редактор рисуется, а шрифт
   значков не заблокирован политикой, видно только глазами на открытой странице.

**Чего нет вовсе:** сборок `node-pty` под Linux у апстрима нет ни в одной версии —
установка там уходит в `node-gyp` и требует компилятора на машине пользователя. Linux
в фазе 2 **не поддерживается** решением человека от 01.09.2026 с причиной; причина
и альтернатива на случай пересмотра (`@lydell/node-pty` с платформенными пакетами через
`optionalDependencies`) названы в шаге 1 плана фазы 2 и в его разделе «Что НЕ входит».

## Как проверить эту опись

Каждая команда ниже **умеет провалиться** — это условие, а не украшение:

```bash
# 1. Ключевые файлы поставки на месте (нет файла — код 1).
test -f pult/web/vendor/monaco/vs/loader.js
test -f pult/web/vendor/monaco/vs/editor/editor.main.js
test -f pult/web/vendor/xterm/xterm.js

# 2. Шрифт значков встроен в CSS, а не тянется файлом или из сети.
grep -c "url(data:font/ttf" pult/web/vendor/monaco/vs/editor/editor.main.css   # ждём 1
grep -o "url([^)]*[.]\(ttf\|woff2\?\|otf\|eot\)[^)]*)" \
     pult/web/vendor/monaco/vs/editor/editor.main.css                          # ждём пусто, код 1
grep -oE "url\((['\"])?(https?:)?//" \
     pult/web/vendor/monaco/vs/editor/editor.main.css pult/web/vendor/xterm/xterm.css

# 3. Правила окончаний строк — на СУЩЕСТВУЮЩИХ файлах поставки.
git check-attr text eol -- pult/web/vendor/monaco/vs/loader.js                 # text: auto, eol: lf
git check-attr binary -- assets/readme/header-1280x320.png                     # binary: set

# 4. Хеши: опись против диска (блок ниже — в формате `sha256sum`).
cd pult/web/vendor && sha256sum -c <блок описи>
```

`git check-attr` сопоставляет **имя** с правилами и на диск не смотрит: на несуществующем
пути он отвечает так же бодро, как на существующем, — то есть проверкой поставки быть
не может. Поэтому в пункте 3 названы файлы, которые есть, а «файл на месте» вынесено
в пункт 1 отдельной командой, которая на пропаже падает.

## Что делать при обновлении

1. Скачать новую версию **целиком** (не отдельными файлами) и заменить каталог.
2. Пересчитать опись и **прочитать её дифф**: изменившиеся хеши — это и есть список того,
   что реально приехало. Изменившаяся длина списка — повод посмотреть, что добавилось.
3. Проверить страницу глазами: терминал печатает, редактор рисуется, значки редактора
   на месте (пропали — смотри `font-src` в `CSP`), в отладчике браузера нет ни одного
   запроса за пределы `127.0.0.1:7331`.
4. Обновление нативного модуля — только через `npm ci` по файлу блокировки, и раздел 3
   переписывается по факту прогона, а не по памяти.

Пересчитать опись целиком:

```bash
cd pult/web/vendor && find . -type f ! -path './README.md' | sort | sed 's|^[.]/||' | xargs sha256sum
```

**Исключение `README.md` здесь несущее, а не вкусовое.** Этот файл лежит в том же каталоге,
но в опись не входит: без исключения команда даёт **155** строк против 154, а дифф описи —
ради которого пункт 2 и написан — каждый раз показывает лишнюю строку с хешем самого файла,
меняющимся от любой правки текста. Исключение сделано по **пути**, а не по имени
(`! -name README.md` скрыл бы и одноимённый файл, приехавший внутри поставки).

Две оговорки для сверки вывода с описью. На Git Bash под Windows `sha256sum` работает
в двоичном режиме и печатает разделителем ` *` вместо двух пробелов — на `sha256sum -c`
это не влияет, но построчное сравнение с блоком описи требует привести разделитель
(`sed 's/ \*/  /'`). И порядок строк у `find`/`sort` — от каталога, а в описи — тот же,
поэтому сравнивать надо отсортированным по пути с обеих сторон.

## Опись: sha256 каждого файла

Пути — от этого каталога. Формат строки — `sha256`, два пробела, путь; блок пригоден
для `sha256sum -c` без правки.

```
80e43a53268d6a4c632ff9985bee1e7d0c6910cceadde464aa234bf36d0a6737  monaco/vs/abap-D-t0cyap.js
f65a5a9a27d2b6c2a2ec55a670486073ca76203fc63d5a3ef91a889fe3c6bda8  monaco/vs/apex-CcIm7xu6.js
7d3cfe5eb15cbfcb74cd50d29ebd9cf02dbf85078f076e6bab5fb8bdf6866ff1  monaco/vs/assets/css.worker-URu8fCFR.js
4670fc1d1386c9c0e205a54326c1035b35b3b4c12f5994638aac39d532f08352  monaco/vs/assets/editor.worker-lj3bdIIn.js
94fef4282ced27c8eb8d8062c55a6cf5d944939ee423f44bfc0f37108a7c35c4  monaco/vs/assets/editorWebWorkerMain-CA_vMoUU.js
f7dfe916c36fae8a8006cff2cd0ac8c0802145bf56ea2423b6dad75bb2a448e2  monaco/vs/assets/html.worker-D1SL3iM8.js
b56c369286f069b4451a41f31b28c8883ef9d631fcdc14a9b0611f4ecad6d2be  monaco/vs/assets/json.worker-CoJx_OPf.js
e2125361f4d70ce526a5f38142c6ce46902b672ac40c1bfaff08a6028196fc94  monaco/vs/assets/ts.worker-BWKtMYOk.js
b5f9c7d25c2cc748a1c965c9562de8b934b82e64dfa5e423c7121c8759090dd2  monaco/vs/azcli-BA0tQDCg.js
1e4c6af26a394c9c183185c4736642b0a07d446cffe109f98279f930d285ba9c  monaco/vs/basic-languages/monaco.contribution.js
e5bbd4d0719d157cc7dfa6b07e07da4104e52e687b97a6a0dc94e6d4cb4614b1  monaco/vs/bat-C397hTD6.js
39928909c2b244bf13dd2aad877f53966ba43b5b96442a6205306c670fd73a8e  monaco/vs/bicep-DF5aW17k.js
f8249bde4edaca22841907a087fb7c79dad81e7048ac6164937d184b23106d35  monaco/vs/cameligo-plsz8qhj.js
6dea514485eea7336b31343ea9eca9c18f3f3ce69e0ad52d39daf8f41beae311  monaco/vs/clojure-Y2auQMzK.js
f4ce02d5c428b0f84c7ed6b50edec729a64c0744b98164a148243b2e1cbd2d6d  monaco/vs/coffee-Bu45yuWE.js
691086029551bc7cfbb5ff157e01a935715a35c8330dc38c879b069a1cdc068c  monaco/vs/cpp-CkKPQIni.js
747c32cc96a655fcf8399f8ff8d99c4a73c34d529afd197dcbda9a8ba1eb0595  monaco/vs/csharp-CX28MZyh.js
0b477c46df69193baafc9fcecc16858244c168ff0f8de3a332a9221718e12a4e  monaco/vs/csp-D8uWnyxW.js
7e23b396ebf63139c3e8a490d4d0cee72070be0cbcc16751e21e76e77725ba1d  monaco/vs/css-CaeNmE3S.js
7a6d72f46803624bb550a6582202148754d3279f3dfa6aab43f4958a179e0634  monaco/vs/css.worker-CyhWkhHo.js
df96a1345540d38c080d13e11485c4b5c1aeeba4d5b49850a6d89d3fc3919149  monaco/vs/cssMode-CV6Ay48H.js
a55883356cc2c54a560383f9a2915922875f4fe6fe4149006b5b8f9232c2ba73  monaco/vs/cypher-DVThT8BS.js
5a73a1c81d0c57774058fd43afd24917db02127c3aa996b9b982c6f197aecbe0  monaco/vs/dart-CmGfCvrO.js
84d90d95ef722d2d63cd5e0a495ac484cb60d663f0e64ffc033a8de8db800d17  monaco/vs/dockerfile-CZqqYdch.js
2a96dc1d1ae80dca79169ca133a1475b1479b61b74e16f5fbbcfc4a1c0564828  monaco/vs/ecl-30fUercY.js
242e91c0d4f8ee2c061830e1a0060f2d51889ec22dc236b45f15ee3b6cde3ed3  monaco/vs/editor-KLE6jdfb.js
fc5ffff7b8d9131712323c12785564be61f41ed56ebdf34b5dc2cbaac49c0563  monaco/vs/editor.js
2c86bd3daaa759fd93725bf7ef6cee17c8e280f30ece0971921b85efea4ae992  monaco/vs/editor/editor.main.css
497d4ea65f4e84cb05e1f342c4552b6e91421095a5901dcfdb4a2ccda7f31afd  monaco/vs/editor/editor.main.js
b5d04c107914e7652f6ee354fe037c40c83ed44bcffb7cd5ae2f35399a69ec82  monaco/vs/editor/editor.worker.js
1dcb9fe9a82c34caee0f1fab4a7126a0d0a04cdfcab5a4c79ee2a33321233383  monaco/vs/editorWorkerHost-fVE1cjcC.js
12d8860be37bc331789e3bedac65ac60968fb0cc0a5ccda72d3eac0992618701  monaco/vs/elixir-xjPaIfzF.js
2cc6c9f6cf019557bfeb6cb313e0d65044af5920ca0b964dc62f960d470f0e0c  monaco/vs/flow9-DqtmStfK.js
b432937fbc555c643387998e23223369324f272778cd41d3e080c1ded5b4f733  monaco/vs/freemarker2-FWreY7v7.js
8bfbb5834411f0b16bd92c453385e33b6d93a98746358c79eafdca0e52c9e93a  monaco/vs/fsharp-BOMdg4U1.js
af135fca33281be8c049b06271d38a786a7b814de6a7b3b1a3ade31d18019c2a  monaco/vs/go-D_hbi-Jt.js
c48dc8ce6771c8320c51800f398ed8908fded44bdd30bc25bf735facf3b9fa68  monaco/vs/graphql-CKUU4kLG.js
de5b801be5138d6da5d45c37fb17c3369ca891b19ca6fba705896c8aca459146  monaco/vs/handlebars-CZi4pHCH.js
a260db459911f838c6aa331b6efa841d5fd9360ec253541fea015a62594b4296  monaco/vs/hcl-DTaboeZW.js
dcec2e3027786060c8b5835eda8773545826d1269a86bb7815a0813cce6d5deb  monaco/vs/html-j_7ZTNRU.js
78a924d6f9f7df5f55668b2c699a7e47f7794342f254a4a4d85d1801bac9e355  monaco/vs/html.worker-CA3iAimZ.js
65b932db32c65595cb5ff23c2aede962ef15ac2b143367b6b5b29d9104a2e09e  monaco/vs/htmlMode-27by_KM4.js
ddde937284533f03fd5c1bb4c55bd73f2ff2e58a131a48ec74ed00a2e1e42773  monaco/vs/index-049xrXrp.js
0af4fc05efa9afb21cc5902f21a02be8f3b29e91028c0183f1888f4ea71e11b9  monaco/vs/index-CBVt3dzv.js
2f30cb097c9418257573ccb92fe0d373be424e6b98fa25407d239c578b6c70de  monaco/vs/index.js
b4fbfcd2b005881b0fcbdbfd6421acfd461717db35585c66d20326e79a12f9b8  monaco/vs/ini-CsNwO04R.js
e08ae8f24ffd0d4e230a22eb904cf2dec51b5a12b5e3a436d422acc61a06c836  monaco/vs/initialize-DL0l1TGY.js
a20ff4f207bca6f457f62f5d875da04e981d66bde50a977e8d2c0be47e91aaaf  monaco/vs/java-CI4ZMsH9.js
0697422f7a7d882cbe70619207e73153f4a243c36d25dc4c4534af2500e6e643  monaco/vs/javascript-DTJl4Jn1.js
52b13446e5ee1ab17e459ce2b587ef8f8bc972421458cd54669fcb575c4a5d50  monaco/vs/json.worker-BizpAl9O.js
0d9fd7a63bfc6b9212ee7fc33bbaf46483c5935799ea312a60b9d75fa3ef8ee9  monaco/vs/jsonMode-DLUiMUrI.js
291cf2327138ecf28f8d89045a7978ad065d2bfff59575b832c5d9bd814e9623  monaco/vs/julia-BwzEvaQw.js
e30cf3e62994e7c32847542a791504eadf029dbc092594e2e057e79fe17c0159  monaco/vs/kotlin-IUYPiTV8.js
6bfab50d8a72a1ee4ff4cd6f9ae09e2d99306ba0a8524ef3e4ed0664b27494bf  monaco/vs/language/css/css.worker.js
caa9f3348aeb507cb39aab8fdde056284751af85240da5f1bdf1476d025d6ef5  monaco/vs/language/css/monaco.contribution.js
4d2b92e14c51ee46b9ffa66064b97d19abd6848576df7361d6cd90e0fcc5b2f1  monaco/vs/language/html/html.worker.js
fbca6521916a9ca8ed7ff525c32c86d49fde622802572b46c133a3c2d923d2af  monaco/vs/language/html/monaco.contribution.js
a426aef56001f25e50e249a1a26c65825eae01dba1dfec2a85a6390156b4277f  monaco/vs/language/json/json.worker.js
303afd97deae7ef13a89b0ee9221516f767c1863701502f0ff42e8d201c41287  monaco/vs/language/json/monaco.contribution.js
bd776de100174daee46986ec6bc39efa923091d54dd228f90ae328590a12a8bc  monaco/vs/language/typescript/monaco.contribution.js
e390a84a74948b602ea83807b47e52e94f557d1c914e7b141fd2ebbd287ea056  monaco/vs/language/typescript/ts.worker.js
e3c00c4fb4e99ea039ec49308d637ff3581fdd1ab695b18a8ad1f7299fe428a4  monaco/vs/less-C0eDYdqa.js
fbccd913c524e992cac0d3c3e5ddc31c3c2dc67c04c704e47f298838dd08ed1d  monaco/vs/lexon-iON-Kj97.js
2573b991169a67415f7bc5d33089783baca7d4c4cfb1ebf247fbde63e9d7742c  monaco/vs/liquid-CLJYelW6.js
35b59df80b41a8b73bf1ceb159b44f040567c2ab53f4e77a3d002d9dc39d55d1  monaco/vs/loader.js
3de95049f652b7ce2b3d5d115eab746c8870f9cd8a47e3833030f45510451630  monaco/vs/lspLanguageFeatures-BIkJOWLw.js
16e36e65f32eeb630be4622b6066d42ebf03b35d2aa60f8ddd884ee8c2bc8448  monaco/vs/lua-DtygF91M.js
8cd14878f7f2bf8ca1293a47e368f6b351d6ebd667a072049999281db306df1a  monaco/vs/m3-CsR4AuFi.js
393cc4473613f2314e73964e287ca23990a1c751c9b2bf09ea01f26a80f1ad47  monaco/vs/main-BEx-Fmlo.js
1e89389527e31139925d680012e813dc9ab195b1c6ff98634cc3f5f93df16eb0  monaco/vs/main-DsK8pnKg.js
daab8a5150c09dd393aca1ab782bd6a1bf13c12b2f961a33a8420932c6be32c5  monaco/vs/markdown-C_rD0bIw.js
deabcb3cbe4c05af61ead9514b227fcc3d6d5124b685aa8a23f0023656555947  monaco/vs/mdx-CpzZIPHF.js
6c936f788a9b27b8464a492c0a7e62b439caff1b05bea2eb5a837b663663cf08  monaco/vs/mips-CiYP61RB.js
1eaf2e813456a583e6a3e2cf7d8a9f521a4efa0e83852159394d6ad45d742a2f  monaco/vs/monaco.contribution-9cKT3C7t.js
b7cc63f56cdb61a7b03971edef3faf3532fc73efb46077caabdb3b41fb267bea  monaco/vs/monaco.contribution-BE88ZNGY.js
7d618c62cd2fc7c02aa933ef165d90c906bd57139ba62129d41998cbe7e0eb2e  monaco/vs/monaco.contribution-BPhsneLd.js
6f8ea9b7fd550b1ac7930ca342c28512c7ee4239d983fa8eb4c51c4f2983a659  monaco/vs/monaco.contribution-BgRy6xDf.js
c32791ca0a361d805fa92d92f07d316b459badacc5dd51efbc760eaf9168ae83  monaco/vs/msdax-C38-sJlp.js
d9a7c012fd5dd55810488d928eb0e4dc3e4e8c856c5d45a497d02b4ade124510  monaco/vs/mysql-CdtbpvbG.js
c2ec390ded129b3ed8b7994c348246be7ac83969019177ea5bb23278cbe4e1b1  monaco/vs/nls.messages-loader.js
2e29cd9a98755c46896f7a2d56524db2d6d96b248e36db46de14c30bf47c8d05  monaco/vs/nls/lang/cs.d.ts
ba16ac6615f5459758b2c3b1c6f42b7b70da8d32863408ff0ab939ab4a89d2be  monaco/vs/nls/lang/cs.js
2e29cd9a98755c46896f7a2d56524db2d6d96b248e36db46de14c30bf47c8d05  monaco/vs/nls/lang/de.d.ts
17a1783d7792e2b171a12b6d10277e044d7ec0733c0fee1d22d0bcdb9245e235  monaco/vs/nls/lang/de.js
2e29cd9a98755c46896f7a2d56524db2d6d96b248e36db46de14c30bf47c8d05  monaco/vs/nls/lang/es.d.ts
c46b67bbcaa333556470976dd65efe82840684fcc801cc0f5b7505b215f9b34e  monaco/vs/nls/lang/es.js
2e29cd9a98755c46896f7a2d56524db2d6d96b248e36db46de14c30bf47c8d05  monaco/vs/nls/lang/fr.d.ts
ef71b1ebd5df83eba8e643655c8feeee994a8002058314a902e3ead1b3160a21  monaco/vs/nls/lang/fr.js
2e29cd9a98755c46896f7a2d56524db2d6d96b248e36db46de14c30bf47c8d05  monaco/vs/nls/lang/it.d.ts
cd16f125e48e5e0c7c9c8224fecbf3ffa26565ec29196874dbd7b236b36670ba  monaco/vs/nls/lang/it.js
2e29cd9a98755c46896f7a2d56524db2d6d96b248e36db46de14c30bf47c8d05  monaco/vs/nls/lang/ja.d.ts
c7f06b29f40f0984051114ea4fcfe29a559b372082d01e8e7b7b6e6f32f8650e  monaco/vs/nls/lang/ja.js
2e29cd9a98755c46896f7a2d56524db2d6d96b248e36db46de14c30bf47c8d05  monaco/vs/nls/lang/ko.d.ts
9cd73337c47629286c99146abbb66770dc0396f0178ff8b51a8788b9fa7df2d7  monaco/vs/nls/lang/ko.js
2e29cd9a98755c46896f7a2d56524db2d6d96b248e36db46de14c30bf47c8d05  monaco/vs/nls/lang/pl.d.ts
604f30866a04963e989bd299c4f0a4f00332882d408080d567df902bf0202442  monaco/vs/nls/lang/pl.js
2e29cd9a98755c46896f7a2d56524db2d6d96b248e36db46de14c30bf47c8d05  monaco/vs/nls/lang/pt-br.d.ts
dd586f64a76f072ca7f301e753af5e34bc4efe97d1e84f5f3ed4283b487147d8  monaco/vs/nls/lang/pt-br.js
2e29cd9a98755c46896f7a2d56524db2d6d96b248e36db46de14c30bf47c8d05  monaco/vs/nls/lang/ru.d.ts
d2b7c033f3d69adf6a615e92ea8e83869e9a5ac55480963e3c3b3ec7e6acec0a  monaco/vs/nls/lang/ru.js
2e29cd9a98755c46896f7a2d56524db2d6d96b248e36db46de14c30bf47c8d05  monaco/vs/nls/lang/tr.d.ts
e54695293124d805e016c8b73714a2591d0b6f30f2c9720e0f1b3a5569be0c7b  monaco/vs/nls/lang/tr.js
2e29cd9a98755c46896f7a2d56524db2d6d96b248e36db46de14c30bf47c8d05  monaco/vs/nls/lang/zh-cn.d.ts
9ab1f078c79de7adfc19ae3ec640cd77f54c76d017d0e5d54b46e5cb9aa6cafb  monaco/vs/nls/lang/zh-cn.js
2e29cd9a98755c46896f7a2d56524db2d6d96b248e36db46de14c30bf47c8d05  monaco/vs/nls/lang/zh-tw.d.ts
9e28ed54a7bdc15b9e0ae23451255b17e05b7436d96bd4067e6f15008fe2596a  monaco/vs/nls/lang/zh-tw.js
1cd6f9265e8ca66348cb976ffc510edaff6997a6d8edc96b67d674d47997899f  monaco/vs/objective-c-CntZFaHX.js
d3cfdc9a2419b8caef88c9a8d8e4857092420300f9d5f2261203b7809c41943f  monaco/vs/pascal-r6kuqfl_.js
04a26822cfb8ce658bd5b71c12952e397e675f64280081564ebe59c764fc1939  monaco/vs/pascaligo-BiXoTmXh.js
1e8d8ed1e81b192d98af1d0a714dbccb338bc5fa3557d6ae82274194b73713a1  monaco/vs/perl-DABw_TcH.js
3741dbb2623c71677e3e1d357e66dc8167129fbcddc40529e13438a0f969c628  monaco/vs/pgsql-me_jFXeX.js
e834d0cafddfd7b0f3aa8d29e30a9956680ad8819446c5cbf1c6f5f0f00d672c  monaco/vs/php-D_kh-9LK.js
e3b5b0b3cd82e9ca1c28975a9019da75ebd972b238151ffb0fef0f15c8ab847f  monaco/vs/pla-VfZjczW0.js
0b832f7fda01fb6cbde140b562ea11358d5ca8b1ee6bdf0db5915019d035c942  monaco/vs/postiats-BBSzz8Pk.js
ee0e9b4239a70028c6947afc8a932d92fb85f08d1c49808944ad4a6a00be0282  monaco/vs/powerquery-Dt-g_2cc.js
9856349e4382b5677dc41b2ad8086152304d30b48057b9fca8b2a6368957da40  monaco/vs/powershell-B-7ap1zc.js
0728d711ae1df4b386104df5a4665cdb958f2cc7a6b9cc622573f3812df30bcc  monaco/vs/protobuf-BmtuEB1A.js
e92bb527a6c961dd7e0b028dd209124c776a3f25a625373cfee36506ad234b53  monaco/vs/pug-BRpRNeEb.js
26894261b889e9c2b37dae8b46c2ef196f83cdf55d3c6d539623ae1b36e31944  monaco/vs/python-CqWUUgfu.js
c2beabe7876542bcd360008886351e4845d1a03602ca391a09f60eb20dcc7877  monaco/vs/qsharp-BzsFaUU9.js
8b7e4cf13007cc02bdfabb8781fae0a56be07bd8177e10bad7ff49674f91cb2a  monaco/vs/r-f8dDdrp4.js
77aa4714e6b107ce4258fdf5717fd32f3157b632952d54ae4cd97ed8ec232913  monaco/vs/razor-hok5y9Km.js
c806c1e46656d0a13bf6695d78af89afb5cb58d050ed0f85572d74a8cde69568  monaco/vs/redis-fvZQY4PI.js
9750bbcd40ebffd72aaa4b2a113a1f1982b79fd72c1ab8616a0582a29548095a  monaco/vs/redshift-45Et0LQi.js
33e9285d3b5908a5e854fa5a34fde13f4c32fded6525bfb9948fa64c0432b7b0  monaco/vs/restructuredtext-C7UUFKFD.js
56c7a3ae5ac52509e7398da3d3b7ed16645985c8e46794ae526e101d60748ee0  monaco/vs/ruby-CZO8zYTz.js
ff05b26de2000433ad35afbdf250f96f55eaa4e862804deda0ead27ebdf4f9a1  monaco/vs/rust-Bfetafyc.js
4abaf69a27c130e55cd5202e42b48eb9d96515b9161f6468aab178459c85a2e4  monaco/vs/sb-3GYllVck.js
f9ac4595980f67fe4df9c65402de72fc3bcd6234ca682624f53427e72fc23c84  monaco/vs/scala-foMgrKo1.js
708f7f931ee52dae9d7cb0420665120271e38100376ed578548eba4df18db12a  monaco/vs/scheme-CHdMtr7p.js
b5e83dba3a0fadd33d3c29daf030ef831c1d6158c7211c8ad4cbac51b598da78  monaco/vs/scss-C1cmLt9V.js
0dd40deb01217f2de8df014b3ea910dce7794adf5849636f8c39c19bff40abeb  monaco/vs/shell-ClXCKCEW.js
fa2641d40cca156c21ccbaa6628981dbea7bfcb809af0c86541b31e91cf582a0  monaco/vs/solidity-MZ6ExpPy.js
225a5f3d75337b156f90e05cbb3d9eb87f0c5d26228bd7b5964a27d5bd2c3fee  monaco/vs/sophia-DWkuSsPQ.js
6a3c861e35b44a4288021a868d50dd135370ed1d556fc0d9729e003c606ba883  monaco/vs/sparql-AUGFYSyk.js
91584effb532e0b052d806914c34e5087fee39516d126720382887bf0eef268d  monaco/vs/sql-32GpJSV2.js
419d9fa82988329be4bce8dee4b16c23e1dd9d5a925c2b58a9f2275d139ae1a2  monaco/vs/st-CuDFIVZ_.js
e083a440cc19ffea101cafe90ddd8932ba486ed35c16bbc1494b04d58da716b8  monaco/vs/swift-t-PfMj7W.js
0a5c60be86cfbb173b863503baf73336210593172388f03ff6c0ce8e2e08ccb9  monaco/vs/systemverilog-Ch4vA8Yt.js
c492eb652ab826b99b2d2503bfa65162ef14eefabd9f5da70bed03beefba39f8  monaco/vs/tcl-D74tq1nH.js
839a87169e030e7312a2931a20206ba5e6eb4a59d2cbde3d1c2bfff693bef59e  monaco/vs/toggleHighContrast-qGX7E9o7.js
56d3b116c7296089890d4020496eaf29f17bc803110127bbc69db0244bd32d0d  monaco/vs/ts.worker-2QLmBukE.js
bc088e1defb899893bc5fcc9cd7539d376131ed964a89fd6733371c07f45c81b  monaco/vs/tsMode-B0S_kp2q.js
bbeb5d2f6d6d45790b36720c969c1ab63b0faccff9a950bb48aa82d997a23cba  monaco/vs/twig-C6taOxMV.js
b35f89c8991c2352576ea0d3d3cd24308345eb57df9be49cbe694dd8511af4d0  monaco/vs/typescript-_2t_511t.js
39e3ba1a138a90aa3dbd7001cec575f4a4f3f08775837c6f9d6587d6605ab8af  monaco/vs/typespec-8OfoLt6R.js
22984a593503cf70994469f3939a16d6d25926f3e32d4d91a5ff28afb6c92285  monaco/vs/vb-Dyb2648j.js
55e72c889d2acc6fb75ce2765751d7d2ff39ee6c11711f6b163d780d60fa62d5  monaco/vs/wgsl-BhLXMOR0.js
ae38fda42aabe72300ebfc0c6a70c959d0f3874e3e4c5713a459ebfc6ebacf46  monaco/vs/workers-BBttULjf.js
40021db8bec0cb8ca033276387aad9ae396e0f31ba0e2dece05466806e16f448  monaco/vs/xml-cZjNDqDT.js
39ee0c52d201c5bf4705ae2d8dce8f35cf7ff05ee47591f7e0f0499ad70d256a  monaco/vs/yaml-A1fOIdH6.js
ba3ea256ce0620a0992a197d6c9baea64823fc93d8da07a9e366ca9943c18527  xterm/addon-fit.js
854a7c0fb70e8b1a083c16797ab827299fb18744f5ad34f227b48337e33293c6  xterm/xterm.css
14903579ff54664cd72f8e8699e6961a6272c21863ec1c3b118cdc8af5d4a972  xterm/xterm.js
```
