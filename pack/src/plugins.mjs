// 插件登记表：她默认是"空白的"——只有内核（说话、记忆、过日子）。
// 其余能力都是可选装的一块：QQ 通道、画图、语音、联网、动电脑……
//
// 这一版只做最小可用的东西，不做插件市场：
//   · 插件放在 pack/plugins/<id>/ 下，带一个 plugin.json 说明自己是谁、要什么配置
//   · 装/卸只改 setup.plugins.<id>.enabled，不复制文件、不下载
//   · 卸载 = 关掉，数据留着；想再装回来就再打开
//
// 为什么要这么切：QQ 这条线今天吃掉了一整天（NapCat→SnowLuma、token、扫码、计划任务、
// 僵尸进程）。它再乱，也不该把内核拖下水——内核坏了她就整个不在，QQ 坏了只是"手机上说不了话"。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_DIR = path.join(HERE, '..', 'plugins');

let cache = null;

function readManifest(dir, id) {
  const file = path.join(dir, 'plugin.json');
  let m = {};
  try { m = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  return {
    id: m.id || id,
    name: m.name || id,
    version: m.version || '0.0.0',
    kind: m.kind || 'capability',           // channel | capability | model
    title: m.title || m.name || id,
    desc: m.desc || '',
    needs: Array.isArray(m.needs) ? m.needs : [],   // 依赖的 key：api.key / onebot.token …
    dir,
    file,
  };
}

/** 扫描磁盘上的插件（不读启用状态） */
export function scan() {
  if (cache) return cache;
  const out = [];
  try {
    for (const id of fs.readdirSync(PLUGIN_DIR)) {
      const dir = path.join(PLUGIN_DIR, id);
      try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
      const m = readManifest(dir, id);
      if (m) out.push(m);
    }
  } catch {}
  cache = out;
  return out;
}

/** 启用状态：没写过就是默认（manifest.default === false 才默认关） */
export function isEnabled(setup, id) {
  const st = ((setup && setup.plugins) || {})[id] || {};
  if (typeof st.enabled === 'boolean') return st.enabled;
  const m = scan().find((x) => x.id === id);
  return !(m && m.default === false);
}

export function list(setup) {
  return scan().map((m) => ({ ...m, enabled: isEnabled(setup, m.id) }));
}

export function get(id) {
  return scan().find((m) => m.id === id) || null;
}

/** 缺什么才能跑：返回缺的 key 列表（给界面提示用） */
export function missing(m, setup) {
  const have = (k) => {
    if (k === 'api.key') return !!(setup && setup.api && setup.api.key);
    if (k === 'onebot.token') return !!(setup && setup.onebot && (setup.onebot.accessToken || setup.onebot.httpToken));
    if (k === 'onebot.port') return !!(setup && setup.onebot && (setup.onebot.wsPort || setup.onebot.wsUrl));
    return false;
  };
  return (m.needs || []).filter((k) => !have(k));
}
