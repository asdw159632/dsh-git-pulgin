/**
 * dsh-git-plugin — browser app (vanilla DOM, no build step).
 *
 * Talks to the host half over `/dsh-git/api/*`. Everything the user does here
 * maps to exactly one git invocation on the host (see lib/git.js): staging,
 * un-staging, discarding, committing, fetching, pulling, pushing, merging,
 * switching/creating branches and aborting an in-progress merge or rebase.
 */
'use strict'

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

const $ = (selector, root = document) => root.querySelector(selector)
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector))

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key === 'html') node.innerHTML = value
    else if (key === 'value') node.value = String(value)
    else if (key === 'dataset') Object.assign(node.dataset, value)
    else if (key === 'style') Object.assign(node.style, value)
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value)
    else if (value === true) node.setAttribute(key, '')
    else node.setAttribute(key, String(value))
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

const shortTime = (iso) => {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const diff = (Date.now() - date.getTime()) / 1000
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`
  return date.toLocaleDateString()
}

const fullTime = (iso) => {
  if (!iso) return ''
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

const STATUS_TEXT = {
  M: '修改', A: '新增', D: '删除', R: '重命名', C: '复制', T: '类型变更',
  U: '冲突', '?': '未跟踪', '!': '忽略', '.': '',
}

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

const store = {
  get(key, fallback) {
    try {
      const value = window.localStorage.getItem(key)
      return value === null ? fallback : value
    } catch {
      return fallback
    }
  },
  set(key, value) {
    try {
      window.localStorage.setItem(key, value)
    } catch {
      /* private mode */
    }
  },
}

const state = {
  repo: null,
  info: null,
  status: null,
  branches: [],
  commits: [],
  hasMore: false,
  skipped: 0,
  limit: 80,
  logQuery: { ref: '', search: '', path: '' },
  selectedCommit: null,
  commitDetail: null,
  selectedFiles: new Set(),
  selectedDiff: null,
  loading: false,
  lastOutput: null,
  error: null,
}

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */

async function apiGet(path, params = {}) {
  const url = new URL(path, window.location.origin)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value) !== '') url.searchParams.set(key, String(value))
  }
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }))
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error || `HTTP ${response.status}`)
    error.payload = payload
    throw error
  }
  return payload
}

async function apiPost(path, body = {}) {
  const response = await fetch(new URL(path, window.location.origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo: state.repo, ...body }),
  })
  const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }))
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error || `HTTP ${response.status}`)
    error.payload = payload
    throw error
  }
  return payload
}

/* ------------------------------------------------------------------ *
 * chrome: banner, toast, busy
 * ------------------------------------------------------------------ */

let toastTimer = null

function toast(message, kind = 'ok', ms = 4000) {
  const node = $('#toast')
  node.textContent = message
  node.className = `toast ${kind}`
  node.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { node.hidden = true }, ms)
}

function setBusy(on, text = '处理中…') {
  $('#busy').hidden = !on
  $('#busy-text').textContent = text
}

function setBanner() {
  const node = $('#banner')
  const parts = []
  const status = state.status
  const info = state.info

  if (state.error) {
    parts.push(el('div', { class: 'row', style: { flexBasis: '100%' } }, [
      el('span', { text: `⚠ ${state.error.message}` }),
      el('button', { class: 'btn small close', text: '关闭', onclick: () => { state.error = null; setBanner() } }),
    ]))
    if (state.error.detail) parts.push(el('pre', { text: state.error.detail }))
  }

  if (status) {
    const active = Object.entries(status.state ?? {}).filter(([, value]) => value).map(([key]) => key)
    if (active.length > 0) {
      const labels = { merging: '合并中', rebasing: '变基中', cherryPicking: '拣选中', reverting: '回滚中', bisecting: '二分查找中' }
      parts.push(el('div', { class: 'row', style: { flexBasis: '100%' } }, [
        el('span', { text: `⚠ 仓库处于「${active.map(key => labels[key] ?? key).join('、')}」状态，请解决冲突后提交，或中止操作。` }),
        ...active.map(kind => el('button', {
          class: 'btn small',
          text: `中止${labels[kind] ?? kind}`,
          onclick: () => runAction(`中止${labels[kind] ?? kind}`, () => apiPost('/dsh-git/api/abort', {
            operation: kind === 'merging' ? 'merge' : kind === 'cherryPicking' ? 'cherry-pick' : kind === 'reverting' ? 'revert' : 'rebase',
          })),
        })),
      ]))
      const conflicted = (status.entries ?? []).filter(entry => entry.conflicted)
      if (conflicted.length > 0) {
        parts.push(el('div', { class: 'row', style: { flexBasis: '100%' } }, [
          el('span', { text: `冲突文件 ${conflicted.length} 个：` }),
          el('code', { text: conflicted.map(entry => entry.path).join('，') }),
          el('button', { class: 'btn small', text: '全部标记为已解决（暂存）', onclick: () => runAction('标记冲突已解决', () => apiPost('/dsh-git/api/add', { paths: [] })) }),
        ]))
      }
    }
  }

  if (info && state.branches.length === 0) {
    parts.push(el('div', { text: '提示：先在上方选择一个仓库（或填写绝对路径后点「打开」）。' }))
  }

  if (state.lastOutput) {
    parts.push(el('details', { style: { flexBasis: '100%' } }, [
      el('summary', { text: '上一次操作输出', style: { cursor: 'pointer', color: 'var(--text-dim)' } }),
      el('pre', { text: state.lastOutput }),
    ]))
  }

  node.hidden = parts.length === 0
  node.className = `banner ${state.error ? 'error' : ''}`
  node.replaceChildren(...parts)
}

/* ------------------------------------------------------------------ *
 * theme: copy the shell's tokens into this document when embedded
 * ------------------------------------------------------------------ */

function syncHostTheme() {
  const params = new URLSearchParams(window.location.search)
  const requested = params.get('theme')
  if (requested === 'light' || requested === 'dark') document.documentElement.dataset.theme = requested
  if (params.get('embed') === '1') document.body.classList.add('embed')
  try {
    if (window.parent === window) return
    const parentRoot = window.parent.document.documentElement
    const computed = window.parent.getComputedStyle(parentRoot)
    if (!document.documentElement.dataset.theme) {
      const scheme = window.parent.getComputedStyle(window.parent.document.body).colorScheme
      if (scheme === 'light' || scheme === 'dark') document.documentElement.dataset.theme = scheme
    }
    const names = [
      '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-3',
      '--dsw-alias-border-default', '--dsw-alias-border-l1', '--dsw-alias-border-l2',
      '--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-label-tertiary',
      '--dsw-alias-brand-primary', '--dsw-alias-state-error-primary', '--dsw-alias-state-success-primary',
      '--dsw-alias-state-warn-primary', '--dsw-alias-font-mono', '--dsw-alias-font-sans',
    ]
    const found = {}
    for (const name of names) {
      const value = computed.getPropertyValue(name)
      if (value && value.trim() !== '') found[name] = value.trim()
    }
    if (found['--dsw-alias-bg-layer-2']) {
      document.documentElement.style.setProperty('--bg', found['--dsw-alias-bg-layer-2'])
      document.documentElement.style.setProperty('--bg-2', found['--dsw-alias-bg-layer-2'])
    }
    if (found['--dsw-alias-bg-layer-1']) document.documentElement.style.setProperty('--bg', found['--dsw-alias-bg-layer-1'])
    if (found['--dsw-alias-bg-layer-3']) document.documentElement.style.setProperty('--bg-3', found['--dsw-alias-bg-layer-3'])
    if (found['--dsw-alias-border-default']) document.documentElement.style.setProperty('--border', found['--dsw-alias-border-default'])
    if (found['--dsw-alias-border-l2']) document.documentElement.style.setProperty('--border-soft', found['--dsw-alias-border-l2'])
    if (found['--dsw-alias-label-primary']) document.documentElement.style.setProperty('--text', found['--dsw-alias-label-primary'])
    if (found['--dsw-alias-label-secondary']) document.documentElement.style.setProperty('--text-dim', found['--dsw-alias-label-secondary'])
    if (found['--dsw-alias-label-tertiary']) document.documentElement.style.setProperty('--text-faint', found['--dsw-alias-label-tertiary'])
    if (found['--dsw-alias-brand-primary']) document.documentElement.style.setProperty('--accent', found['--dsw-alias-brand-primary'])
    if (found['--dsw-alias-state-error-primary']) document.documentElement.style.setProperty('--red', found['--dsw-alias-state-error-primary'])
    if (found['--dsw-alias-state-success-primary']) document.documentElement.style.setProperty('--green', found['--dsw-alias-state-success-primary'])
    if (found['--dsw-alias-state-warn-primary']) document.documentElement.style.setProperty('--yellow', found['--dsw-alias-state-warn-primary'])
    if (found['--dsw-alias-font-mono']) document.documentElement.style.setProperty('--mono', found['--dsw-alias-font-mono'])
  } catch {
    /* cross-origin or a bare host: keep the local palette */
  }
}

/* ------------------------------------------------------------------ *
 * repository selection
 * ------------------------------------------------------------------ */

async function loadRepoList() {
  const payload = await apiGet('/dsh-git/api/repos')
  const select = $('#repo-select')
  const options = []
  if (payload.repos.length === 0) options.push(el('option', { value: '', text: '（未发现仓库）' }))
  for (const repo of payload.repos) options.push(el('option', { value: repo, text: repo }))
  select.replaceChildren(...options)
  if (state.repo !== null && !payload.repos.includes(state.repo)) {
    select.append(el('option', { value: state.repo, text: state.repo }))
  }
  if (state.repo === null && payload.defaultRepo) state.repo = payload.defaultRepo
  if (state.repo !== null) {
    select.value = state.repo
    $('#repo-input').value = state.repo
  }
  if (state.repo === null && payload.gitPath) {
    state.error = { message: `未找到 git 仓库（git 可执行文件：${payload.gitPath}）。请在上方填写仓库路径后点「打开」。` }
  }
  return payload
}

async function openRepo(path) {
  const target = (path ?? '').trim()
  if (target === '') {
    toast('请先填写仓库绝对路径', 'error')
    return
  }
  state.repo = target
  store.set('dsh-git.repo', target)
  state.selectedCommit = null
  state.commitDetail = null
  state.selectedDiff = null
  state.selectedFiles.clear()
  await refreshAll()
}

/* ------------------------------------------------------------------ *
 * refresh
 * ------------------------------------------------------------------ */

async function refreshAll(options = {}) {
  if (state.repo === null) {
    setBanner()
    return
  }
  setBusy(true, '读取仓库…')
  try {
    const [statusPayload, logPayload, branchPayload] = await Promise.all([
      apiGet('/dsh-git/api/status', { repo: state.repo }),
      apiGet('/dsh-git/api/log', { repo: state.repo, ...state.logQuery, limit: state.limit, skip: 0 }),
      apiGet('/dsh-git/api/branches', { repo: state.repo }),
    ])
    state.info = statusPayload.info
    state.status = statusPayload.status
    state.repo = statusPayload.repo
    state.commits = logPayload.commits
    state.hasMore = logPayload.hasMore
    state.skipped = logPayload.commits.length
    state.branches = branchPayload.branches
    state.error = null
    if (options.keepSelection !== true) {
      state.selectedCommit = null
      state.commitDetail = null
      state.selectedDiff = null
    }
    renderAll()
  } catch (error) {
    state.error = { message: error.message, detail: error.payload?.stderr }
    setBanner()
    renderMeta()
  } finally {
    setBusy(false)
  }
}

async function refreshQuiet() {
  if (state.repo === null || state.loading) return
  try {
    const payload = await apiGet('/dsh-git/api/status', { repo: state.repo })
    state.status = payload.status
    state.info = payload.info
    renderMeta()
    renderChanges()
    renderBannerOnly()
  } catch {
    /* a quiet refresh never reports */
  }
}

async function loadMoreCommits() {
  setBusy(true, '加载历史…')
  try {
    const payload = await apiGet('/dsh-git/api/log', {
      repo: state.repo,
      ...state.logQuery,
      limit: state.limit,
      skip: state.skipped,
    })
    state.commits = state.commits.concat(payload.commits)
    state.hasMore = payload.hasMore
    state.skipped = state.commits.length
    renderGraph()
  } catch (error) {
    toast(`加载失败：${error.message}`, 'error')
  } finally {
    setBusy(false)
  }
}

/* ------------------------------------------------------------------ *
 * commit graph layout
 * ------------------------------------------------------------------ */

const LANE_W = 14
const ROW_H = 38
const LANE_COLORS = ['#4c8dff', '#3fb950', '#d29922', '#bc8cff', '#39c5cf', '#f85149', '#db6d28', '#8b949e']

const laneColor = (lane) => LANE_COLORS[lane % LANE_COLORS.length]

function layoutGraph(commits) {
  const lanes = []
  const laneOf = new Map()
  const rows = []
  let maxLane = 0
  for (const commit of commits) {
    let lane = lanes.indexOf(commit.sha)
    if (lane === -1) {
      const free = lanes.indexOf(null)
      if (free === -1) {
        lanes.push(commit.sha)
        lane = lanes.length - 1
      } else {
        lanes[free] = commit.sha
        lane = free
      }
    }
    const before = lanes.slice()
    const [first, ...rest] = commit.parents
    lanes[lane] = first ?? null
    for (const parent of rest) {
      if (lanes.includes(parent)) continue
      const free = lanes.indexOf(null)
      if (free === -1) lanes.push(parent)
      else lanes[free] = parent
    }
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop()
    const after = lanes.slice()
    laneOf.set(commit.sha, lane)
    rows.push({ commit, lane, before, after, edges: [] })
    maxLane = Math.max(maxLane, lane, before.length - 1, after.length - 1)
  }
  for (const row of rows) {
    row.edges = row.commit.parents.map(parent => ({
      to: laneOf.has(parent) ? laneOf.get(parent) : row.lane,
      known: laneOf.has(parent),
    }))
  }
  return { rows, maxLane: Math.max(maxLane, 0) }
}

const x = (lane) => lane * LANE_W + LANE_W / 2 + 2

function graphSvg(row, width) {
  const namespace = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(namespace, 'svg')
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(ROW_H))
  svg.setAttribute('aria-hidden', 'true')
  const mid = ROW_H / 2
  const line = (x1, y1, x2, y2, color, key) => {
    const path = document.createElementNS(namespace, 'path')
    const d = Math.abs(y2 - mid) < 0.01 && Math.abs(y1 - mid) < 0.01
      ? `M ${x1} ${y1} L ${x2} ${y2}`
      : `M ${x1} ${y1} C ${x1} ${y1 + (y2 - y1) * 0.45}, ${x2} ${y2 - (y2 - y1) * 0.45}, ${x2} ${y2}`
    path.setAttribute('d', d)
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke', color)
    path.setAttribute('stroke-width', '1.6')
    path.setAttribute('stroke-linecap', 'round')
    if (key) path.setAttribute('opacity', '0.9')
    svg.append(path)
  }
  row.before.forEach((sha, lane) => {
    if (sha === null) return
    line(x(lane), 0, x(lane), mid, laneColor(lane), false)
  })
  const covered = new Set()
  for (const edge of row.edges) {
    line(x(row.lane), mid, x(edge.to), ROW_H, laneColor(row.lane))
    covered.add(edge.to)
  }
  row.after.forEach((sha, lane) => {
    if (sha === null || covered.has(lane)) return
    line(x(lane), mid, x(lane), ROW_H, laneColor(lane), false)
  })
  const dot = document.createElementNS(namespace, 'circle')
  dot.setAttribute('cx', String(x(row.lane)))
  dot.setAttribute('cy', String(mid))
  dot.setAttribute('r', '3.8')
  dot.setAttribute('fill', laneColor(row.lane))
  svg.append(dot)
  return svg
}

function renderGraph() {
  const { rows, maxLane } = layoutGraph(state.commits)
  const width = (maxLane + 1) * LANE_W + 6
  const container = $('#graph')
  const nodes = rows.map((row) => {
    const commit = row.commit
    const refNodes = (commit.refs ?? []).map((ref) => {
      const kind = ref.kind === 'head' ? 'head' : ref.kind === 'remote' ? 'remote' : ref.kind === 'tag' ? 'tag' : 'branch'
      return el('span', { class: `ref ${kind}`, text: ref.name })
    })
    const text = el('div', { class: 'ctext' }, [
      el('div', { class: 'csubject' }, [
        refNodes.length > 0 ? el('span', { class: 'refs' }, refNodes) : null,
        el('span', { text: commit.subject || '(无提交信息)' }),
      ]),
      el('div', { class: 'cmeta' }, [
        el('span', { text: commit.author }),
        el('span', { text: shortTime(commit.authoredAt), title: fullTime(commit.authoredAt) }),
        el('span', { class: 'sha', text: commit.short }),
      ]),
    ])
    const rowNode = el('div', {
      class: `crow${state.selectedCommit === commit.sha ? ' selected' : ''}`,
      dataset: { sha: commit.sha },
      onclick: () => selectCommit(commit.sha),
    }, [graphSvg(row, width), text])
    return rowNode
  })
  if (nodes.length === 0) nodes.push(el('div', { class: 'diff-empty', text: '没有匹配的提交。' }))
  container.replaceChildren(...nodes)
  $('#btn-log-more').hidden = !state.hasMore
}

/* ------------------------------------------------------------------ *
 * meta bar
 * ------------------------------------------------------------------ */

function renderMeta() {
  const node = $('#repo-meta')
  const info = state.info
  if (info === null) {
    node.replaceChildren(el('span', { class: 'muted', text: state.error?.message ?? '未选择仓库' }))
    return
  }
  const status = state.status ?? { entries: [] }
  const dirty = (status.entries ?? []).filter(entry => entry.kind !== 'ignored')
  const branchSelect = el('select', {
    title: '切换本地分支',
    onchange: (event) => runAction(`切换到 ${event.target.value}`, () => apiPost('/dsh-git/api/checkout', { ref: event.target.value })),
  }, state.branches.filter(branch => !branch.remote).map(branch => el('option', {
    value: branch.name,
    text: branch.name,
    selected: branch.current,
  })))
  branchSelect.value = info.branch

  const parts = [
    el('strong', { text: info.name, title: info.repo }),
    branchSelect,
    info.detached ? el('span', { class: 'ref tag', text: 'detached HEAD' }) : null,
    info.unborn ? el('span', { class: 'ref', text: '尚无提交' }) : null,
    info.upstream ? el('span', { class: 'muted', text: `↔ ${info.upstream}` }) : el('span', { class: 'muted', text: '（无上游）' }),
    info.ahead > 0 ? el('span', { class: 'ref branch', text: `领先 ${info.ahead}` }) : null,
    info.behind > 0 ? el('span', { class: 'ref tag', text: `落后 ${info.behind}` }) : null,
    el('span', { class: 'muted', text: `变更 ${dirty.length}` }),
    info.stashCount > 0 ? el('span', { class: 'muted', text: `stash ${info.stashCount}` }) : null,
    el('span', { class: 'muted', text: `提交 ${info.commitCount}` }),
    el('span', { class: 'muted', text: `远程 ${info.remotes.map(remote => remote.name).join('、') || '无'}` }),
    info.user.name ? el('span', { class: 'muted', text: `身份 ${info.user.name} <${info.user.email}>` })
      : el('button', { class: 'btn small', text: '设置提交身份…', onclick: openIdentityModal }),
  ]
  node.replaceChildren(...parts.filter(Boolean))
}

/* ------------------------------------------------------------------ *
 * changes pane
 * ------------------------------------------------------------------ */

function fileRow(entry, scope) {
  const checkbox = el('input', {
    type: 'checkbox',
    checked: state.selectedFiles.has(entry.path),
    onclick: (event) => {
      event.stopPropagation()
      if (event.target.checked) state.selectedFiles.add(entry.path)
      else state.selectedFiles.delete(entry.path)
    },
  })
  const code = entry.conflicted ? 'U' : (scope === 'staged' ? entry.index : entry.worktree)
  const label = `${STATUS_TEXT[code] ?? code}`
  return el('div', { class: 'file', dataset: { path: entry.path }, onclick: () => selectDiff(scope, entry.path) }, [
    checkbox,
    el('span', { class: 'code', text: `${code}`, title: label }),
    el('span', { class: 'path', title: entry.path }, [el('span', { text: entry.path })]),
    entry.origPath ? el('span', { class: 'orig', text: `← ${entry.origPath}` }) : null,
  ])
}

function renderChanges() {
  const container = $('#changes-list')
  const entries = (state.status?.entries ?? []).filter(entry => entry.kind !== 'ignored')
  $('#changes-count').textContent = String(entries.length)
  const nodes = []
  const staged = entries.filter(entry => entry.staged)
  const conflicted = entries.filter(entry => entry.conflicted)
  const unstaged = entries.filter(entry => entry.unstaged && !entry.conflicted)
  const untracked = entries.filter(entry => entry.kind === 'untracked')

  if (conflicted.length > 0) {
    nodes.push(el('div', { class: 'group-title', text: `冲突（${conflicted.length}）` }))
    for (const entry of conflicted) nodes.push(fileRow(entry, 'worktree'))
  }
  if (staged.length > 0) {
    nodes.push(el('div', { class: 'group-title', text: `已暂存（${staged.length}）` }))
    for (const entry of staged) nodes.push(fileRow(entry, 'staged'))
  }
  const rest = unstaged.filter(entry => entry.kind !== 'untracked')
  if (rest.length > 0) {
    nodes.push(el('div', { class: 'group-title', text: `未暂存（${rest.length}）` }))
    for (const entry of rest) nodes.push(fileRow(entry, 'worktree'))
  }
  if (untracked.length > 0) {
    nodes.push(el('div', { class: 'group-title', text: `未跟踪（${untracked.length}）` }))
    for (const entry of untracked) nodes.push(fileRow(entry, 'worktree'))
  }
  if (nodes.length === 0) nodes.push(el('div', { class: 'diff-empty', text: '工作区干净，没有需要处理的变更。' }))
  container.replaceChildren(...nodes)
}

/* ------------------------------------------------------------------ *
 * detail pane
 * ------------------------------------------------------------------ */

function renderDiff(text, extra) {
  const wrapper = el('div')
  if (extra) wrapper.append(el('div', { class: 'diff-note', text: extra }))
  if (!text || text.trim() === '') {
    wrapper.append(el('div', { class: 'diff-empty', text: '没有差异。' }))
    return wrapper
  }
  const pre = el('pre', { class: 'diff' })
  const lines = text.split('\n')
  const capped = lines.slice(0, 6000)
  for (const line of capped) {
    let kind = 'ctx'
    if (line.startsWith('@@')) kind = 'hunk'
    else if (line.startsWith('+++') || line.startsWith('---')) kind = 'meta'
    else if (/^(diff --git|index |new file|deleted file|similarity |rename |old mode|new mode|Binary files)/.test(line)) kind = 'meta'
    else if (line.startsWith('+')) kind = 'add'
    else if (line.startsWith('-')) kind = 'del'
    else if (line.startsWith('\\')) kind = 'meta'
    pre.append(el('span', { class: `dl ${kind}`, text: line === '' ? ' ' : line }))
  }
  if (lines.length > capped.length) {
    pre.append(el('span', { class: 'dl meta', text: `… 还有 ${lines.length - capped.length} 行未显示` }))
  }
  wrapper.append(pre)
  return wrapper
}

function renderDetail() {
  const node = $('#detail')
  if (state.selectedDiff !== null) {
    const head = el('div', { class: 'detail-head' }, [
      el('div', { class: 'detail-subject', text: state.selectedDiff.title }),
      el('div', { class: 'kv' }, [
        el('b', { text: '范围' }), el('span', { text: state.selectedDiff.scopeText }),
        el('b', { text: '文件' }), el('code', { class: 'sha', text: state.selectedDiff.path ?? '(全部)' }),
      ]),
    ])
    node.replaceChildren(head, renderDiff(state.selectedDiff.text, state.selectedDiff.truncated ? '差异过大，已截断显示。' : null))
    return
  }
  if (state.commitDetail === null) {
    node.replaceChildren(el('div', { class: 'detail-empty muted', text: '选择左侧的一次提交或一个文件，这里显示详情与差异。' }))
    return
  }
  const commit = state.commitDetail
  const refNodes = (commit.refs ?? []).map((ref) => el('span', {
    class: `ref ${ref.kind === 'head' ? 'head' : ref.kind === 'remote' ? 'remote' : ref.kind === 'tag' ? 'tag' : 'branch'}`,
    text: ref.name,
  }))
  const head = el('div', { class: 'detail-head' }, [
    el('div', { class: 'refs' }, refNodes),
    el('div', { class: 'detail-subject', text: commit.subject || '(无提交信息)' }),
    el('div', { class: 'kv' }, [
      el('b', { text: '提交' }), el('span', { class: 'sha', text: commit.sha }),
      el('b', { text: '作者' }), el('span', { text: `${commit.author} <${commit.authorEmail}>` }),
      el('b', { text: '时间' }), el('span', { text: fullTime(commit.authoredAt) }),
      el('b', { text: '父提交' }), el('span', { class: 'sha', text: commit.parents.map(parent => parent.slice(0, 8)).join(' ') || '(根提交)' }),
    ]),
    el('div', { class: 'row', style: { marginTop: '6px' } }, [
      el('button', { class: 'btn small', text: '复制完整 SHA', onclick: () => { navigator.clipboard?.writeText(commit.sha); toast('已复制') } }),
    ]),
  ])
  const nodes = [head]
  if (commit.files.length > 0) {
    nodes.push(el('div', { class: 'files-head', text: `变更文件（${commit.files.length}）` }))
    for (const file of commit.files) {
      nodes.push(el('div', {
        class: 'file',
        onclick: () => selectDiff('commit', file.path, commit.sha, `${commit.short} · ${file.path}`),
      }, [
        el('span', { class: 'code', text: STATUS_TEXT[file.status] ?? file.status, title: file.status }),
        el('span', { class: 'path', title: file.path }, [el('span', { text: file.path })]),
        file.origPath ? el('span', { class: 'orig', text: `← ${file.origPath}` }) : null,
      ]))
    }
  }
  nodes.push(renderDiff(commit.diffText ?? '', commit.diffTruncated ? '差异过大，已截断显示。' : null))
  node.replaceChildren(...nodes)
}

async function selectCommit(sha) {
  state.selectedCommit = sha
  state.selectedDiff = null
  renderGraph()
  setBusy(true, '读取提交…')
  try {
    const [detail, diff] = await Promise.all([
      apiGet('/dsh-git/api/commit', { repo: state.repo, sha }),
      apiGet('/dsh-git/api/diff', { repo: state.repo, scope: 'commit', sha }),
    ])
    state.commitDetail = detail.commit
    state.commitDetail.diffText = diff.diff.text
    state.commitDetail.diffTruncated = diff.diff.truncated
    renderDetail()
  } catch (error) {
    state.error = { message: `读取提交失败：${error.message}`, detail: error.payload?.stderr }
    setBanner()
  } finally {
    setBusy(false)
  }
}

async function selectDiff(scope, path, sha, title) {
  setBusy(true, '读取差异…')
  try {
    const payload = await apiGet('/dsh-git/api/diff', {
      repo: state.repo,
      scope,
      path,
      sha: sha ?? '',
      context: 3,
    })
    state.selectedDiff = {
      scope,
      path,
      text: payload.diff.text,
      truncated: payload.diff.truncated,
      title: title ?? path,
      scopeText: scope === 'staged' ? '已暂存的改动（git diff --cached）' : scope === 'commit' ? '提交差异' : '工作区改动（git diff）',
    }
    renderDetail()
  } catch (error) {
    toast(`读取差异失败：${error.message}`, 'error')
  } finally {
    setBusy(false)
  }
}

/* ------------------------------------------------------------------ *
 * modal
 * ------------------------------------------------------------------ */

let modalSubmit = null

function closeModal() {
  $('#modal-backdrop').hidden = true
  $('#modal-error').textContent = ''
  $('#modal-body').replaceChildren()
  modalSubmit = null
}

function openModal({ title, fields, submitText = '确定', onSubmit }) {
  $('#modal-title').textContent = title
  $('#modal-ok').textContent = submitText
  $('#modal-error').textContent = ''
  const body = $('#modal-body')
  body.replaceChildren(...fields.map(field => {
    if (field.type === 'checkbox') {
      return el('label', { class: 'inline' }, [
        el('input', { type: 'checkbox', id: `f-${field.name}`, checked: field.value === true }),
        field.label,
      ])
    }
    if (field.type === 'select') {
      return el('div', { class: 'field' }, [
        el('label', { text: field.label }),
        el('select', { id: `f-${field.name}` }, field.options.map(option => el('option', {
          value: option.value,
          text: option.text,
          selected: option.value === field.value,
        }))),
      ])
    }
    if (field.type === 'textarea') {
      return el('div', { class: 'field' }, [
        el('label', { text: field.label }),
        el('textarea', { id: `f-${field.name}`, rows: 3, placeholder: field.placeholder ?? '', value: field.value ?? '' }),
      ])
    }
    return el('div', { class: 'field' }, [
      el('label', { text: field.label }),
      el('input', { type: field.type ?? 'text', id: `f-${field.name}`, placeholder: field.placeholder ?? '', value: field.value ?? '' }),
      field.hint ? el('div', { class: 'hint', text: field.hint }) : null,
    ])
  }))
  modalSubmit = async () => {
    const values = {}
    for (const field of fields) {
      const input = $(`#f-${field.name}`)
      values[field.name] = field.type === 'checkbox' ? input.checked : input.value
    }
    return onSubmit(values)
  }
  $('#modal-backdrop').hidden = false
  const first = body.querySelector('input, select, textarea')
  if (first) first.focus()
}

