#!/usr/bin/env node
/**
 * Собирает страницу-инструкцию Claude Agent Kit и кладёт ярлык на рабочий стол.
 *
 *   node make-guide.mjs [--desktop "<путь к Рабочему столу>"] [--open]
 *
 * Что делает:
 *   1. Читает шаблон .claude/assets/guide.template.html, вшивает логотип и favicon
 *      (base64) и версию — получается САМОДОСТАТОЧНЫЙ guide.html (открывается откуда угодно).
 *      Файл пишется рядом с набором: <agent-kit>/guide.html.
 *   2. Кладёт на рабочий стол фирменный ярлык, открывающий guide.html в браузере по умолчанию:
 *        Windows — .url с нашей иконкой (.ico), macOS — .webloc, Linux — .desktop.
 *   3. С флагом --open — открывает guide.html в браузере по умолчанию.
 *
 * Путь к рабочему столу: берётся из --desktop (его надёжно вычисляет установщик через .NET,
 * с учётом OneDrive), иначе автоопределяется. Не нашли — просто пропускаем ярлык.
 * Скрипт никогда не роняет установку: любая ошибка → сообщение и выход с нулём.
 */

import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(KIT, 'assets');

const args = process.argv.slice(2);
const desktopArg = (() => { const i = args.indexOf('--desktop'); return i >= 0 ? args[i + 1] : ''; })();
const doOpen = args.includes('--open');

function readB64(file) {
  try { return readFileSync(file).toString('base64'); } catch { return ''; }
}
function dataUri(file, mime) {
  const b = readB64(file);
  return b ? `data:${mime};base64,${b}` : '';
}

// --- 1. собрать guide.html --------------------------------------------------
const tpl = tryRead(path.join(ASSETS, 'guide.template.html'));
if (!tpl) { console.log('  ! guide.template.html не найден — инструкцию не собрать'); process.exit(0); }

const version = (tryRead(path.join(KIT, 'VERSION')) || '').trim() || '?';
// В шаблоне картинки заданы относительными путями (чтобы сам шаблон открывался как страница).
// Для готового guide.html вшиваем их base64 — файл становится самодостаточным.
// Путь к профилю ЭТОЙ установки: в инструкции на него стоит рабочая ссылка, чтобы человек
// не искал файл руками. vscode:// открывает его сразу на правку, file:// — просто показывает
// (браузер markdown не редактирует), поэтому в странице даны обе плюс путь текстом для копирования.
const profilePath = path.join(KIT, 'PROJECT_PROFILE.md');
const profilePosix = profilePath.split('\\').join('/');
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const html = tpl
  .replaceAll('src="header.png"', `src="${dataUri(path.join(ASSETS, 'header.png'), 'image/png')}"`)
  .replaceAll('href="favicon.ico"', `href="${dataUri(path.join(ASSETS, 'favicon.ico'), 'image/x-icon')}"`)
  .replaceAll('{{VERSION}}', version)
  .replaceAll('{{PROFILE_PATH}}', escHtml(profilePath))
  .replaceAll('{{PROFILE_VSCODE}}', 'vscode://file/' + encodeURI(profilePosix))
  .replaceAll('{{PROFILE_FILE}}', 'file:///' + encodeURI(profilePosix.replace(/^\//, '')));

const guidePath = path.join(KIT, 'guide.html');
try {
  writeFileSync(guidePath, html, 'utf8');
} catch (e) {
  console.log('  ! не удалось записать guide.html: ' + e.message);
  process.exit(0);
}

// --- 2. ярлык на рабочий стол ----------------------------------------------
const desktop = firstExisting([
  desktopArg,
  path.join(os.homedir(), 'Desktop'),
  path.join(os.homedir(), 'OneDrive', 'Desktop'),
  path.join(os.homedir(), 'Рабочий стол'),
]);

if (desktop) {
  try { makeShortcut(desktop, guidePath); }
  catch (e) { console.log('  ! ярлык не создан: ' + e.message); }
} else {
  console.log('  ! рабочий стол не найден — ярлык пропущен (инструкция открывается вручную)');
}

// --- 3. открыть -------------------------------------------------------------
if (doOpen) openInBrowser(guidePath);

process.exit(0);

// ---------------------------------------------------------------------------
function makeShortcut(desktopDir, guide) {
  const ico = path.join(ASSETS, 'icon.ico');
  const pngIcon = path.join(ASSETS, 'wordmark.png');
  const fileUrl = 'file:///' + guide.replace(/\\/g, '/').replace(/^\//, '');

  if (process.platform === 'win32') {
    const link = path.join(desktopDir, 'Claude Agent Kit.url');
    const body =
      '[InternetShortcut]\r\n' +
      `URL=${fileUrl}\r\n` +
      (existsSync(ico) ? `IconFile=${ico}\r\nIconIndex=0\r\n` : '');
    writeFileSync(link, body, 'utf8');  } else if (process.platform === 'darwin') {
    const link = path.join(desktopDir, 'Claude Agent Kit.webloc');
    const body =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
      `<plist version="1.0"><dict><key>URL</key><string>${fileUrl}</string></dict></plist>\n`;
    writeFileSync(link, body, 'utf8');  } else {
    const link = path.join(desktopDir, 'claude-agent-kit.desktop');
    const body =
      '[Desktop Entry]\n' +
      'Type=Application\n' +
      'Name=Claude Agent Kit\n' +
      `Exec=xdg-open "${guide}"\n` +
      (existsSync(pngIcon) ? `Icon=${pngIcon}\n` : '') +
      'Terminal=false\n';
    writeFileSync(link, body, 'utf8');
    try { chmodSync(link, 0o755); } catch { /* не критично */ }  }
}

function openInBrowser(guide) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', guide], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [guide], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [guide], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* не критично */ }
}

function firstExisting(list) {
  for (const p of list) { if (p && existsSync(p)) return p; }
  return '';
}
function tryRead(p) { try { return readFileSync(p, 'utf8'); } catch { return ''; } }
