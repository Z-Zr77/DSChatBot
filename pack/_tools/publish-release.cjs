// 用 GCM 里已存的 GitHub 凭据发 release（api.github.com 可达，github.com 可能被墙）
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = 'Z-Zr77/DSChatBot';
const TAG = process.argv[2] || 'v0.6.5';
const BODY_FILE = process.argv[3] || 'E:/DSChatBot-发布包/03-发布说明/v0.6.5.md';
const ASSET = process.argv[4] || 'E:/DeepSeek_AI/qq-bot/pack/dist/DSChatBot-Setup-0.6.5.exe';

function token() {
  const out = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' });
  const m = /^password=(.*)$/m.exec(out);
  if (!m) throw new Error('no password from credential fill');
  return m[1].trim();
}

(async () => {
  const tok = token();
  const body = fs.readFileSync(BODY_FILE, 'utf8');
  const H = {
    authorization: 'Bearer ' + tok,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'dsh-release-script',
    'content-type': 'application/json',
  };
  let rel = null;
  const r0 = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`, { headers: H });
  if (r0.status === 200) {
    rel = await r0.json();
    const p = await fetch(`https://api.github.com/repos/${REPO}/releases/${rel.id}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ name: TAG, body, draft: false, prerelease: false }),
    });
    rel = await p.json();
    console.log('updated existing release', rel.id);
  } else {
    const c = await fetch(`https://api.github.com/repos/${REPO}/releases`, {
      method: 'POST', headers: H, body: JSON.stringify({ tag_name: TAG, name: TAG, body, draft: false, prerelease: false }),
    });
    rel = await c.json();
    if (!rel.id) throw new Error('create failed: ' + JSON.stringify(rel).slice(0, 300));
    console.log('created release', rel.id);
  }
  const want = path.basename(ASSET);
  if ((rel.assets || []).some((a) => a.name === want)) { console.log('asset exists', want); return; }
  const size = fs.statSync(ASSET).size;
  const up = await fetch(`https://uploads.github.com/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(want)}`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + tok,
      accept: 'application/vnd.github+json',
      'content-type': 'application/octet-stream',
      'content-length': String(size),
      'user-agent': 'dsh-release-script',
    },
    body: fs.createReadStream(ASSET),
    duplex: 'half',
  });
  const j = await up.json();
  console.log('upload', up.status, j.name, j.size, j.state || j.message || '');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