async function confirmModal() {
  if (modalSubmit === null) return
  const button = $('#modal-ok')
  button.disabled = true
  try {
    const error = await modalSubmit()
    if (error) {
      $('#modal-error').textContent = error
      return
    }
    closeModal()
  } finally {
    button.disabled = false
  }
}

async function openMergeModal() {
  const localAndRemote = state.branches.map(branch => ({
    value: branch.name,
    text: branch.remote ? `${branch.name}（远程）` : branch.name,
  }))
  openModal({
    title: '合并分支 / 提交',
    submitText: '合并',
    fields: [
      { name: 'ref', label: '要合并进来的分支或提交', type: 'select', options: [{ value: '', text: '（请选择）' }, ...localAndRemote] },
      { name: 'message', label: '合并提交信息（可选）', placeholder: `Merge branch 'xxx'` },
      { name: 'noFf', label: '始终创建合并提交（--no-ff）', type: 'checkbox', value: true },
      { name: 'ffOnly', label: '只允许快进（--ff-only）', type: 'checkbox' },
      { name: 'noCommit', label: '合并后不自动提交（--no-commit）', type: 'checkbox' },
    ],
    onSubmit: async (values) => {
      if (values.ref === '') return '请选择要合并的分支'
      try {
        await runAction(`合并 ${values.ref}`, () => apiPost('/dsh-git/api/merge', {
          ref: values.ref,
          message: values.message,
          noFf: values.noFf,
          ffOnly: values.ffOnly,
          noCommit: values.noCommit,
        }))
        return null
      } catch (error) {
        return error.message
      }
    },
  })
}

