/**
 * dsh-git-plugin — HTTP surface.
 *
 * `createRoutes()` returns `{kind:'exact', path, handler}` entries for the DSH
 * host `webServer`, plus nothing else: mounting them is `lib/index.js`'s job,
 * and `test/http-smoke.mjs` mounts the same table on a plain node server, so
 * the wire contract is testable without a host.
 *
 * Every mutating route is same-origin fenced (`Origin` must match `Host` when
 * present, `Host` must name loopback or a trusted authority, `Sec-Fetch-Site:
 * cross-site` is refused) — the same rule dsh-market uses, because these routes
 * run git in a local process and a random page must not be able to drive them.
 */

import { readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  GitError,
  abortOperation,
  add,
  checkout,
  commitDetail,
  commit,
  createBranch,
  diff,
  discard,
  fetchRemote,
  findRepos,
  info,
  listBranches,
  log,
  looksLikeRepo,
  merge,
  pull,
  push,
  repoRoot,
  resolveGitPath,
  setIdentity,
  status,
  unstage,
} from './git.js'

/** The package id used for the route prefix and the client-bundle row. */
const PACKAGE_ID = 'dsh-git-plugin'
/** Where the browser assets live. */
const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url))
/** Largest JSON body accepted on a mutating route. */
const MAX_BODY_BYTES = 1024 * 1024

/* ------------------------------------------------------------------ *
 * HTTP helpers
 * ------------------------------------------------------------------ */

/** Write a JSON payload with no-store caching. */
export function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/** Whether a `Host` header names a loopback authority. */
export function loopbackAuthority(host) {
  if (host === undefined) return false
  const lower = host.toLowerCase()
  const name = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
}

/**
 * The mutating-route fence.
 * @param request - the incoming request.
 * @param trustedHosts - extra authorities this deployment serves.
 */
export function sameOrigin(request, trustedHosts = []) {
  const host = request.headers.host
  if (host !== undefined && !loopbackAuthority(host) && !trustedHosts.some(entry => entry.toLowerCase() === host.toLowerCase())) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Read and parse a JSON body, refusing anything over `maxBytes`. */
export async function readJsonBody(request, maxBytes = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new GitError('请求体过大')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw new GitError('请求体不是合法 JSON')
  }
}

function queryOf(request) {
  return new URL(request.url ?? '/', 'http://127.0.0.1').searchParams
}

function sendAsset(response, file, contentType) {
  let body
  try {
    body = readFileSync(resolve(WEB_DIR, file))
  } catch {
    sendJson(response, 500, { error: `缺少前端资源：${file}` })
    return
  }
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': contentType,
    'content-length': body.length,
  })
  response.end(body)
}

/* ------------------------------------------------------------------ *
 * Route table
 * ------------------------------------------------------------------ */

/**
 * Build the plugin's route table.
 * @param options - `{ gitPath, roots, repo, trustedHosts, workspaceDirs, clientModules, logLimit }`.
 * @returns `{ routes, resolveDefaultRepo, describe }`.
 */
