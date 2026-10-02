/**
 * dsh-git-plugin — git plumbing.
 *
 * Everything here is plain Node: no cordis, no HTTP. `lib/routes.js` turns
 * these functions into routes and `test/git-smoke.mjs` exercises them against
 * real repositories, so the git semantics can be verified without a host.
 *
 * Design rules:
 *   - argv arrays only, never a shell → no command injection through paths,
 *     branch names or commit messages.
 *   - machine-readable git output (`--porcelain=v2 -z`, `-z`, `%x1f`) so no
 *     display quoting can corrupt a parse.
 *   - commit messages travel on stdin (`-F -`), so newlines and any encoding
 *     survive.
 *   - prompts are disabled: push/pull answers fail fast instead of hanging on
 *     a credential prompt in a GUI process.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { delimiter, join, normalize, resolve } from 'node:path'

/** Default deadline for a local (non-network) git command. */
export const LOCAL_TIMEOUT_MS = 30_000
/** Default deadline for a command that talks to a remote. */
export const NETWORK_TIMEOUT_MS = 300_000
/** Diff bodies are truncated past this many characters before they reach JSON. */
export const MAX_DIFF_CHARS = 1_500_000
/** Hard cap on a single git command's captured output. */
const MAX_BUFFER = 64 * 1024 * 1024

/** A git command that exited non-zero, or could not be started at all. */
export class GitError extends Error {
  constructor(message, { args, code, stderr, stdout, gitPath, timedOut } = {}) {
    super(message)
    this.name = 'GitError'
    this.args = args
    this.code = code
    this.stderr = stderr
    this.stdout = stdout
    this.gitPath = gitPath
    this.timedOut = timedOut === true
  }

  /** The payload the HTTP layer returns for this failure. */
  toJSON() {
    return {
      error: this.message,
      gitCode: this.code,
      gitArgs: this.args,
      stderr: this.stderr,
      timedOut: this.timedOut,
      gitPath: this.gitPath,
      hint: this.timedOut
        ? 'git 命令超时。网络操作请检查远端连通性与凭据；本地操作请检查是否有其它进程占用仓库。'
        : undefined,
    }
  }
}

/* ------------------------------------------------------------------ *
 * Locating the git executable
 * ------------------------------------------------------------------ */

let cachedGitPath = null

/** Well-known install locations, consulted only when PATH has no git. */
function fixedCandidates(exe) {
  if (process.platform !== 'win32') {
    return ['/usr/bin/' + exe, '/usr/local/bin/' + exe, '/opt/homebrew/bin/' + exe, '/opt/local/bin/' + exe]
  }
  const bases = [
    process.env.ProgramW6432,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs') : undefined,
    process.env.LOCALAPPDATA,
    'C:\\software',
    'C:\\software\\Git',
    'D:\\software',
    'D:\\software\\Git',
    'C:\\tools',
  ]
  const out = []
  for (const base of bases) {
    if (!base) continue
    out.push(join(base, 'Git', 'cmd', exe), join(base, 'Git', 'bin', exe), join(base, 'cmd', exe), join(base, 'bin', exe))
  }
  out.push(
    'C:\\Program Files\\Git\\cmd\\git.exe',
    'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
    'D:\\software\\Git\\Git\\cmd\\git.exe',
    'D:\\software\\Git\\cmd\\git.exe',
  )
  return out
}

/** `Git/cmd/git.exe` and `Git/bin/git.exe` one level under a base. */
function scanCandidates(bases, exe) {
  const found = []
  for (const base of bases) {
    if (!base) continue
    let level1 = []
    try {
      level1 = readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory()).slice(0, 200)
    } catch {
      continue
    }
    for (const dir of level1) {
      for (const tail of [['cmd', exe], ['bin', exe], [exe]]) {
        const candidate = join(base, dir.name, ...tail)
        try {
          if (statSync(candidate).isFile()) found.push(candidate)
        } catch {
          /* not there */
        }
      }
    }
  }
  return found
}

/**
 * Resolve the git executable, once per process.
 * @param explicit - configured path, used verbatim when non-empty.
 * @returns an executable path (absolute when found) or the bare name.
 */
export function resolveGitPath(explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  if (cachedGitPath !== null) return cachedGitPath
  const exe = process.platform === 'win32' ? 'git.exe' : 'git'
  const fromPath = []
  for (const dir of String(process.env.PATH ?? '').split(delimiter)) {
    if (dir.trim() !== '') fromPath.push(join(dir.trim(), exe))
  }
  const probe = [...fromPath, ...fixedCandidates(exe)]
  for (const candidate of probe) {
    try {
      if (statSync(candidate).isFile()) {
        cachedGitPath = candidate
        return cachedGitPath
      }
    } catch {
      /* keep looking */
    }
  }
  const scanned = scanCandidates(
    [process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\software', 'D:\\software'],
    exe,
  )
  if (scanned.length > 0) {
    cachedGitPath = scanned[0]
    return cachedGitPath
  }
  // Last resort: let spawn resolve it through PATH and report its own error.
  cachedGitPath = exe
  return cachedGitPath
}

/* ------------------------------------------------------------------ *
 * Running git
 * ------------------------------------------------------------------ */

/** The environment every git child gets: no prompts, no pager, stable locale. */
function childEnv(extra) {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
    SSH_ASKPASS: 'echo',
    GCM_INTERACTIVE: 'never',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
    LANG: 'C',
  }
  return extra === undefined ? env : { ...env, ...extra }
}