function openBranchModal() {
  openModal({
    title: '新建分支',
    submitText: '创建并切换',
    fields: [
      { name: 'name', label: '分支名', placeholder: 'feature/xxx' },
      { name: 'startPoint', label: '起点（可选）', placeholder: 'HEAD / 某分支 / 某提交', value: state.info?.branch ?? '' },
    ],
    onSubmit: async (values) => {
      if (values.name.trim() === '') return '请输入分支名'
      try {
        await runAction(`新建分支 ${values.name}`, () => apiPost('/dsh-git/api/branch', { name: values.name, startPoint: values.startPoint }))
        return null
      } catch (error) {
        return error.message
      }
    },
  })
}

function openIdentityModal() {
  openModal({
    title: '设置提交身份（写入本仓库 .git/config）',
    submitText: '保存',
    fields: [
      { name: 'name', label: 'user.name', value: state.info?.user?.name ?? '' },
      { name: 'email', label: 'user.email', value: state.info?.user?.email ?? '' },
    ],
    onSubmit: async (values) => {
      try {
        await runAction('设置提交身份', () => apiPost('/dsh-git/api/identity', { name: values.name, email: values.email }))
        return null
      } catch (error) {
        return error.message
      }
    },
  })
}

/* ------------------------------------------------------------------ *
 * actions
 * ------------------------------------------------------------------ */

