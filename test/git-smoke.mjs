/**
 * End-to-end exercise of lib/git.js against real repositories, including a
 * bare "remote" on disk so push / fetch / pull / merge are the real thing.
 *
 *   node test/git-smoke.mjs
 */

import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  commit,
  commitDetail,
  add,
  createBranch,
  checkout,
  diff,
  discard,
  fetchRemote,
  findRepos,
  info,
  listBranches,
  listRemotes,
  log,
  looksLikeRepo,
  merge,
  pull,
  push,
  repoRoot,
  resolveGitPath,
  status,
  unstage,
} from '../lib/git.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SANDBOX = resolve(HERE, '..', '.test-sandbox')
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

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

async function main() {
  console.log(`git: ${exe}`)
  rmSync(SANDBOX, { recursive: true, force: true })
  mkdirSync(SANDBOX, { recursive: true })

  const remote = join(SANDBOX, 'remote.git')
  const repo = join(SANDBOX, 'repo')
  const clone = join(SANDBOX, 'clone')

  // ---------- 1. a repository with history ----------
  console.log('\n[1] 基础仓库')
  await run(['init', '--bare', '-q', remote])
  await run(['init', '-q', repo])
  await ident(repo)

  check('looksLikeRepo', looksLikeRepo(repo))
  check('looksLikeRepo(远程裸库)==false', !looksLikeRepo(remote))
  checkEqual('repoRoot', await repoRoot(exe, repo), repo)

  write(join(repo, 'a.txt'), 'one\n')
  write(join(repo, 'docs', 'b.md'), '# b\n')
  let statusResult = await status(exe, repo)
  checkEqual('未跟踪文件数', statusResult.entries.filter(e => e.kind === 'untracked').length, 2)

  await add(exe, repo, [])
  statusResult = await status(exe, repo)
  checkEqual('全部暂存后已暂存数', statusResult.entries.filter(e => e.staged).length, 2)

  await commit(exe, repo, { message: 'initial: add a.txt and docs/b.md\n\nbody line' })
  statusResult = await status(exe, repo)
  check('提交后工作区干净', statusResult.clean)
  checkEqual('提交后未跟踪数', statusResult.entries.length, 0)

  const infoResult = await info(exe, repo)
  const branchName = infoResult.branch
  check('分支名非空', typeof branchName === 'string' && branchName !== '')
  checkEqual('提交计数', infoResult.commitCount, 1)
  checkEqual('身份 name', infoResult.user.name, 'Smoke Test')

  // ---------- 2. worktree changes, diff, unstage, discard ----------
  console.log('\n[2] 工作区改动 / 差异 / 取消暂存 / 丢弃')
  write(join(repo, 'a.txt'), 'one\ntwo\n')
  write(join(repo, 'c.txt'), 'new\n')
  statusResult = await status(exe, repo)
  const modified = statusResult.entries.find(e => e.path === 'a.txt')
  checkEqual('a.txt 未暂存', modified?.worktree, 'M')
  checkEqual('c.txt 未跟踪', statusResult.entries.find(e => e.path === 'c.txt')?.kind, 'untracked')

  const worktreeDiff = await diff(exe, repo, { scope: 'worktree', path: 'a.txt' })
  check('worktree diff 含 +two', worktreeDiff.text.includes('+two'))

  await add(exe, repo, ['a.txt'])
  checkEqual('暂存后 a.txt staged', (await status(exe, repo)).entries.find(e => e.path === 'a.txt')?.index, 'M')
  const stagedDiff = await diff(exe, repo, { scope: 'staged', path: 'a.txt' })
  check('staged diff 含 +two', stagedDiff.text.includes('+two'))

  await unstage(exe, repo, ['a.txt'])
  checkEqual('取消暂存后 a.txt 不再 staged', (await status(exe, repo)).entries.find(e => e.path === 'a.txt')?.staged, false)

  await discard(exe, repo, ['a.txt'])
  // Windows checkouts may apply CRLF; the point is that the edit is gone.
  checkEqual('丢弃后 a.txt 内容回到 HEAD', readFileSync(join(repo, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'one\n')
  await discard(exe, repo, ['c.txt'])
  check('丢弃未跟踪文件后 c.txt 消失', !existsSync(join(repo, 'c.txt')))

  // ---------- 3. log / commit detail ----------
  console.log('\n[3] 历史与提交详情')
  write(join(repo, 'a.txt'), 'one\ntwo\nthree\n')
  await add(exe, repo, [])
  await commit(exe, repo, { message: 'second commit' })
  const history = await log(exe, repo, { limit: 10 })
  checkEqual('历史条数', history.commits.length, 2)
  checkEqual('最新提交信息', history.commits[0].subject, 'second commit')
  checkEqual('父提交数', history.commits[0].parents.length, 1)
  check('refs 含当前分支', history.commits[0].refs.some(ref => ref.name === branchName))

  const detail = await commitDetail(exe, repo, history.commits[0].sha)
  checkEqual('详情变更文件数', detail.files.length, 1)
  checkEqual('详情文件状态', detail.files[0].status, 'modified')
  check('详情 stat 文本非空', detail.statText.length > 0)
  const rootDetail = await commitDetail(exe, repo, history.commits[1].sha)
  checkEqual('根提交变更文件数', rootDetail.files.length, 2)

  const commitDiff = await diff(exe, repo, { scope: 'commit', sha: history.commits[0].sha })
  check('提交差异含 +three', commitDiff.text.includes('+three'))
  const rootDiff = await diff(exe, repo, { scope: 'commit', sha: history.commits[1].sha })
  check('根提交差异含 a.txt', rootDiff.text.includes('a.txt'))

  const search = await log(exe, repo, { limit: 10, search: 'second' })
  checkEqual('搜索命中 1 条', search.commits.length, 1)

  // ---------- 4. branches and merge ----------
  console.log('\n[4] 分支与合并')
  await createBranch(exe, repo, 'feature/smoke')
  write(join(repo, 'feature.txt'), 'feature\n')
  await add(exe, repo, [])
  await commit(exe, repo, { message: 'feature work' })
  await checkout(exe, repo, branchName)
  const merged = await merge(exe, repo, { ref: 'feature/smoke', noFf: true, message: 'Merge feature/smoke' })
  check('合并无冲突', merged.conflict === false, merged.output)
  const afterMerge = await status(exe, repo)
  check('合并后干净', afterMerge.clean)
  const branches = await listBranches(exe, repo)
  check('分支列表含 feature/smoke', branches.some(b => b.name === 'feature/smoke' && !b.remote))
  check('分支列表标记当前分支', branches.some(b => b.current))

  // ---------- 5. remote: push / clone / fetch / pull ----------
  console.log('\n[5] 远程：push / fetch / pull')
  await run(['remote', 'add', 'origin', remote], repo)
  const remotes = await listRemotes(exe, repo)
  checkEqual('远程数', remotes.length, 1)
  await push(exe, repo, { remote: 'origin', branch: branchName, setUpstream: true })
  const remoteBranches = await run(['--git-dir', remote, 'branch', '--list'], SANDBOX)
  check('远程收到分支', remoteBranches.stdout.includes(branchName), remoteBranches.stdout.trim())

  await run(['clone', '-q', remote, clone], SANDBOX)
  await ident(clone)
  check('克隆仓库可识别', looksLikeRepo(clone))
  write(join(clone, 'from-clone.txt'), 'clone\n')
  await add(exe, clone, [])
  await commit(exe, clone, { message: 'commit from clone' })
  await push(exe, clone, { remote: 'origin', branch: branchName })

  await fetchRemote(exe, repo, { remote: 'origin' })
  const aheadBehind = await status(exe, repo)
  checkEqual('抓取后落后 1 个提交', aheadBehind.branch.behind, 1)
  const pulled = await pull(exe, repo, { remote: 'origin', branch: branchName, mode: 'merge' })
  check('拉取无冲突', pulled.conflict === false, pulled.output)
  check('拉取后文件存在', existsSync(join(repo, 'from-clone.txt')))
  checkEqual('拉取后落后 0', (await status(exe, repo)).branch.behind, 0)

  // ---------- 6. conflict reporting ----------
  console.log('\n[6] 冲突检测')
  write(join(repo, 'conflict.txt'), 'base\n')
  await add(exe, repo, [])
  await commit(exe, repo, { message: 'add conflict.txt' })
  await push(exe, repo, { remote: 'origin', branch: branchName })
  await pull(exe, clone, { remote: 'origin', branch: branchName, mode: 'merge' })

  write(join(repo, 'conflict.txt'), 'from repo\n')
  await add(exe, repo, [])
  await commit(exe, repo, { message: 'repo side' })
  write(join(clone, 'conflict.txt'), 'from clone\n')
  await add(exe, clone, [])
  await commit(exe, clone, { message: 'clone side' })

  await push(exe, clone, { remote: 'origin', branch: branchName })
  const conflictPull = await pull(exe, repo, { remote: 'origin', branch: branchName, mode: 'merge' })
  check('拉取报告冲突', conflictPull.conflict === true, conflictPull.output)
  const conflictStatus = await status(exe, repo)
  check('状态标记合并中', conflictStatus.state.merging)
  check('冲突文件被标记', conflictStatus.entries.some(entry => entry.conflicted && entry.path === 'conflict.txt'))
  await merge(exe, repo, { abort: true })
  check('中止合并后状态恢复', (await status(exe, repo)).state.merging === false)

  // ---------- 7. discovery ----------
  console.log('\n[7] 仓库发现')
  const found = findRepos([SANDBOX])
  check('发现 repo', found.includes(repo))
  check('发现 clone', found.includes(clone))
  check('裸库不被当作工作区仓库', !found.includes(remote))

  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  if (failed > 0) {
    console.log('失败项：')
    for (const failure of failures) console.log(`  - ${failure}`)
  }
  return failed === 0 ? 0 : 1
}

async function run(args, cwd, options = {}) {
  const { runGit } = await import('../lib/git.js')
  const result = await runGit(exe, args, { cwd, ...options })
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} 失败 (${result.code}): ${result.stderr.trim()}`)
  }
  return result
}

async function ident(cwd) {
  await run(['config', 'user.name', 'Smoke Test'], cwd)
  await run(['config', 'user.email', 'smoke@example.invalid'], cwd)
  await run(['config', 'commit.gpgsign', 'false'], cwd)
}

main()
  .then((code) => { process.exitCode = code })
  .catch((error) => {
    console.error('\n测试异常：', error)
    process.exitCode = 1
  })