/** The git invocation every command starts with: no pager, no external diff. */
function baseArgs(args) {
  return ['-c', 'core.pager=cat', '-c', 'color.ui=false', '--no-optional-locks', ...args]
}

/**
 * Run one git command.
 * @param exe - resolved git executable.
 * @param args - argv after the executable.
 * @param options - `{ cwd, timeoutMs, input, env, maxBuffer }`.
 * @returns `{ code, stdout, stderr, timedOut, args }`; never rejects for a non-zero exit.
 * @throws {GitError} only when the process cannot be started or output exceeds `maxBuffer`.
 */
export function runGit(exe, args, options = {}) {
  const { cwd, timeoutMs = LOCAL_TIMEOUT_MS, input, env, allowFailure = true } = options
  const limit = typeof options.maxBuffer === 'number' ? options.maxBuffer : MAX_BUFFER
  return new Promise((resolvePromise, rejectPromise) => {
    let child
    try {
      child = spawn(exe, baseArgs(args), {
        cwd,
        env: childEnv(env),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      rejectPromise(new GitError(`无法启动 git（${exe}）：${error.message}`, { args, gitPath: exe }))
      return
    }
    const out = []
    const err = []
    let outSize = 0
    let errSize = 0
    let timedOut = false
    let overflow = false
    let settled = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      outSize += chunk.length
      if (outSize <= limit) out.push(chunk)
      else overflow = true
    })
    child.stderr.on('data', (chunk) => {
      errSize += chunk.length
      if (errSize <= limit) err.push(chunk)
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectPromise(new GitError(`无法运行 git（${exe}）：${error.message}`, { args, gitPath: exe }))
    })
    child.stdin.on('error', () => {
      /* the command did not read stdin — nothing to report */
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const stdout = Buffer.concat(out).toString('utf8')
      const stderr = Buffer.concat(err).toString('utf8')
      if (overflow && !allowFailure) {
        rejectPromise(new GitError('git 输出超过上限', { args, code, stdout, stderr, gitPath: exe, timedOut }))
        return
      }
      resolvePromise({ code: code === null ? -1 : code, stdout, stderr, timedOut, overflow, args, gitPath: exe })
    })
    if (input === undefined) child.stdin.end()
    else child.stdin.end(input)
  })
}

/**
 * Run one git command and throw on failure.
 * @returns the command result on exit 0.
 * @throws {GitError} on a non-zero exit or a timeout.
 */
export async function git(exe, args, options = {}) {
  const result = await runGit(exe, args, options)
  if (result.code !== 0) {
    if (result.timedOut) {
      throw new GitError('git 命令超时', { ...result, args: result.args })
    }
    const detail = (result.stderr.trim() || result.stdout.trim() || `退出码 ${result.code}`).split('\n').slice(0, 12).join('\n')
    throw new GitError(detail, { ...result, args: result.args })
  }
  return result
}

/* ------------------------------------------------------------------ *
 * Repository resolution
 * ------------------------------------------------------------------ */

/** Whether a directory looks like a git repository (worktree or gitfile). */
export function looksLikeRepo(dir) {
  try {
    if (!statSync(dir).isDirectory()) return false
  } catch {
    return false
  }
  return existsSync(join(dir, '.git'))
}

/**
 * Absolute worktree root of `repo`.
 * @throws {GitError} when the path is not inside a git worktree.
 */
export async function repoRoot(exe, repo) {
  if (typeof repo !== 'string' || repo.trim() === '') throw new GitError('缺少仓库路径')
  const absolute = resolve(repo)
  let stat
  try {
    stat = statSync(absolute)
  } catch {
    throw new GitError(`路径不存在：${absolute}`)
  }
  if (!stat.isDirectory()) throw new GitError(`不是目录：${absolute}`)
  const result = await runGit(exe, ['rev-parse', '--show-toplevel'], { cwd: absolute, timeoutMs: LOCAL_TIMEOUT_MS })
  if (result.code !== 0) {
    const detail = result.stderr.trim() || '不是 git 仓库'
    throw new GitError(`${absolute} 不是 git 仓库（${detail.split('\n')[0]}）`)
  }
  // git prints POSIX separators even on Windows; the report and the repo list
  // compare paths as strings, so everything here is native form.
  return normalize(result.stdout.trim().replace(/[\\/]+$/, '')) || absolute
}

/** Whether HEAD resolves to a commit (false on a fresh, unborn branch). */
async function hasHead(exe, cwd) {
  const result = await runGit(exe, ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd })
  return result.code === 0 && result.stdout.trim() !== ''
}

