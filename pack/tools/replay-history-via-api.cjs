// 把本地真实历史（26 个提交）用 Git Data API 重放到远端，替代"一个累积提交"。
// 历史被压成一个提交时（例如长时间只能走 Git Data API），用这个把真实提交链重放回远端。
// 用法：node pack/tools/replay-history-via-api.cjs [--apply]
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const REPO = process.env.REPO || 'Z-Zr77/DSChatBot';
const APPLY = process.argv.includes('--apply');
const CWD = path.resolve(__dirname, '..', '..');

function git(args) {
  return execFileSync('git', args, {
    cwd: CWD, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_PAGINATION: 'never' },
  });
}
function gitBuf(args) {
  return execFileSync('git', args, { cwd: CWD, maxBuffer: 512 * 1024 * 1024 });
}

// token：从 Windows 凭据管理器取
const cred = execFileSync('git', ['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', cwd: CWD,
});
const TOKEN = (cred.match(/^password=(.*)$/m) || [])[1];
if (!TOKEN) { console.error('拿不到 token'); process.exit(1); }

const API = 'https://api.github.com';
let calls = 0;
async function api(method, url, body) {
  calls++;
  const r = await fetch(API + url, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'dsh-history-replay',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : {};
}

function parseDate(s) {
  // "2026-11-01 00:28:10 +0800" -> "2026-11-01T00:28:10+08:00"
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})$/);
  if (!m) return s;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7].slice(0, 3)}:${m[7].slice(3)}`;
}

function readCommits() {
  const list = git(['rev-list', '--reverse', 'HEAD']).trim().split('\n');
  return list.map(sha => {
    const raw = git(['cat-file', '-p', sha]);
    const head = raw.split('\n\n')[0].split('\n');
    const get = k => (head.find(l => l.startsWith(k + ' ')) || '').slice(k.length + 1);
    const author = get('author').match(/^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/);
    const committer = get('committer').match(/^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/);
    const toIso = m => new Date(Number(m[3]) * 1000).toISOString();
    return {
      sha,
      parents: head.filter(l => l.startsWith('parent ')).map(l => l.slice(7)),
      message: raw.slice(raw.indexOf('\n\n') + 2),
      tree: get('tree'),
      author: { name: author[1], email: author[2], date: toIso(author) },
      committer: { name: committer[1], email: committer[2], date: toIso(committer) },
    };
  });
}

function readTree(treeish) {
  const out = git(['-c', 'core.quotepath=false', 'ls-tree', '-r', '-z', treeish]);
  return out.split('\0').filter(Boolean).map(line => {
    const tab = line.indexOf('\t');
    const meta = line.slice(0, tab).split(' ');
    const [mode, type, sha] = meta;
    return { mode, type, sha, path: line.slice(tab + 1) };
  });
}

(async () => {
  const commits = readCommits();
  console.log(`本地 ${commits.length} 个提交，从 ${commits[0].sha.slice(0, 8)} 到 ${commits.at(-1).sha.slice(0, 8)}`);

  // 先探一遍要上传多少 blob / 文件条目
  const blobSet = new Set();
  let entries = 0;
  for (const c of commits) {
    for (const e of readTree(c.sha)) { blobSet.add(e.sha); entries++; }
  }
  console.log(`唯一 blob ${blobSet.size} 个，文件条目共 ${entries} 个`);

  if (!APPLY) {
    console.log('（演练模式，加 --apply 才真写）');
    console.log(commits.map(c => `${c.sha.slice(0, 8)} ${c.author.date.slice(0, 16)} ${c.message.split('\n')[0]}`).join('\n'));
    return;
  }

  // 1) 上传 blob（按 sha 缓存）
  const blobApi = new Map();
  const shaList = [...blobSet];
  let done = 0;
  for (const sha of shaList) {
    const buf = gitBuf(['cat-file', 'blob', sha]);
    const r = await api('POST', `/repos/${REPO}/git/blobs`, {
      content: buf.toString('base64'), encoding: 'base64',
    });
    blobApi.set(sha, r.sha);
    if (++done % 50 === 0) console.log(`  blob ${done}/${shaList.length}`);
  }

  // 2) 逐提交建 tree + commit
  const commitApi = new Map();
  for (const c of commits) {
    const treeEntries = readTree(c.sha).map(e => ({
      path: e.path,
      mode: e.mode,
      type: 'blob',
      sha: blobApi.get(e.sha),
    }));
    const tree = await api('POST', `/repos/${REPO}/git/trees`, { tree: treeEntries });
    const parents = c.parents.map(p => commitApi.get(p)).filter(Boolean);
    const cm = await api('POST', `/repos/${REPO}/git/commits`, {
      message: c.message,
      tree: tree.sha,
      parents,
      author: c.author,
      committer: c.committer,
    });
    commitApi.set(c.sha, cm.sha);
    console.log(`  ✓ ${c.sha.slice(0, 8)} -> ${cm.sha.slice(0, 8)} ${c.message.split('\n')[0].slice(0, 60)}`);
  }

  // 3) 把 main 指到最后一个，并挪 tag
  const last = commitApi.get(commits.at(-1).sha);
  await api('PATCH', `/repos/${REPO}/git/refs/heads/main`, { sha: last, force: true });
  try {
    await api('PATCH', `/repos/${REPO}/git/refs/tags/v0.7.0`, { sha: last, force: true });
  } catch (e) { console.log('  tag 更新失败：' + e.message); }

  // 4) 校验：远端 HEAD 的 tree 必须等于本地 HEAD 的 tree
  const remote = await api('GET', `/repos/${REPO}/git/commits/${last}`);
  const localTree = git(['rev-parse', 'HEAD^{tree}']).trim();
  console.log(`远端 tree ${remote.tree.sha}`);
  console.log(`本地 tree ${localTree}`);
  console.log(remote.tree.sha === localTree ? '✅ 内容完全一致' : '❌ tree 不一致');
  console.log(`API 调用 ${calls} 次，main = ${last}`);
})().catch(e => { console.error('失败：' + e.message); process.exit(1); });