function captureOutput(payload) {
  const output = payload?.result?.output ?? payload?.result?.summary
  state.lastOutput = typeof output === 'string' && output.trim() !== '' ? output.trim() : null
}

async function runAction(label, work, options = {}) {
  state.loading = true
  setBusy(true, label)
  try {
    const payload = await work()
    captureOutput(payload)
    state.error = null
    toast(`${label}：完成`, 'ok', 2500)
    if (options.refresh !== false) await refreshAll({ keepSelection: options.keepSelection !== false })
    return payload
  } catch (error) {
    state.error = { message: `${label}失败：${error.message}`, detail: error.payload?.stderr ?? error.payload?.hint }
    setBanner()
    toast(`${label}失败`, 'error', 5000)
    throw error
  } finally {
    state.loading = false
    setBusy(false)
  }
}

function selectedPaths() {
  return $$('#changes-list input[type=checkbox]:checked')
    .map(input => input.closest('.file')?.dataset.path)
    .filter((path) => typeof path === 'string' && path !== '')
}

function primaryRemote() {
  return state.info?.remotes?.[0]?.name ?? 'origin'
}

async function doCommit() {
  const message = $('#commit-message').value
  const amend = $('#commit-amend').checked
  const all = $('#commit-all').checked
  if (message.trim() === '' && !amend) {
    toast('请填写提交信息', 'error')
    return
  }
  if (message.trim() === '' && amend) {
    try {
      await apiPost('/dsh-git/api/commit', { amend: true, message: '' })
      toast('已 amend（沿用原提交信息）', 'ok')
      await refreshAll()
      return
    } catch (error) {
      state.error = { message: `amend 失败：${error.message}`, detail: error.payload?.stderr }
      setBanner()
      return
    }
  }
  await runAction('提交', () => apiPost('/dsh-git/api/commit', { message, amend, all }))
  $('#commit-message').value = ''
  $('#commit-amend').checked = false
  $('#commit-all').checked = false
}