/** Names of the in-progress operations a worktree can be in. */
async function operationState(exe, cwd) {
  const state = { merging: false, rebasing: false, cherryPicking: false, reverting: false, bisecting: false }
  const markers = {
    merging: 'MERGE_HEAD',
    cherryPicking: 'CHERRY_PICK_HEAD',
    reverting: 'REVERT_HEAD',
    bisecting: 'BISECT_LOG',
  }
  const gitDirResult = await runGit(exe, ['rev-parse', '--absolute-git-dir'], { cwd })
  if (gitDirResult.code !== 0) return state
  const gitDir = gitDirResult.stdout.trim()
  for (const [key, file] of Object.entries(markers)) state[key] = existsSync(join(gitDir, file))
  state.rebasing = existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))
  return state
}

/* ------------------------------------------------------------------ *
 * status
 * ------------------------------------------------------------------ */

function statusCodeLabel(code) {
  switch (code) {
    case 'M': return 'modified'
    case 'A': return 'added'
    case 'D': return 'deleted'
    case 'R': return 'renamed'
    case 'C': return 'copied'
    case 'T': return 'typechange'
    case 'U': return 'unmerged'
    case '?': return 'untracked'
    case '!': return 'ignored'
    case '.': return 'unchanged'
    default: return code === '' ? 'unknown' : code
  }
}

/**
 * Parse `git status --porcelain=v2 --branch -z` output.
 * @param raw - the NUL-separated stdout.
 * @returns `{ branch, entries }` in the shape the UI consumes.
 */
export function parseStatus(raw) {
  const branch = { oid: null, head: null, upstream: null, ahead: 0, behind: 0, unborn: false, detached: false }
  const entries = []
  const fields = raw.split('\0')
  for (let index = 0; index < fields.length; index += 1) {
    const line = fields[index]
    if (line === '') continue
    if (line.startsWith('# ')) {
      const rest = line.slice(2)
      if (rest.startsWith('branch.oid ')) {
        const value = rest.slice('branch.oid '.length).trim()
        branch.oid = value === '(initial)' ? null : value
        branch.unborn = value === '(initial)'
      } else if (rest.startsWith('branch.head ')) {
        const value = rest.slice('branch.head '.length).trim()
        branch.detached = value === '(detached)'
        branch.head = value
      } else if (rest.startsWith('branch.upstream ')) {
        branch.upstream = rest.slice('branch.upstream '.length).trim()
      } else if (rest.startsWith('branch.ab ')) {
        const match = /\+(-?\d+)\s+-(-?\d+)/.exec(rest)
        if (match) {
          branch.ahead = Number(match[1])
          branch.behind = Number(match[2])
        }
      }
      continue
    }
    const kind = line[0]
    if (kind === '1' || kind === '2') {
      const isRename = kind === '2'
      const parts = line.split(' ')
      const xy = parts[1] ?? '..'
      const offset = isRename ? 9 : 8
      const path = parts.slice(offset).join(' ')
      let origPath = null
      if (isRename) {
        origPath = fields[index + 1] ?? null
        index += 1
      }
      entries.push({
        path,
        origPath,
        index: xy[0] ?? '.',
        worktree: xy[1] ?? '.',
        indexLabel: statusCodeLabel(xy[0] ?? '.'),
        worktreeLabel: statusCodeLabel(xy[1] ?? '.'),
        kind: isRename ? 'renamed' : 'tracked',
        staged: (xy[0] ?? '.') !== '.',
        unstaged: (xy[1] ?? '.') !== '.',
        conflicted: false,
      })
      continue
    }
    if (kind === 'u') {
      const parts = line.split(' ')
      const path = parts.slice(10).join(' ')
      entries.push({
        path,
        origPath: null,
        index: parts[1]?.[0] ?? 'U',
        worktree: parts[1]?.[1] ?? 'U',
        indexLabel: 'unmerged',
        worktreeLabel: 'unmerged',
        kind: 'unmerged',
        staged: false,
        unstaged: true,
        conflicted: true,
      })
      continue
    }
    if (kind === '?') {
      entries.push({
        path: line.slice(2),
        origPath: null,
        index: '?',
        worktree: '?',
        indexLabel: 'untracked',
        worktreeLabel: 'untracked',
        kind: 'untracked',
        staged: false,
        unstaged: true,
        conflicted: false,
      })
      continue
    }
    if (kind === '!') {
      entries.push({
        path: line.slice(2),
        origPath: null,
        index: '!',
        worktree: '!',
        indexLabel: 'ignored',
        worktreeLabel: 'ignored',
        kind: 'ignored',
        staged: false,
        unstaged: false,
        conflicted: false,
      })
    }
  }
  return { branch, entries }
}

/** Working-tree status plus operation state and stash count. */
export async function status(exe, cwd) {
  const raw = await git(exe, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { cwd })
  const parsed = parseStatus(raw.stdout)
  const state = await operationState(exe, cwd)
  let stashCount = 0
  const stash = await runGit(exe, ['rev-list', '--walk-reflogs', '--count', 'refs/stash'], { cwd })
  if (stash.code === 0) stashCount = Number(stash.stdout.trim()) || 0
  return {
    ...parsed,
    state,
    stashCount,
    clean: parsed.entries.filter(entry => entry.kind !== 'ignored').length === 0,
  }
}

