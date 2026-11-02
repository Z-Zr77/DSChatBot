// 第一次启动时，数据目录里还没有 persona.md。
// 以前的处理：syncPersona() 读到 ENOENT，打一行「同步失败」就结束——新人第一次打开，
// 她没有任何人设，说话像个默认的客服。仓库里其实带着模板（pack/assets/persona.default.draft.md），
// 这里把它填上名字/年龄/城市/自述写进去，让「第一次用」至少有个能聊的起点。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(HERE, '..', 'assets', 'persona.default.draft.md');

// 模板首行是「你是「{NAME}」，{AGE} 岁，住{CITY}。{PERSONA}」
// 年龄/城市/自述没填时不能留下「 岁，住。」这种残句，所以整句重写。
function firstLine(name, age, city, persona) {
  const who = String(name || '她').trim();
  const bits = [];
  if (String(age || '').trim()) bits.push(String(age).trim() + ' 岁');
  if (String(city || '').trim()) bits.push('住' + String(city).trim());
  const self = String(persona || '').trim();
  let line = `你是「${who}」` + (bits.length ? '，' + bits.join('，') : '') + '。';
  if (self) line += self;
  return line;
}

/**
 * 人设不存在或内容为空时，用模板生成一份。
 * @returns {{ok:boolean, created?:boolean, err?:string}}
 */
export function ensurePersonaFile(dest, opts = {}) {
  try {
    if (fs.existsSync(dest)) {
      const cur = fs.readFileSync(dest, 'utf8');
      if (cur.trim()) return { ok: true, created: false };
    }
    let tpl = fs.readFileSync(TEMPLATE, 'utf8');
    const line = firstLine(opts.name, opts.age, opts.city, opts.persona);
    if (opts.relationship) tpl = replaceRelationship(tpl, opts.relationship);
    tpl = tpl.replace(/^你是「\{NAME\}」.*$/m, line);
    tpl = tpl
      .replace(/\{NAME\}/g, String(opts.name || '她').trim())
      .replace(/\{AGE\}/g, String(opts.age || '').trim())
      .replace(/\{CITY\}/g, String(opts.city || '').trim())
      .replace(/\{PERSONA\}/g, String(opts.persona || '').trim());
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, tpl, 'utf8');
    return { ok: true, created: true };
  } catch (e) {
    return { ok: false, err: (e && e.message) || String(e) };
  }
}

export const PERSONA_TEMPLATE = TEMPLATE;

// 只修改身份行，保留用户写的其他人设内容。
export function cleanRelationship(value) {
  return String(value || '').replace(/[\r\n\u0000-\u001f]/g, ' ').trim().slice(0, 40);
}
export function relationshipOf(text = '') {
  const role = String(text).match(/^关系\/身份[：:]\s*([^\n]+)/m)?.[1]?.trim() || '';
  return role.replace(/^(女友|老婆|朋友)[（(]默认[）)]$/, '$1');
}
function replaceRelationship(text, value) {
  const line = '关系/身份：' + cleanRelationship(value);
  return /^关系\/身份[：:].*$/m.test(text)
    ? text.replace(/^关系\/身份[：:].*$/m, () => line)
    : line + '\n\n' + text;
}
export function setPersonaRelationship(dest, value, opts = {}) {
  const relationship = cleanRelationship(value);
  if (!relationship) return { ok: false, err: '关系/身份不能为空' };
  const result = ensurePersonaFile(dest, { ...opts, relationship });
  if (!result.ok) return result;
  try {
    const current = fs.readFileSync(dest, 'utf8');
    fs.writeFileSync(dest, replaceRelationship(current, relationship), 'utf8');
    return { ok: true, relationship };
  } catch (e) { return { ok: false, err: e.message }; }
}