const actionHandlers = {
  'stage-selected': () => {
    const paths = selectedPaths()
    if (paths.length === 0) return toast('请先勾选文件', 'error')
    return runAction(`暂存 ${paths.length} 个文件`, () => apiPost('/dsh-git/api/add', { paths }))
  },
  'unstage-selected': () => {
    const paths = selectedPaths()
    if (paths.length === 0) return toast('请先勾选文件', 'error')
    return runAction(`取消暂存 ${paths.length} 个文件`, () => apiPost('/dsh-git/api/unstage', { paths }))
  },
  'discard-selected': () => {
    const paths = selectedPaths()
    if (paths.length === 0) return toast('请先勾选文件', 'error')
    if (!window.confirm(`确定丢弃选中的 ${paths.length} 个文件的改动吗？\n未跟踪的文件将被删除，此操作不可撤销。`)) return undefined
    return runAction('丢弃改动', () => apiPost('/dsh-git/api/discard', { paths }))
  },
  'stage-all': () => runAction('全部暂存', () => apiPost('/dsh-git/api/add', { paths: [] })),
  'unstage-all': () => runAction('全部取消暂存', () => apiPost('/dsh-git/api/unstage', { paths: [] })),
  fetch: () => runAction('抓取', () => apiPost('/dsh-git/api/fetch', { remote: primaryRemote() })),
  pull: () => runAction('拉取', () => apiPost('/dsh-git/api/pull', {
    remote: primaryRemote(),
    branch: state.info?.branch,
    mode: $('#pull-rebase').checked ? 'rebase' : 'merge',
  })),
  push: () => {
    const branch = state.info?.detached ? undefined : state.info?.branch
    return runAction('推送', () => apiPost('/dsh-git/api/push', {
      remote: primaryRemote(),
      branch,
      setUpstream: !state.info?.upstream && branch !== undefined,
      forceWithLease: $('#push-force').checked,
    }))
  },
  merge: () => openMergeModal(),
  branch: () => openBranchModal(),
}