/* ------------------------------------------------------------------ *
 * info
 * ------------------------------------------------------------------ */

/** Repository identity: root, HEAD, remotes, identity, upstream. */
export async function info(exe, cwd) {
  const root = await repoRoot(exe, cwd)
  const unborn = !(await hasHead(exe, root))
  const statusResult = await status(exe, root)
  const userName = await runGit(exe, ['config', '--get', 'user.name'], { cwd: root })
  const userEmail = await runGit(exe, ['config', '--get', 'user.email'], { cwd: root })
  const branchInfo = await runGit(exe, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { cwd: root })
  const totalCommits = await runGit(exe, ['rev-list', '--count', 'HEAD'], { cwd: root })
  return {
    repo: root,
    name: root.split(/[\\/]/).filter(Boolean).pop() ?? root,
    branch: statusResult.branch.head ?? '',
    detached: statusResult.branch.detached,
    unborn,
    head: statusResult.branch.oid,
    upstream: branchInfo.code === 0 ? branchInfo.stdout.trim() : null,
    ahead: statusResult.branch.ahead,
    behind: statusResult.branch.behind,
    remotes: await listRemotes(exe, root),
    user: {
      name: userName.code === 0 ? userName.stdout.trim() : '',
      email: userEmail.code === 0 ? userEmail.stdout.trim() : '',
    },
    commitCount: totalCommits.code === 0 ? Number(totalCommits.stdout.trim()) || 0 : 0,
    state: statusResult.state,
    stashCount: statusResult.stashCount,
  }
}

/* ------------------------------------------------------------------ *
 * log
 * ------------------------------------------------------------------ */

const LOG_FORMAT = ['%H', '%h', '%P', '%an', '%ae', '%aI', '%cn', '%cI', '%s', '%D'].join('%x1f')

/** Refs a commit carries, from `%D`, split into `{ name, kind }` entries. */
function parseDecorations(raw) {
  if (!raw) return { refs: [], head: null }
  const refs = []
  let head = null
  for (const piece of raw.split(',').map(part => part.trim()).filter(Boolean)) {
    if (piece.startsWith('HEAD -> ')) {
      const name = piece.slice('HEAD -> '.length)
      head = name
      refs.push({ name, kind: 'head' })
      continue
    }
    if (piece === 'HEAD') {
      refs.push({ name: 'HEAD', kind: 'head' })
      continue
    }
    if (piece.startsWith('tag: ')) {
      refs.push({ name: piece.slice('tag: '.length), kind: 'tag' })
      continue
    }
    if (piece.includes(' -> ')) {
      const [from, to] = piece.split(' -> ')
      refs.push({ name: to, kind: from === 'origin' || !from.includes('/') ? 'head' : 'remote' })
      continue
    }
    refs.push({ name: piece, kind: piece.includes('/') ? 'remote' : 'branch' })
  }
  return { refs, head }
}

/**
 * Commits, newest first.
 * @param options - `{ limit, skip, ref, search, path, author, all }`.
 */
export async function log(exe, cwd, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 500)
  const skip = Math.max(Number(options.skip) || 0, 0)
  const args = ['log', `--max-count=${limit + 1}`, `--skip=${skip}`, '--date=iso-strict', `--pretty=format:${LOG_FORMAT}%x1e`]
  const ref = typeof options.ref === 'string' ? options.ref.trim() : ''
  if (ref !== '') {
    const allowedFlags = new Set(['--all', '--branches', '--tags', '--remotes'])
    if (!allowedFlags.has(ref) && !isSafeRev(ref)) throw new GitError(`不允许的 ref 参数：${ref}`)
    args.push(ref)
  }
  if (typeof options.search === 'string' && options.search.trim() !== '') {
    args.push('-i', `--grep=${options.search.trim()}`)
  }
  if (typeof options.author === 'string' && options.author.trim() !== '') {
    args.push('-i', `--author=${options.author.trim()}`)
  }
  if (typeof options.path === 'string' && options.path.trim() !== '') {
    args.push('--', options.path.trim())
  }
  const result = await runGit(exe, args, { cwd, timeoutMs: 60_000 })
  if (result.code !== 0) {
    if (/does not have any commits yet|unknown revision|bad default revision|ambiguous argument/i.test(result.stderr)) {
      return { commits: [], hasMore: false }
    }
    throw new GitError(result.stderr.trim() || 'git log 失败', result)
  }
  const records = result.stdout.split('\x1e').map(record => record.replace(/^\n+/, '')).filter(record => record.trim() !== '')
  const commits = []
  for (const record of records) {
    const fields = record.split('\x1f')
    if (fields.length < 10) continue
    const { refs } = parseDecorations(fields[9])
    commits.push({
      sha: fields[0],
      short: fields[1],
      parents: fields[2].trim() === '' ? [] : fields[2].trim().split(' '),
      author: fields[3],
      authorEmail: fields[4],
      authoredAt: fields[5],
      committer: fields[6],
      committedAt: fields[7],
      subject: fields[8],
      refs,
    })
  }
  const hasMore = commits.length > limit
  return { commits: hasMore ? commits.slice(0, limit) : commits, hasMore }
}

