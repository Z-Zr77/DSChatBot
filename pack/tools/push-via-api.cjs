// 当 `git push` 走不通（本机 github.com:443 被挡、api.github.com 可用）时，
// 用 Git Data API 把工作树同步到远端分支：只上传内容真正变了的文件。
//
//   node pack/tools/push-via-api.cjs              # 预演：只说会改什么
//   node pack/tools/push-via-api.cjs --apply      # 真推
//   node pack/tools/push-via-api.cjs --apply --tag v0.7.0
//
// 说明：
// - 走 Git Data API 只能逐 blob/tree/commit 操作，所以推上去的是「一个累积提交」，
//   本地的历史提交不会出现在远端。网络恢复后可以 git push --force 把历史对齐。
// - 内容取自 git 对象（git cat-file blob），不是工作区文件，避免换行符被二次转换。
const { execFileSync } = require('child_process');
const path = require('path');

const REPO = 'Z-Zr77/DSChatBot';
const ROOT = path.resolve(__dirname, '..', '..');
const apply = process.argv.includes('--apply');
const tagIdx = process.argv.indexOf('--tag');
const TAG = tagIdx > 0 ? process.argv[tagIdx + 1] : '';
const BRANCH = 'main';

const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
const gitBuf = (...a) => execFileSync('git', a, { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 });

function token() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', cwd: ROOT,
  });
  const m = /^password=(.*)$/m.exec(out);
  if (!m) throw new Error('拿不到 GitHub 凭据（git credential fill 没有 password）');
  return m[1].trim();
}

(async () => {
  const H = {
    authorization: 'Bearer ' + token(), accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28', 'user-agent': 'dschatbot-push', 'content-type': 'application/json',
  };
  const api = async (p, init) => {
    const r = await fetch('https://api.github.com' + p, { headers: H, ...init });
    const t = await r.text();
    let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
    if (!r.ok) throw new Error(`${p} → ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
    return j;
  };

  // 本地 tracked 文件 → { path: {mode, sha} }
  const local = new Map();
  for (const rec of git('-c', 'core.quotepath=false', 'ls-files', '-s', '-z').split('\0')) {
    if (!rec) continue;
    const [meta, p] = rec.split('\t');
    const [mode, sha] = meta.split(' ');
    local.set(p, { mode, sha });
  }

  const ref = await api(`/repos/${REPO}/git/ref/heads/${BRANCH}`).catch(() => null);
  const remoteSha = ref ? ref.object.sha : '';
  let remoteTreeSha = '';
  const remote = new Map();
  if (remoteSha) {
    const c = await api(`/repos/${REPO}/git/commits/${remoteSha}`);
    remoteTreeSha = c.tree.sha;
    const t = await api(`/repos/${REPO}/git/trees/${remoteTreeSha}?recursive=1`);
    for (const e of t.tree) if (e.type === 'blob') remote.set(e.path, { mode: e.mode, sha: e.sha });
  }

  const changed = [], removed = [];
  for (const [p, v] of local) {
    const r = remote.get(p);
    if (!r) changed.push([p, v, 'add']);
    else if (r.sha !== v.sha) changed.push([p, v, 'mod']);
  }
  for (const p of remote.keys()) if (!local.has(p)) removed.push(p);

  console.log(`远端 ${BRANCH} = ${remoteSha ? remoteSha.slice(0, 8) : '(空)'}，本地 tracked ${local.size} 个文件`);
  console.log(`新增 ${changed.filter(c => c[2] === 'add').length} / 修改 ${changed.filter(c => c[2] === 'mod').length} / 删除 ${removed.length}`);
  for (const [p, , k] of changed) console.log('  ' + k + ' ' + p);
  for (const p of removed) console.log('  del ' + p);
  if (!changed.length && !removed.length) { console.log('没有差异，收工'); return; }
  if (!apply) { console.log('\n预演结束。加 --apply 真推。'); return; }

  const tree = [];
  for (const [p, v] of changed) {
    const buf = gitBuf('cat-file', 'blob', v.sha);
    const blob = await api(`/repos/${REPO}/git/blobs`, {
      method: 'POST', body: JSON.stringify({ content: buf.toString('base64'), encoding: 'base64' }),
    });
    if (blob.sha !== v.sha) console.warn(`  ! blob sha 不一致 ${p} 本地 ${v.sha.slice(0, 8)} 远端 ${blob.sha.slice(0, 8)}`);
    tree.push({ path: p, mode: v.mode, type: 'blob', sha: blob.sha });
  }
  for (const p of removed) tree.push({ path: p, mode: '100644', type: 'blob', sha: null });

  const newTree = await api(`/repos/${REPO}/git/trees`, {
    method: 'POST', body: JSON.stringify({ base_tree: remoteTreeSha || undefined, tree }),
  });
  const msg = git('log', '-1', '--pretty=%s') + '\n\n(通过 Git Data API 同步；本机 github.com:443 不通)';
  const commit = await api(`/repos/${REPO}/git/commits`, {
    method: 'POST', body: JSON.stringify({ message: msg, tree: newTree.sha, parents: remoteSha ? [remoteSha] : [] }),
  });
  await api(`/repos/${REPO}/git/refs/heads/${BRANCH}`, {
    method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: true }),
  });
  console.log(`${BRANCH} -> ${commit.sha.slice(0, 8)}`);

  if (TAG) {
    const existing = await api(`/repos/${REPO}/git/ref/tags/${TAG}`).catch(() => null);
    if (existing) {
      await api(`/repos/${REPO}/git/refs/tags/${TAG}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: true }) });
    } else {
      await api(`/repos/${REPO}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: 'refs/tags/' + TAG, sha: commit.sha }) });
    }
    console.log('tag', TAG, '->', commit.sha.slice(0, 8));
  }

  const verify = await api(`/repos/${REPO}/contents/pack/package.json?ref=${commit.sha}`);
  const pkg = JSON.parse(Buffer.from(verify.content, 'base64').toString('utf8'));
  console.log('校验：远端 pack/package.json 版本 =', pkg.version);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
