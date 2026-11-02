import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ensurePersonaFile, setPersonaRelationship, relationshipOf } from '../src/persona-default.mjs';
const require = createRequire(new URL('../package.json', import.meta.url));
const { FileMatcher } = require('app-builder-lib/out/fileMatcher.js');
const root = path.resolve('pack');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blank-version-'));
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('PASS', name); pass++; } catch (e) { console.log('FAIL', name, e.message); fail++; } }
try {
  t('女友/老婆/朋友/自定义身份真实写入人设；只改身份行', () => {
    for (const role of ['女友', '老婆', '朋友', '一起写作的搭档$&']) {
      const file = path.join(tmp, role + '.md');
      assert.ok(ensurePersonaFile(file, { name: '小夏', relationship: role }).ok);
      assert.equal(relationshipOf(fs.readFileSync(file, 'utf8')), role);
      fs.appendFileSync(file, '\n我自己写的设定');
      assert.ok(setPersonaRelationship(file, '朋友').ok);
      const txt = fs.readFileSync(file, 'utf8');
      assert.equal(relationshipOf(txt), '朋友');
      assert.ok(txt.includes('我自己写的设定'));
      assert.equal((txt.match(/^关系\/身份：/gm) || []).length, 1);
    }
    assert.equal(relationshipOf('关系/身份：女友（默认）'), '女友');
    const file = path.join(tmp, 'existing.md');
    fs.writeFileSync(file, '自写人设');
    assert.ok(setPersonaRelationship(file, '搭档\n新行').ok);
    assert.equal(relationshipOf(fs.readFileSync(file, 'utf8')), '搭档 新行');
    assert.equal(setPersonaRelationship(file, '').ok, false);
  });
  t('默认外貌为空；三条出图路径不再预设特殊器官', () => {
    for (const name of ['self.mjs', 'bridge.mjs', 'ui.mjs']) {
      const text = fs.readFileSync(path.join(root, 'src', name), 'utf8');
      assert.ok(!text.includes('耳鳍'), name);
    }
    const self = fs.readFileSync(path.join(root, 'src/self.mjs'), 'utf8');
    assert.match(self, /export function desc\(\)[\s\S]*?catch \{ return ''; \}/);
  });
  t('关系只在人设正文里改，第一次见面和 QQ 向导不再问身份', () => {
    const wizard = fs.readFileSync(path.join(root, 'src/wizard.html'), 'utf8');
    const ui = fs.readFileSync(path.join(root, 'src/ui.mjs'), 'utf8');
    const launch = fs.readFileSync(path.join(root, 'launch.mjs'), 'utf8');
    const bridge = fs.readFileSync(path.join(root, 'src/bridge.mjs'), 'utf8');
    assert.ok(!wizard.includes('关系/身份') && !wizard.includes('id="relationship"') && !wizard.includes('自定义身份') && !wizard.includes('relationship'));
    const cardStart = ui.indexOf('async function maybeWizard');
    const cardEnd = ui.indexOf('async function wzSave', cardStart);
    const card = ui.slice(cardStart, cardEnd);
    assert.ok(card.includes('第一次见面') && card.includes('id="wzName"'));
    assert.ok(!card.includes('关系/身份') && !card.includes('wzRelationship') && !card.includes('自定义身份'));
    const save = ui.slice(cardEnd, ui.indexOf('loadState(); loadRecent();', cardEnd));
    assert.ok(!save.includes('relationship'));
    const setup = ui.slice(ui.indexOf("if (p === '/api/setup')"), ui.indexOf("if (p === '/api/open-wizard'"));
    assert.ok(setup.includes('/api/setup') && !setup.includes('relationship') && !setup.includes('女友'));
    const personaGet = ui.slice(ui.indexOf("if (p === '/api/persona')"), ui.indexOf("if (p === '/api/consolidate')"));
    assert.ok(personaGet.includes('ensurePersonaFile') && !personaGet.includes('relationship'));
    assert.ok(ui.includes('关系/身份：朋友'));
    assert.ok(!ui.includes('setPersonaRelationship'));
    assert.ok(wizard.includes("post('/api/save'"));
    assert.ok(!launch.includes('setPersonaRelationship'));
    const seed = launch.slice(launch.indexOf('function seedDefaults'), launch.indexOf('function portOpen'));
    assert.ok(seed.includes('ensurePersonaFile') && !seed.includes('relationship'));
    const wizSave = launch.slice(launch.indexOf("u.pathname === '/api/save'"), launch.indexOf("u.pathname === '/api/finish'"));
    assert.ok(wizSave.includes('delete qqPatch.relationship') && !wizSave.includes('setPersonaRelationship'));
    const boot = bridge.slice(bridge.indexOf('ensurePersonaFile(cfg.personaSrc'), bridge.indexOf('if (pr.created)'));
    assert.ok(boot.includes('name: SETUP.qq.name') && !boot.includes('relationship'));
  });
  t('electron-builder 实际过滤器排除嵌套私有文件，保留代码与默认人设', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const filter = new FileMatcher(root, path.join(tmp, 'out'), x => x, pkg.build.files).createFilter();
    const stat = { isDirectory: () => false };
    for (const file of ['src/ui.mjs', 'electron/main.cjs', 'assets/persona.default.draft.md', 'launch.mjs', 'package.json']) assert.ok(filter(path.join(root, file), stat), file);
    for (const file of ['data/persona.md', 'src/data/config.json', 'assets/private/photo.png', 'src/private-data/a.json', 'assets/userdata/a.json', 'src/agent-home/AGENTS.md', 'assets/memory/a.json', 'src/logs/a.txt', 'assets/log/session.txt', 'src/backups/a.zip', 'assets/keys/key.txt', 'src/secrets/token.txt', 'src/.env', 'assets/.env.local', 'src/debug.log', 'assets/debug.log.1', 'src/events.jsonl', 'assets/.ssh/key', 'src/key.jks', 'assets/secret.key', 'src/secret.pem', 'assets/secret.pfx', 'src/id_rsa', 'src/id_ed25519.pub', 'src/api.json', 'src/setup.json', 'assets/config.json', 'src/data-location.txt']) assert.equal(filter(path.join(root, file), stat), false, file);
  });
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
console.log(`PASS ${pass} / FAIL ${fail}`);
process.exitCode = fail ? 1 : 0;