/* ------------------------------------------------------------------ *
 * commit detail and diffs
 * ------------------------------------------------------------------ */

/** Rename-aware name/status list for one commit, relative to its first parent. */
async function commitFiles(exe, cwd, sha) {
  const parents = await runGit(exe, ['rev-list', '--parents', '-n', '1', sha], { cwd })
  const parts = parents.stdout.trim().split(' ').slice(1)
  const args = parts.length > 0
    ? ['diff', '--name-status', '-z', '--find-renames', parts[0], sha]
    : ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-z', sha]
  const result = await runGit(exe, args, { cwd, timeoutMs: 60_000 })
  if (result.code !== 0) return []
  const fields = result.stdout.split('\0').filter(field => field !== '')
  const files = []
  for (let index = 0; index < fields.length; index += 1) {
    const status = fields[index]
    if (/^[RC]/.test(status)) {
      files.push({ status: statusCodeLabel(status[0]), path: fields[index + 2] ?? '', origPath: fields[index + 1] ?? null })
      index += 2
    } else {
      files.push({ status: statusCodeLabel(status[0]), path: fields[index + 1] ?? '', origPath: null })
      index += 1
    }
  }
  return files
}

/** One commit with its metadata, refs and changed files. */
export async function commitDetail(exe, cwd, sha) {
  if (typeof sha !== 'string' || !isSafeRev(sha)) throw new GitError('非法的提交标识')
  const result = await git(exe, ['log', '-1', `--date=iso-strict`, `--pretty=format:${LOG_FORMAT}`, sha], { cwd })
  const fields = result.stdout.split('\x1f')
  const { refs } = parseDecorations(fields[9] ?? '')
  const stat = await runGit(exe, ['show', '--stat', '--oneline', '--no-color', '--format=', sha], { cwd, timeoutMs: 60_000 })
  return {
    sha: fields[0],
    short: fields[1],
    parents: (fields[2] ?? '').trim() === '' ? [] : fields[2].trim().split(' '),
    author: fields[3],
    authorEmail: fields[4],
    authoredAt: fields[5],
    committer: fields[6],
    committedAt: fields[7],
    subject: fields[8],
    refs,
    files: await commitFiles(exe, cwd, sha),
    statText: stat.code === 0 ? stat.stdout.trim() : '',
  }
}

function truncateDiff(text) {
  if (text.length <= MAX_DIFF_CHARS) return { text, truncated: false }
  return { text: text.slice(0, MAX_DIFF_CHARS), truncated: true }
}

/** Branch names, shas and revision expressions we are willing to pass to git. */
export function isSafeRev(value) {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > 250) return false
  if (trimmed.startsWith('-') || trimmed.includes('\0') || /\s/.test(trimmed)) return false
  return /^[0-9A-Za-z._/@{}^~:+-]+$/.test(trimmed)
}

/**
 * A diff-shaped view of an untracked file: `git diff` prints nothing for a
 * path git does not track yet, and the GUI still has to show what is about to
 * be added, so the "new file" hunk is composed here.
 * @returns `{ text, truncated, empty, untracked: true }`, or null when the
 * path is not a readable regular file.
 */
export function untrackedFileDiff(cwd, path) {
  const absolute = join(cwd, path)
  let stat
  try {
    stat = statSync(absolute)
  } catch {
    return null
  }
  if (!stat.isFile()) return null
  let buffer
  try {
    buffer = readFileSync(absolute)
  } catch {
    return null
  }
  const header = [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
  ]
  if (buffer.includes(0)) {
    return { text: header.concat([`Binary file ${path} differs`]).join('\n') + '\n', truncated: false, empty: false, untracked: true }
  }
  const lines = buffer.toString('utf8').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const capped = lines.slice(0, 4000)
  const body = capped.map(line => `+${line}`)
  if (lines.length > capped.length) body.push(`+… 还有 ${lines.length - capped.length} 行未显示`)
  const text = header.concat([`@@ -0,0 +1,${Math.max(lines.length, 1)} @@`], body).join('\n') + '\n'
  return { text, truncated: lines.length > capped.length, empty: false, untracked: true }
}

/**
 * A unified diff.
 * @param options - `{ scope: 'worktree'|'staged'|'commit', path, sha, context, stat }`.
 */