export function createRoutes(options = {}) {
  const gitPath = resolveGitPath(options.gitPath)
  const roots = Array.isArray(options.roots)
    ? options.roots.filter(root => typeof root === 'string' && root.trim() !== '').map(root => resolve(root))
    : []
  const trustedHosts = Array.isArray(options.trustedHosts) ? options.trustedHosts.filter(h => typeof h === 'string') : []
  const workspaceDirs = typeof options.workspaceDirs === 'function' ? options.workspaceDirs : () => []
  const configuredRepo = typeof options.repo === 'string' && options.repo.trim() !== '' ? resolve(options.repo) : null
  const maxLog = Math.min(Math.max(Number(options.logLimit) || 200, 10), 500)

  /** Whether `target` is the same as, or below, one of the configured roots. */
  function withinRoots(target) {
    if (roots.length === 0) return true
    return roots.some((root) => {
      if (target === root) return true
      const rel = relative(root, target)
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
    })
  }

  /** Candidate repositories: the configured roots, host workspaces, then config. */
  function candidateDirs() {
    const extra = []
    if (configuredRepo !== null) extra.push(configuredRepo)
    for (const dir of workspaceDirs()) if (typeof dir === 'string' && dir.trim() !== '') extra.push(dir)
    return findRepos(roots, extra)
  }

  function resolveDefaultRepo() {
    if (configuredRepo !== null) return configuredRepo
    const candidates = candidateDirs()
    if (candidates.length > 0) return candidates[0]
    const fallback = process.cwd()
    if (looksLikeRepo(fallback)) return fallback
    return null
  }

  /** Canonical worktree root for a request, enforcing the root allow-list. */
  async function requestRepo(requested) {
    const wanted = typeof requested === 'string' && requested.trim() !== '' ? requested.trim() : resolveDefaultRepo()
    if (wanted === null || wanted === undefined || String(wanted).trim() === '') {
      throw new GitError('没有可用的仓库：请先在界面上选择一个仓库路径')
    }
    const absolute = resolve(String(wanted))
    if (!withinRoots(absolute)) {
      throw new GitError(`仓库路径不在允许的根目录内：${absolute}`)
    }
    return repoRoot(gitPath, absolute)
  }

  /**
   * Run one route body, turning failures into JSON instead of a bare 400.
   * A handler that wrote its own response (a static asset) is left alone.
   */
  async function guard(response, work) {
    try {
      const result = await work()
      if (response.headersSent || response.writableEnded) return
      sendJson(response, 200, { ok: true, ...(result ?? {}) })
    } catch (error) {
      if (response.headersSent || response.writableEnded) return
      if (error instanceof GitError) {
        sendJson(response, 400, { ok: false, ...error.toJSON(), error: error.message })
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      sendJson(response, 500, { ok: false, error: message })
    }
  }

  /**
   * One exact route serving several methods.
   *
   * The host route table is keyed by PATH alone — registering the same path
   * twice throws, which would take the whole plugin down — so a path that
   * answers both a read and a mutation must be one registration. GET needs no
   * fence; POST is same-origin fenced and reads a JSON body.
   * @param path - the exact pathname.
   * @param handlers - `{ GET?, POST? }`, each `(input, request, response) => result`.
   */
  function route(path, handlers) {
    return {
      kind: 'exact',
      path,
      handler: async (request, response) => {
        const method = request.method === 'HEAD' ? 'GET' : request.method
        const work = handlers[method]
        if (work === undefined) {
          response.writeHead(405, { allow: Object.keys(handlers).join(', ') })
          response.end()
          return
        }
        if (method === 'POST' && !sameOrigin(request, trustedHosts)) {
          sendJson(response, 403, { ok: false, error: 'untrusted origin' })
          return
        }
        await guard(response, async () => work(
          method === 'POST' ? await readJsonBody(request) : queryOf(request),
          request,
          response,
        ))
      },
    }
  }

  /** A read route: query parameters only. */
  function get(path, work) {
    return route(path, { GET: work })
  }

  /** A mutation route: JSON body, same-origin fenced. */
  function post(path, work) {
    return route(path, { POST: work })
  }

  const routes = [
    get('/dsh-git/', (_query, _request, response) => sendAsset(response, 'index.html', 'text/html; charset=utf-8')),
    get('/dsh-git/app.css', (_query, _request, response) => sendAsset(response, 'app.css', 'text/css; charset=utf-8')),
    get('/dsh-git/app.js', (_query, _request, response) => sendAsset(response, 'app.js', 'text/javascript; charset=utf-8')),

    get('/dsh-git/api/repos', async () => {
      const repos = candidateDirs()
      return { repos, defaultRepo: resolveDefaultRepo(), roots, gitPath, cwd: process.cwd() }
    }),

    get('/dsh-git/api/selfcheck', async () => {
      // Direct evidence that both halves are live: every request here already
      // proves the host half, and the client half is read back from the
      // host's own client-module graph.
      const client = { composed: false, row: null, clientPath: null, note: null }
      try {
        const registry = typeof options.clientModules === 'function' ? options.clientModules() : undefined
        if (registry === undefined) {
          client.note = '宿主没有 clientModules 服务（客户端面板不可用，页面仍可直接访问）'
        } else if (typeof registry.graph === 'function') {
          const rows = []
          const visit = (value) => {
            if (Array.isArray(value)) {
              for (const item of value) visit(item)
              return
            }
            if (value === null || typeof value !== 'object') return
            if (typeof value.id === 'string' && typeof value.url === 'string') rows.push({ id: value.id, url: value.url, rev: value.rev })
            for (const child of Object.values(value)) visit(child)
          }
          visit(registry.graph())
          const row = rows.find(entry => entry.id === PACKAGE_ID)
          client.composed = row !== undefined
          client.row = row ?? null
          if (typeof registry.clientPath === 'function') client.clientPath = registry.clientPath(PACKAGE_ID) ?? null
          if (row === undefined) client.note = '客户端 bundle 尚未出现在启动图中'
        } else {
          client.note = 'clientModules 未提供 graph()'
        }
      } catch (error) {
        client.note = error instanceof Error ? error.message : String(error)
      }
      return {
        plugin: PACKAGE_ID,
        gitPath,
        roots,
        repo: configuredRepo,
        defaultRepo: resolveDefaultRepo(),
        cwd: process.cwd(),
        workspaceDirs: workspaceDirs(),
        routeCount: routes.length,
        client,
      }
    }),

    get('/dsh-git/api/info', async (query) => ({ info: await info(gitPath, await requestRepo(query.get('repo'))) })),

    get('/dsh-git/api/status', async (query) => {
      const repo = await requestRepo(query.get('repo'))
      const [statusResult, infoResult] = await Promise.all([status(gitPath, repo), info(gitPath, repo)])
      return { repo, status: statusResult, info: infoResult }
    }),

    get('/dsh-git/api/log', async (query) => {
      const repo = await requestRepo(query.get('repo'))
      const result = await log(gitPath, repo, {
        limit: Number(query.get('limit') ?? maxLog),
        skip: Number(query.get('skip') ?? 0),
        ref: query.get('ref') ?? '',
        search: query.get('search') ?? '',
        author: query.get('author') ?? '',
        path: query.get('path') ?? '',
      })
      return { repo, ...result }
    }),

    // One path, two methods: read one commit's detail, or create a commit.
    // The host route table keys on the path alone, so this must stay a single
    // registration.
    route('/dsh-git/api/commit', {
      GET: async (query) => {
        const repo = await requestRepo(query.get('repo'))
        const sha = query.get('sha') ?? ''
        if (sha === '') throw new GitError('缺少 sha 参数')
        return { repo, commit: await commitDetail(gitPath, repo, sha) }
      },
      POST: async (body) => {
        const repo = await requestRepo(body.repo)
        const result = await commit(gitPath, repo, {
          message: body.message,
          amend: body.amend === true,
          all: body.all === true,
          signoff: body.signoff === true,
          noVerify: body.noVerify === true,
          paths: body.paths,
        })
        return { repo, result, status: await status(gitPath, repo) }
      },
    }),

    get('/dsh-git/api/diff', async (query) => {
      const repo = await requestRepo(query.get('repo'))
      return {
        repo,
        diff: await diff(gitPath, repo, {
          scope: query.get('scope') ?? 'worktree',
          path: query.get('path') ?? '',
          sha: query.get('sha') ?? '',
          context: Number(query.get('context') ?? 3),
          stat: query.get('stat') === '1',
        }),
      }
    }),

    get('/dsh-git/api/branches', async (query) => {
      const repo = await requestRepo(query.get('repo'))
      return { repo, branches: await listBranches(gitPath, repo) }
    }),

    post('/dsh-git/api/add', async (body) => {
      const repo = await requestRepo(body.repo)
      const result = await add(gitPath, repo, body.paths)
      return { repo, result, status: await status(gitPath, repo) }
    }),

    post('/dsh-git/api/unstage', async (body) => {
      const repo = await requestRepo(body.repo)
      const result = await unstage(gitPath, repo, body.paths)
      return { repo, result, status: await status(gitPath, repo) }
    }),

    post('/dsh-git/api/discard', async (body) => {
      const repo = await requestRepo(body.repo)
      const result = await discard(gitPath, repo, body.paths)
      return { repo, result, status: await status(gitPath, repo) }
    }),

    post('/dsh-git/api/fetch', async (body) => {
      const repo = await requestRepo(body.repo)
      const result = await fetchRemote(gitPath, repo, { remote: body.remote, branch: body.branch })
      return { repo, result, status: await status(gitPath, repo) }
    }),

    post('/dsh-git/api/pull', async (body) => {
      const repo = await requestRepo(body.repo)
      const result = await pull(gitPath, repo, {
        remote: body.remote,
        branch: body.branch,
        mode: body.mode,
        autostash: body.autostash === true,
      })
      return { repo, result, status: await status(gitPath, repo) }
    }),

    post('/dsh-git/api/push', async (body) => {
      const repo = await requestRepo(body.repo)
      const result = await push(gitPath, repo, {
        remote: body.remote,
        branch: body.branch,
        setUpstream: body.setUpstream === true,
        forceWithLease: body.forceWithLease === true,
        tags: body.tags === true,
        dryRun: body.dryRun === true,
      })
      return { repo, result, status: await status(gitPath, repo) }
    }),

    post('/dsh-git/api/merge', async (body) => {
      const repo = await requestRepo(body.repo)
      const result = await merge(gitPath, repo, {
        ref: body.ref,
        noFf: body.noFf === true,
        ffOnly: body.ffOnly === true,
        squash: body.squash === true,
        noCommit: body.noCommit === true,
        message: body.message,
        abort: body.abort === true,
        continueMerge: body.continueMerge === true,
      })
      return { repo, result, status: await status(gitPath, repo) }
    }),

    post('/dsh-git/api/checkout', async (body) => {
      const repo = await requestRepo(body.repo)
      const result = await checkout(gitPath, repo, body.ref)
      return { repo, result, status: await status(gitPath, repo) }
    }),

    post('/dsh-git/api/branch', async (body) => {
      const repo = await requestRepo(body.repo)
      const result = await createBranch(gitPath, repo, body.name, body.startPoint)
      return { repo, result, status: await status(gitPath, repo) }
    }),

    post('/dsh-git/api/abort', async (body) => {
      const repo = await requestRepo(body.repo)
      const result = await abortOperation(gitPath, repo, body.operation)
      return { repo, result, status: await status(gitPath, repo) }
    }),

    post('/dsh-git/api/identity', async (body) => {
      const repo = await requestRepo(body.repo)
      const result = await setIdentity(gitPath, repo, body.name, body.email)
      return { repo, result, info: await info(gitPath, repo) }
    }),
  ]

  return {
    routes,
    resolveDefaultRepo,
    describe: () => ({ gitPath, roots, repo: configuredRepo, workspaceDirs: workspaceDirs() }),
  }
}
