// git push 走不通（github.com:443 被挡，api.github.com 可用）时，用 Git Data API 把本地提交搬上去
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = 'Z-Zr77/DSChatBot';
const ROOT = 'E:/DeepSeek_AI/qq-bot';
const BASE = process.argv[2] || 'v0.6.4';
const TAG = process.argv[3] || 'v0.6.5';

const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
function token() {
  const out = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' });
  const m = /^password=(.*)$/m.exec(out);
  if (!m) throw new Error('no github credential');
  return m[1].trim();
}

(async () => {
  const tok = token();
  const H = {
    authorization: 'Bearer ' + tok, accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28', 'user-agent': 'dsh-push', 'content-type': 'application/json',
  };
  const api = async (p, init) => {
    const r = await fetch('https://api.github.com' + p, { headers: H, ...init });
    const t = await r.text();
    let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
    if (!r.ok) throw new Error(p + ' ' + r.status + ' ' + JSON.stringify(j).slice(0, 300));
    return j;
  };

  // 远端 main 的当前提交（用 ref API，commits/main 会 404）
  const ref = await api(`/repos/${REPO}/git/ref/heads/main`);
  const remoteSha = ref.object.sha;
  const remote = await api(`/repos/${REPO}/git/commits/${remoteSha}`);
  console.log('remote main', remoteSha.slice(0, 8));
  const baseSha = remoteSha;
  const headSha = git('rev-parse', 'HEAD');
  console.log('local head', headSha.slice(0, 8));

  const msg = git('log', '-1', '--pretty=%B', headSha).trim();

  // 本次要改动的文件
  let rows;
  try {
    const out = git('diff', '--name-status', baseSha, headSha);
    rows = out.split('\n').filter(Boolean).map((l) => l.split('\t'));
  } catch (e) {
    // 远端 commit 是 API 建的，本地没有这个对象 → 退化成「全量同步 tracked 文件」
    console.log('base 不在本地，改为全量同步 tracked 文件');
    rows = git('ls-files').split('\n').filter(Boolean).map((f) => ['M', f]);
  }
  const tree = [];
  for (const row of rows) {
    const st = row[0];
    const p = row[row.length - 1]; // rename 时最后一个是新路径
    if (st === 'D') { tree.push({ path: p, mode: '100644', type: 'blob', sha: null }); continue; }
    const abs = path.join(ROOT, p);
    if (!fs.existsSync(abs)) { console.log('skip missing', p); continue; }
    const buf = fs.readFileSync(abs);
    const mode = (fs.statSync(abs).mode & 0o111) ? '100755' : '100644';
    const blob = await api(`/repos/${REPO}/git/blobs`, {
      method: 'POST', body: JSON.stringify({ content: buf.toString('base64'), encoding: 'base64' }),
    });
    tree.push({ path: p.split(path.sep).join('/'), mode, type: 'blob', sha: blob.sha });
  }
  console.log('files', tree.length);

  const newTree = await api(`/repos/${REPO}/git/trees`, {
    method: 'POST', body: JSON.stringify({ base_tree: remote.tree.sha, tree }),
  });
  const commit = await api(`/repos/${REPO}/git/commits`, {
    method: 'POST', body: JSON.stringify({ message: msg, tree: newTree.sha, parents: [remote.sha] }),
  });
  console.log('commit', commit.sha.slice(0, 8));

  await api(`/repos/${REPO}/git/refs/heads/main`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) });
  console.log('ref main ->', commit.sha.slice(0, 8));

  const tagObj = await api(`/repos/${REPO}/git/tags`, {
    method: 'POST', body: JSON.stringify({ tag: TAG, message: TAG, object: commit.sha, type: 'commit' }),
  });
  await api(`/repos/${REPO}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: 'refs/tags/' + TAG, sha: tagObj.sha }) });
  console.log('tag', TAG, '->', commit.sha.slice(0, 8), 'OK');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