export async function diff(exe, cwd, options = {}) {
  const context = Math.min(Math.max(Number(options.context) || 3, 0), 20)
  const scope = options.scope ?? 'worktree'
  const args = ['diff', '--no-color', '--no-ext-diff', `-U${context}`, '--find-renames']
  if (scope === 'staged') args.push('--cached')
  if (scope === 'commit') {
    const sha = String(options.sha ?? '').trim()
    if (!isSafeRev(sha)) throw new GitError('缺少或非法的提交标识')
    const parents = await runGit(exe, ['rev-list', '--parents', '-n', '1', sha], { cwd })
    const parentList = parents.code === 0 ? parents.stdout.trim().split(' ').slice(1) : []
    if (parentList.length === 0) {
      // Root commit: `git show` diffs against the empty tree.
      const rootArgs = ['show', '--no-color', '--no-ext-diff', '--format=', `-U${context}`, sha]
      const path = typeof options.path === 'string' ? options.path.trim() : ''
      if (path !== '') rootArgs.push('--', path)
      const shown = await runGit(exe, rootArgs, { cwd, timeoutMs: 120_000 })
      if (shown.code !== 0) throw new GitError(shown.stderr.trim() || 'git show 失败', shown)
      const { text, truncated } = truncateDiff(shown.stdout)
      return { text, truncated, empty: text.trim() === '' }
    }
    args.push(parentList[0], sha)
  }
  if (options.stat === true) args.push('--stat')
  const path = typeof options.path === 'string' ? options.path.trim() : ''
  if (path !== '') args.push('--', path)
  const result = await runGit(exe, args, { cwd, timeoutMs: 120_000 })
  if (result.code !== 0) {
    const message = result.stderr.trim() || 'git diff 失败'
    if (/unknown revision|ambiguous argument|bad revision|no such path/i.test(message)) return { text: '', truncated: false, empty: true }
    throw new GitError(message, result)
  }
  const { text, truncated } = truncateDiff(result.stdout)
  if (text.trim() === '' && scope === 'worktree' && path !== '' && options.stat !== true) {
    const tracked = await runGit(exe, ['ls-files', '--error-unmatch', '--', path], { cwd })
    if (tracked.code !== 0) {
      const synthetic = untrackedFileDiff(cwd, path)
      if (synthetic !== null) return synthetic
    }
  }
  return { text, truncated, empty: text.trim() === '' }
}

/* ------------------------------------------------------------------ *
 * branches, remotes, repos
 * ------------------------------------------------------------------ */

/** Local and remote branches with their upstream tracking state. */
export async function listBranches(exe, cwd) {
  const format = ['%(refname)', '%(refname:short)', '%(objectname:short)', '%(upstream:short)', '%(upstream:track)', '%(HEAD)', '%(committerdate:iso-strict)', '%(contents:subject)'].join('%1f')
  const result = await git(exe, ['for-each-ref', `--format=${format}%1e`, '--sort=-committerdate', 'refs/heads', 'refs/remotes'], { cwd })
  const branches = []
  for (const record of result.stdout.split('\x1e')) {
    const trimmed = record.replace(/^\n+/, '')
    if (trimmed.trim() === '') continue
    const [full, name, sha, upstream, track, head, date, subject] = trimmed.split('\x1f')
    if (name === undefined || name === '') continue
    if (name.endsWith('/HEAD')) continue
    let ahead = 0
    let behind = 0
    let gone = false
    if (track && track.includes('ahead')) ahead = Number(/ahead (\d+)/.exec(track)?.[1] ?? 0)
    if (track && track.includes('behind')) behind = Number(/behind (\d+)/.exec(track)?.[1] ?? 0)
    if (track && track.includes('gone')) gone = true
    branches.push({
      name,
      sha: sha ?? '',
      upstream: upstream ?? '',
      ahead,
      behind,
      gone,
      current: head === '*',
      remote: (full ?? '').startsWith('refs/remotes/'),
      updatedAt: date ?? '',
      subject: subject ?? '',
    })
  }
  return branches
}

/** Configured remotes with their fetch/push URLs. */
export async function listRemotes(exe, cwd) {
  const result = await runGit(exe, ['remote', '-v'], { cwd })
  if (result.code !== 0) return []
  const byName = new Map()
  for (const line of result.stdout.split('\n')) {
    // A remote URL may contain spaces (a Windows path under "Program Files"),
    // so only the name and the trailing role are structural.
    const match = /^(\S+)\s+(.+?)\s+\((fetch|push)\)\s*$/.exec(line)
    if (!match) continue
    const [, name, url, kind] = match
    const entry = byName.get(name) ?? { name, fetchUrl: '', pushUrl: '' }
    if (kind === 'fetch') entry.fetchUrl = url
    else entry.pushUrl = url
    byName.set(name, entry)
  }
  return [...byName.values()]
}

/**
 * Repositories directly under the configured roots (depth 1), plus the roots
 * themselves. Bounded so a huge directory cannot stall the request.
 */
export function findRepos(roots, extra = []) {
  const found = []
  const seen = new Set()
  for (const candidate of [...roots, ...extra]) {
    if (typeof candidate !== 'string' || candidate.trim() === '') continue
    const absolute = resolve(candidate)
    if (seen.has(absolute)) continue
    seen.add(absolute)
    if (looksLikeRepo(absolute)) {
      found.push(absolute)
      continue
    }
    let entries = []
    try {
      entries = readdirSync(absolute, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries.slice(0, 300)) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const child = join(absolute, entry.name)
      if (seen.has(child)) continue
      if (looksLikeRepo(child)) {
        seen.add(child)
        found.push(child)
      }
    }
  }
  return found
}