/* ------------------------------------------------------------------ *
 * events and boot
 * ------------------------------------------------------------------ */

function renderBannerOnly() {
  setBanner()
}

function renderAll() {
  renderMeta()
  renderGraph()
  renderChanges()
  renderDetail()
  setBanner()
}

function switchTab(name) {
  for (const tab of $$('.tab')) tab.classList.toggle('active', tab.dataset.tab === name)
  $('#pane-history').hidden = name !== 'history'
  $('#pane-changes').hidden = name !== 'changes'
}

function setupSplitter() {
  const splitter = $('#splitter')
  const left = $('.col.left')
  let dragging = false
  splitter.addEventListener('mousedown', () => {
    dragging = true
    document.body.style.cursor = 'col-resize'
  })
  window.addEventListener('mousemove', (event) => {
    if (!dragging) return
    const layout = $('.layout').getBoundingClientRect()
    const ratio = Math.min(Math.max((event.clientX - layout.left) / layout.width, 0.25), 0.8)
    left.style.flex = `1 1 ${(ratio * 100).toFixed(1)}%`
  })
  window.addEventListener('mouseup', () => {
    dragging = false
    document.body.style.cursor = ''
  })
}

let autoRefreshTimer = null

function setupAutoRefresh() {
  const toggle = $('#auto-refresh')
  toggle.checked = store.get('dsh-git.autoRefresh', '0') === '1'
  const apply = () => {
    store.set('dsh-git.autoRefresh', toggle.checked ? '1' : '0')
    clearInterval(autoRefreshTimer)
    if (toggle.checked) autoRefreshTimer = setInterval(refreshQuiet, 10_000)
  }
  toggle.addEventListener('change', apply)
  apply()
}

