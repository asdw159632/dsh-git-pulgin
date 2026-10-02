/**
 * Mounts the plugin's real route table on a plain node server and drives it
 * over HTTP, so the wire contract (paths, JSON shapes, fences, status codes)
 * is verified without a DSH host.
 *
 *   node test/http-smoke.mjs
 */

import { createServer } from 'node:http'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRoutes, loopbackAuthority, sameOrigin } from '../lib/routes.js'
import { GitError, add, commit, resolveGitPath, runGit } from '../lib/git.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SANDBOX = resolve(HERE, '..', '.test-sandbox')
const REPO = join(SANDBOX, 'http-repo')
const REMOTE = join(SANDBOX, 'http-remote.git')
const exe = resolveGitPath()

let passed = 0
let failed = 0
const failures = []

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  ✗ ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

function checkEqual(label, actual, expected) {
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

async function gitOrThrow(args, cwd) {
  const result = await runGit(exe, args, { cwd })
  if (result.code !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.trim()}`)
  return result
}

/**
 * A pristine repository with one commit, so a rerun can never inherit the
 * previous run's HEAD (which would make "commit a change" a no-op).
 */
async function prepareRepo() {
  rmSync(REPO, { recursive: true, force: true })
  rmSync(REMOTE, { recursive: true, force: true })
  mkdirSync(REPO, { recursive: true })
  await gitOrThrow(['init', '-q', REPO], SANDBOX)
  await gitOrThrow(['config', 'user.name', 'Http Smoke'], REPO)
  await gitOrThrow(['config', 'user.email', 'http@example.invalid'], REPO)
  await gitOrThrow(['config', 'commit.gpgsign', 'false'], REPO)
  writeFileSync(join(REPO, 'readme.md'), '# repo\n', 'utf8')
  await add(exe, REPO, [])
  await commit(exe, REPO, { message: 'initial commit' })
  // The bare "remote" the push/pull section round-trips against.
  await gitOrThrow(['init', '--bare', '-q', REMOTE], SANDBOX)
}

function mount(routes) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const route = routes.find(entry => entry.path === url.pathname)
    if (route === undefined) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'not found' }))
      return
    }
    Promise.resolve(route.handler(request, response)).catch((error) => {
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: String(error) }))
      }
    })
  })
  return new Promise((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise(server)))
}

async function main() {
  console.log(`git: ${exe}`)
  mkdirSync(SANDBOX, { recursive: true })
  await prepareRepo()

  const { routes, resolveDefaultRepo, describe } = createRoutes({
    repo: REPO,
    roots: [SANDBOX],
    logLimit: 20,
  })
  const paths = routes.map(route => route.path)
  checkEqual('路由路径唯一', new Set(paths).size, paths.length)
  check('包含静态页路由', paths.includes('/dsh-git/'))
  checkEqual('默认仓库', resolveDefaultRepo(), REPO)
  check('describe 报告 git 路径', describe().gitPath === exe)

  const server = await mount(routes)
  const base = `http://127.0.0.1:${server.address().port}`
  console.log(`server: ${base}`)

  const get = async (path) => {
    const response = await fetch(`${base}${path}`)
    const body = await response.json()
    return { status: response.status, body }
  }
  const post = async (path, body, headers = {}) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = { raw: text }
    }
    return { status: response.status, body: parsed }
  }

  try {
    // ---------- same-origin fence ----------
    console.log('\n[1] 同源防护')
    check('loopbackAuthority(127.0.0.1:1)', loopbackAuthority('127.0.0.1:19387'))
    check('loopbackAuthority(localhost)', loopbackAuthority('localhost:80'))
    check('loopbackAuthority 拒绝外域', !loopbackAuthority('evil.example:80'))
    check('sameOrigin 无 Origin 时允许', sameOrigin({ headers: { host: '127.0.0.1:1' } }))
    check('sameOrigin 跨站拒绝', !sameOrigin({ headers: { host: '127.0.0.1:1', origin: 'http://evil.example' } }))
    check('sameOrigin 跨站标记拒绝', !sameOrigin({ headers: { host: '127.0.0.1:1', 'sec-fetch-site': 'cross-site' } }))

    const forbidden = await post('/dsh-git/api/add', { paths: [] }, { origin: 'http://evil.example' })
    checkEqual('跨域 POST 返回 403', forbidden.status, 403)

    // ---------- static assets ----------
    console.log('\n[2] 静态页面')
    const page = await fetch(`${base}/dsh-git/`)
    const html = await page.text()
    checkEqual('页面 200', page.status, 200)
    check('页面引用 app.js', html.includes('/dsh-git/app.js'))
    check('页面引用 app.css', html.includes('/dsh-git/app.css'))
    const css = await fetch(`${base}/dsh-git/app.css`)
    checkEqual('css 200', css.status, 200)
    check('css 内容类型', (css.headers.get('content-type') ?? '').includes('text/css'))
    const js = await fetch(`${base}/dsh-git/app.js`)
    checkEqual('js 200', js.status, 200)
    check('js 内容类型', (js.headers.get('content-type') ?? '').includes('javascript'))

    // ---------- read endpoints ----------
    console.log('\n[3] 只读接口')
    const repos = await get('/dsh-git/api/repos')
    checkEqual('repos 200', repos.status, 200)
    check('repos 含目标仓库', repos.body.repos.includes(REPO))

    const info = await get('/dsh-git/api/info')
    checkEqual('info 200', info.status, 200)
    checkEqual('info.repo', info.body.info.repo, REPO)
    check('info 有分支', typeof info.body.info.branch === 'string' && info.body.info.branch !== '')
    checkEqual('info 提交数', info.body.info.commitCount, 1)

    const status = await get('/dsh-git/api/status')
    checkEqual('status 200', status.status, 200)
    checkEqual('status 干净', status.body.status.clean, true)

    const branches = await get('/dsh-git/api/branches')
    check('branches 有当前分支', branches.body.branches.some(branch => branch.current))

    const log = await get('/dsh-git/api/log?limit=5')
    checkEqual('log 条数', log.body.commits.length, 1)
    const sha = log.body.commits[0].sha

    const detail = await get(`/dsh-git/api/commit?sha=${sha}`)
    checkEqual('commit 200', detail.status, 200)
    checkEqual('commit 文件数', detail.body.commit.files.length, 1)

    const commitDiff = await get(`/dsh-git/api/diff?scope=commit&sha=${sha}`)
    check('commit diff 含 readme.md', commitDiff.body.diff.text.includes('readme.md'))
    const stagedDiff = await get('/dsh-git/api/diff?scope=staged')
    checkEqual('空暂存区 diff 为空', stagedDiff.body.diff.empty, true)
    const badSha = await get('/dsh-git/api/commit?sha=%20%3Brm%20-rf')
    checkEqual('非法 sha 被拒', badSha.status, 400)

    // ---------- mutations ----------
    console.log('\n[4] 写操作')
    writeFileSync(join(REPO, 'work.txt'), 'work\n', 'utf8')
    const repoWideDiff = await get('/dsh-git/api/diff?scope=worktree')
    checkEqual('整仓库 diff 不含未跟踪文件（git 语义）', repoWideDiff.body.diff.empty, true)
    const untrackedDiff = await get('/dsh-git/api/diff?scope=worktree&path=work.txt')
    check('未跟踪文件的合成差异含 +work', untrackedDiff.body.diff.text.includes('+work'))
    check('未跟踪差异标记 new file', untrackedDiff.body.diff.text.includes('new file mode'))

    writeFileSync(join(REPO, 'readme.md'), '# repo\nchanged\n', 'utf8')
    const trackedDiff = await get('/dsh-git/api/diff?scope=worktree&path=readme.md')
    check('已跟踪文件的差异含 +changed', trackedDiff.body.diff.text.includes('+changed'))
    await gitOrThrow(['checkout', '-q', '--', 'readme.md'], REPO)

    const stageOne = await post('/dsh-git/api/add', { paths: ['work.txt'] })
    checkEqual('add 200', stageOne.status, 200)
    check('add 后已暂存', stageOne.body.status.entries.some(entry => entry.path === 'work.txt' && entry.staged))

    const unstageOne = await post('/dsh-git/api/unstage', { paths: ['work.txt'] })
    check('unstage 后不再暂存', !unstageOne.body.status.entries.some(entry => entry.path === 'work.txt' && entry.staged))

    const discardOne = await post('/dsh-git/api/discard', { paths: ['work.txt'] })
    checkEqual('discard 200', discardOne.status, 200)
    check('discard 后文件消失', !existsSync(join(REPO, 'work.txt')))

    const emptyCommit = await post('/dsh-git/api/commit', { message: '   ' })
    checkEqual('空提交信息被拒', emptyCommit.status, 400)
    checkEqual('空提交信息错误码', emptyCommit.body.ok, false)

    writeFileSync(join(REPO, 'readme.md'), '# repo\n\nsecond\n', 'utf8')
    await post('/dsh-git/api/add', { paths: [] })
    const committed = await post('/dsh-git/api/commit', { message: 'second commit\n\nwith a body' })
    checkEqual('commit 200', committed.status, 200)
    check('commit 报告 sha', typeof committed.body.result.sha === 'string')
    check('commit 后工作区干净', committed.body.status.clean)
    const afterLog = await get('/dsh-git/api/log?limit=5')
    checkEqual('提交后历史 2 条', afterLog.body.commits.length, 2)

    const amend = await post('/dsh-git/api/commit', { message: 'second commit (amended)', amend: true })
    checkEqual('amend 200', amend.status, 200)
    const amended = await get('/dsh-git/api/log?limit=1')
    checkEqual('amend 改写标题', amended.body.commits[0].subject, 'second commit (amended)')

    const branch = await post('/dsh-git/api/branch', { name: 'http/feature', startPoint: '' })
    checkEqual('新建分支 200', branch.status, 200)
    checkEqual('分支已切换', branch.body.status.branch.head, 'http/feature')
    const checkoutBack = await post('/dsh-git/api/checkout', { ref: 'master' })
    const backOk = checkoutBack.status === 200
    if (!backOk) {
      const fallback = await post('/dsh-git/api/checkout', { ref: 'main' })
      checkEqual('切回默认分支', fallback.status, 200)
    } else {
      check('切回默认分支', true)
    }

    // ---------- remote round trip ----------
    console.log('\n[5] 远程往返（本地裸库）')
    const initBare = await runGit(exe, ['--git-dir', REMOTE, 'rev-parse', '--is-bare-repository'], { cwd: SANDBOX })
    checkEqual('裸库可用', initBare.stdout.trim(), 'true')
    await runGit(exe, ['remote', 'remove', 'origin'], { cwd: REPO })
    await runGit(exe, ['remote', 'add', 'origin', REMOTE], { cwd: REPO })
    const remoteInfo = await get('/dsh-git/api/info')
    checkEqual('info 报告 1 个远程', remoteInfo.body.info.remotes.length, 1)
    const currentBranch = remoteInfo.body.info.branch

    const pushed = await post('/dsh-git/api/push', { remote: 'origin', branch: currentBranch, setUpstream: true })
    checkEqual('push 200', pushed.status, 200)
    check('push 输出含 branch', /main|master|http|feature|->/.test(pushed.body.result.output), pushed.body.result.output)

    const fetched = await post('/dsh-git/api/fetch', { remote: 'origin' })
    checkEqual('fetch 200', fetched.status, 200)

    const pulled = await post('/dsh-git/api/pull', { remote: 'origin', branch: currentBranch, mode: 'merge' })
    checkEqual('pull 200', pulled.status, 200)

    const merged = await post('/dsh-git/api/merge', { ref: 'http/feature', noFf: true, message: 'Merge http/feature' })
    checkEqual('merge 200', merged.status, 200)
    checkEqual('merge 无冲突', merged.body.result.conflict, false)

    const badMerge = await post('/dsh-git/api/merge', { ref: '' })
    checkEqual('空合并目标被拒', badMerge.status, 400)

    // ---------- method and error handling ----------
    console.log('\n[6] 方法与错误处理')
    const wrongMethod = await fetch(`${base}/dsh-git/api/add`)
    checkEqual('GET 写路由返回 405', wrongMethod.status, 405)
    const wrongMethod2 = await fetch(`${base}/dsh-git/api/log`, { method: 'POST', body: '{}' })
    checkEqual('POST 读路由返回 405', wrongMethod2.status, 405)
    const missingRoute = await fetch(`${base}/dsh-git/api/nope`)
    checkEqual('未知路由 404', missingRoute.status, 404)
    const outsideRoots = await get('/dsh-git/api/info?repo=C:\\Windows')
    checkEqual('根目录白名单外被拒', outsideRoots.status, 400)
    const badBody = await fetch(`${base}/dsh-git/api/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    checkEqual('坏 JSON 返回 400', badBody.status, 400)
    check('GitError 可序列化', typeof new GitError('x', { code: 1 }).toJSON().error === 'string')
  } finally {
    server.close()
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  if (failed > 0) {
    console.log('失败项：')
    for (const failure of failures) console.log(`  - ${failure}`)
  }
  return failed === 0 ? 0 : 1
}

main()
  .then((code) => { process.exitCode = code })
  .catch((error) => {
    console.error('\n测试异常：', error)
    process.exitCode = 1
  })