/* ------------------------------------------------------------------ *
 * Mutations
 * ------------------------------------------------------------------ */

function assertPaths(paths) {
  if (!Array.isArray(paths)) return []
  return paths
    .filter(path => typeof path === 'string')
    .map(path => path.trim())
    .filter(path => path !== '' && !path.includes('\0'))
    .slice(0, 500)
}

/** Stage paths (or everything). */
export async function add(exe, cwd, paths) {
  const list = assertPaths(paths)
  const args = list.length === 0 ? ['add', '-A'] : ['add', '--', ...list]
  await git(exe, args, { cwd, timeoutMs: 60_000 })
  return { staged: list.length === 0 ? 'all' : list }
}

/** Unstage paths (`git restore --staged`), falling back to `git reset`. */
export async function unstage(exe, cwd, paths) {
  const list = assertPaths(paths)
  const args = list.length === 0
    ? ['restore', '--staged', '--', '.']
    : ['restore', '--staged', '--', ...list]
  const result = await runGit(exe, args, { cwd, timeoutMs: 60_000 })
  if (result.code !== 0) {
    const fallback = list.length === 0 ? ['reset', '-q', 'HEAD', '--', '.'] : ['reset', '-q', 'HEAD', '--', ...list]
    await git(exe, fallback, { cwd, timeoutMs: 60_000 })
  }
  return { unstaged: list.length === 0 ? 'all' : list }
}

/** Discard working-tree changes for tracked paths, delete untracked ones. */
export async function discard(exe, cwd, paths) {
  const list = assertPaths(paths)
  if (list.length === 0) throw new GitError('未选择要丢弃的文件')
  const tracked = await runGit(exe, ['ls-files', '--', ...list], { cwd })
  const trackedSet = new Set(tracked.stdout.split('\n').map(line => line.trim()).filter(Boolean))
  const toRestore = list.filter(path => trackedSet.has(path))
  const untracked = list.filter(path => !trackedSet.has(path))
  if (toRestore.length > 0) {
    await git(exe, ['restore', '--worktree', '--', ...toRestore], { cwd, timeoutMs: 60_000 })
  }
  for (const path of untracked) {
    await git(exe, ['clean', '-f', '-d', '--', path], { cwd, timeoutMs: 60_000 })
  }
  return { restored: toRestore, cleaned: untracked }
}

/**
 * Create a commit.
 * @param options - `{ message, amend, all, paths, signoff, noVerify }`.
 */
export async function commit(exe, cwd, options = {}) {
  const message = typeof options.message === 'string' ? options.message : ''
  if (message.trim() === '' && options.amend !== true) throw new GitError('提交信息不能为空')
  const args = ['commit', '-F', '-']
  if (options.amend === true) args.push('--amend')
  if (options.all === true) args.push('-a')
  if (options.signoff === true) args.push('--signoff')
  if (options.noVerify === true) args.push('--no-verify')
  const list = assertPaths(options.paths)
  if (list.length > 0) args.push('--', ...list)
  const result = await git(exe, args, { cwd, input: message, timeoutMs: 120_000 })
  const summary = result.stdout.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 6).join('\n')
  const head = await runGit(exe, ['rev-parse', '--short', 'HEAD'], { cwd })
  return { summary, sha: head.code === 0 ? head.stdout.trim() : null, output: result.stdout.trim() }
}

/** Fetch from a remote, optionally pruning. */
export async function fetchRemote(exe, cwd, options = {}) {
  const remote = typeof options.remote === 'string' && options.remote.trim() !== '' ? options.remote.trim() : 'origin'
  const args = ['fetch', '--prune']
  if (typeof options.branch === 'string' && options.branch.trim() !== '') args.push(remote, options.branch.trim())
  else args.push(remote)
  const result = await git(exe, args, { cwd, timeoutMs: NETWORK_TIMEOUT_MS })
  return { output: (result.stderr + result.stdout).trim() }
}

/**
 * Pull.
 * @param options - `{ remote, branch, mode: 'merge'|'rebase'|'ff-only', autostash }`.
 */
export async function pull(exe, cwd, options = {}) {
  const remote = typeof options.remote === 'string' && options.remote.trim() !== '' ? options.remote.trim() : ''
  const branch = typeof options.branch === 'string' && options.branch.trim() !== '' ? options.branch.trim() : ''
  const args = ['pull', '--no-edit']
  if (options.mode === 'rebase') args.push('--rebase')
  else if (options.mode === 'ff-only') args.push('--ff-only')
  else args.push('--no-rebase')
  if (options.autostash === true) args.push('--autostash')
  if (remote !== '') args.push(remote)
  if (branch !== '') args.push(branch)
  const result = await runGit(exe, args, { cwd, timeoutMs: NETWORK_TIMEOUT_MS })
  const output = (result.stdout + '\n' + result.stderr).trim()
  if (result.code !== 0) {
    const conflicted = /CONFLICT|Automatic merge failed|fix conflicts/i.test(output)
    if (!conflicted) {
      throw new GitError(output.split('\n').filter(Boolean).slice(0, 12).join('\n') || 'git pull 失败', result)
    }
  }
  return { output, conflict: /CONFLICT|fix conflicts/i.test(output) }
}