function bindEvents() {
  $('#repo-open').addEventListener('click', () => openRepo($('#repo-input').value))
  $('#repo-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') openRepo($('#repo-input').value)
  })
  $('#repo-select').addEventListener('change', (event) => {
    $('#repo-input').value = event.target.value
    openRepo(event.target.value)
  })
  $('#btn-refresh').addEventListener('click', () => refreshAll({ keepSelection: true }))
  $('#btn-log-apply').addEventListener('click', () => {
    state.logQuery = {
      ref: $('#log-ref').value,
      search: $('#log-search').value,
      path: $('#log-path').value,
    }
    refreshAll()
  })
  $('#log-search').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('#btn-log-apply').click() })
  $('#log-path').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('#btn-log-apply').click() })
  $('#btn-log-more').addEventListener('click', loadMoreCommits)
  $('#btn-commit').addEventListener('click', doCommit)
  $('#commit-message').addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') doCommit()
  })
  $('#select-all').addEventListener('change', (event) => {
    for (const checkbox of $$('#changes-list input[type=checkbox]')) checkbox.checked = event.target.checked
    state.selectedFiles.clear()
    if (event.target.checked) {
      for (const row of $$('#changes-list .file')) state.selectedFiles.add(row.dataset.path)
    }
  })
  for (const tab of $$('.tab')) tab.addEventListener('click', () => switchTab(tab.dataset.tab))
  for (const button of $$('[data-act]')) {
    button.addEventListener('click', () => {
      const handler = actionHandlers[button.dataset.act]
      if (handler) Promise.resolve(handler()).catch(() => {})
    })
  }
  $('#modal-close').addEventListener('click', closeModal)
  $('#modal-cancel').addEventListener('click', closeModal)
  $('#modal-ok').addEventListener('click', () => { confirmModal() })
  $('#modal-backdrop').addEventListener('click', (event) => { if (event.target.id === 'modal-backdrop') closeModal() })
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#modal-backdrop').hidden) closeModal()
  })
}

async function boot() {
  syncHostTheme()
  bindEvents()
  setupSplitter()
  setupAutoRefresh()
  const saved = store.get('dsh-git.repo', '')
  if (saved !== '') {
    state.repo = saved
    $('#repo-input').value = saved
  }
  try {
    const payload = await loadRepoList()
    if (state.repo !== null && (payload.repos.includes(state.repo) || saved !== '')) {
      await refreshAll()
    } else {
      renderMeta()
      setBanner()
    }
  } catch (error) {
    state.error = { message: `无法读取仓库列表：${error.message}` }
    setBanner()
  }
}

boot()
