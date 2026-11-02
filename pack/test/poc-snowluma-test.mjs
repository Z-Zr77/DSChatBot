// SnowLuma 通道：路径探测 + setup 读写不丢另一边
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbt-snow-'));
const DATA = path.join(TMP, 'data');
fs.mkdirSync(DATA, { recursive: true });
process.env.QQBOT_DATA = DATA;

const paths = await import(pathToFileURL(path.join(SRC, 'paths.mjs')).href);

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : ' ' + extra));
  ok ? pass++ : fail++;
};

check('DEFAULT 含 snowluma.dir', (() => {
  const s = paths.loadSetup();
  return s.snowluma && s.snowluma.dir === '' && s.napcat && s.napcat.dir === '';
})());

paths.saveSetup({ snowluma: { dir: 'D:/Snow' }, qq: { protocol: 'snowluma' } });
paths.saveSetup({ napcat: { dir: 'D:/Nap' }, qq: { protocol: 'napcat' } });
{
  const s = paths.loadSetup();
  check('切协议不丢另一边路径',
    s.qq.protocol === 'napcat' && s.napcat.dir === 'D:/Nap' && s.snowluma.dir === 'D:/Snow',
    JSON.stringify(s));
}

const empty = path.join(TMP, 'empty');
fs.mkdirSync(empty);
check('假目录 looksLikeNapCat=false', paths.looksLikeNapCat(empty) === false);
check('假目录 looksLikeSnowLuma=false', paths.looksLikeSnowLuma(empty) === false);
check('空路径 hasLauncher=false', paths.hasLauncher('') === false);

const nc = path.join(TMP, 'napcat-like');
fs.mkdirSync(nc);
fs.writeFileSync(path.join(nc, 'launcher.bat'), '@echo off\n');
check('有 launcher.bat 像 NapCat', paths.looksLikeNapCat(nc) === true);

const sl = path.join(TMP, 'snow-like');
fs.mkdirSync(sl);
fs.writeFileSync(path.join(sl, 'launcher.sh'), '#!/bin/sh\n');
fs.writeFileSync(path.join(sl, 'index.mjs'), 'export {}\n');
check('有 launcher.sh 像 SnowLuma', paths.looksLikeSnowLuma(sl) === true);
check('launcherNameIn 挑得到', !!paths.launcherNameIn(sl));

check('qqProtocolOf snowluma', paths.qqProtocolOf({ qq: { protocol: 'snowluma' } }) === 'snowluma');
check('qqClientDirOf 按协议', paths.qqClientDirOf({ qq: { protocol: 'snowluma' }, snowluma: { dir: sl } }) === sl);

const ui = fs.readFileSync(path.join(SRC, 'ui.mjs'), 'utf8');
check('扫码分流含 snowluma 模式', /mode: 'snowluma'/.test(ui) && /127\.0\.0\.1:5099/.test(ui));
check('前端已收掉未接上提示', !ui.includes('还没接上') && !ui.includes('TODO(backend)'));
check('托盘/按钮用 QQ 接入向导', ui.includes('QQ 接入向导'));

const main = fs.readFileSync(path.join(HERE, '..', 'electron', 'main.cjs'), 'utf8');
check('electron 按协议选目录', /function qqClientDir\(/.test(main) && main.includes('QQ 接入向导'));

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`\nPASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