/**
 * Push.
 * @param options - `{ remote, branch, setUpstream, forceWithLease, tags, dryRun }`.
 */
export async function push(exe, cwd, options = {}) {
  const remote = typeof options.remote === 'string' && options.remote.trim() !== '' ? options.remote.trim() : 'origin'
  const branch = typeof options.branch === 'string' && options.branch.trim() !== '' ? options.branch.trim() : ''
  const args = ['push']
  if (options.setUpstream === true) args.push('--set-upstream')
  if (options.forceWithLease === true) args.push('--force-with-lease')
  if (options.tags === true) args.push('--tags')
  if (options.dryRun === true) args.push('--dry-run')
  args.push(remote)
  if (branch !== '') args.push(branch)
  const result = await git(exe, args, { cwd, timeoutMs: NETWORK_TIMEOUT_MS })
  return { output: (result.stderr + '\n' + result.stdout).trim() }
}

/**
 * Merge a ref into HEAD.
 * @param options - `{ ref, noFf, ffOnly, squash, message, noCommit, abort, continueMerge }`.
 */
export async function merge(exe, cwd, options = {}) {
  if (options.abort === true) {
    const result = await git(exe, ['merge', '--abort'], { cwd, timeoutMs: 60_000 })
    return { output: (result.stdout + result.stderr).trim(), aborted: true }
  }
  if (options.continueMerge === true) {
    const result = await runGit(exe, ['commit', '--no-edit'], { cwd, timeoutMs: 60_000 })
    return { output: (result.stdout + result.stderr).trim(), continued: result.code === 0 }
  }
  const ref = typeof options.ref === 'string' ? options.ref.trim() : ''
  if (ref === '' || ref.startsWith('-')) throw new GitError('请选择一个要合并的分支或提交')
  const args = ['merge', '--no-edit']
  if (options.noFf === true) args.push('--no-ff')
  if (options.ffOnly === true) args.push('--ff-only')
  if (options.squash === true) args.push('--squash')
  if (options.noCommit === true) args.push('--no-commit')
  if (typeof options.message === 'string' && options.message.trim() !== '') args.push('-m', options.message.trim())
  args.push(ref)
  const result = await runGit(exe, args, { cwd, timeoutMs: 120_000 })
  const output = (result.stdout + '\n' + result.stderr).trim()
  const conflict = /CONFLICT|Automatic merge failed|fix conflicts/i.test(output)
  if (result.code !== 0 && !conflict) {
    throw new GitError(output.split('\n').filter(Boolean).slice(0, 12).join('\n') || 'git merge 失败', result)
  }
  return { output, conflict, ref }
}

/** Switch branches (or detach onto a commit). */
export async function checkout(exe, cwd, ref) {
  const target = typeof ref === 'string' ? ref.trim() : ''
  if (target === '' || target.startsWith('-')) throw new GitError('请选择要切换的分支')
  const result = await git(exe, ['checkout', target], { cwd, timeoutMs: 120_000 })
  return { output: (result.stderr + result.stdout).trim(), ref: target }
}

/** Create and switch to a new branch. */
export async function createBranch(exe, cwd, name, startPoint) {
  const branch = typeof name === 'string' ? name.trim() : ''
  if (branch === '' || branch.startsWith('-')) throw new GitError('请输入合法的分支名')
  const args = ['checkout', '-b', branch]
  if (typeof startPoint === 'string' && startPoint.trim() !== '') args.push(startPoint.trim())
  const result = await git(exe, args, { cwd, timeoutMs: 60_000 })
  return { output: (result.stderr + result.stdout).trim(), branch }
}

/** Abort an in-progress operation. */
export async function abortOperation(exe, cwd, operation) {
  const map = { merge: ['merge', '--abort'], rebase: ['rebase', '--abort'], 'cherry-pick': ['cherry-pick', '--abort'], revert: ['revert', '--abort'] }
  const args = map[operation]
  if (args === undefined) throw new GitError(`不支持的中止操作：${operation}`)
  const result = await git(exe, args, { cwd, timeoutMs: 60_000 })
  return { output: (result.stdout + result.stderr).trim() }
}

/** Set the repository-local commit identity. */
export async function setIdentity(exe, cwd, name, email) {
  const userName = typeof name === 'string' ? name.trim() : ''
  const userEmail = typeof email === 'string' ? email.trim() : ''
  if (userName === '' || userEmail === '') throw new GitError('请同时填写用户名与邮箱')
  await git(exe, ['config', 'user.name', userName], { cwd })
  await git(exe, ['config', 'user.email', userEmail], { cwd })
  return { name: userName, email: userEmail }
}
