/**
 * Verifies the client half of dsh-git-plugin as a running DSH host serves it:
 * the boot graph must contain the package row, its bundle URL must be fetchable,
 * and the fetched bundle must register the factory the module system expects.
 *
 *   node test/client-bundle.mjs <baseUrl> [token]
 */

const base = process.argv[2] ?? 'http://127.0.0.1:4599'
const token = process.argv[3] ?? ''
const PACKAGE_ID = 'dsh-git-plugin'

let passed = 0
let failed = 0

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.log(`  ✗ ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const indexUrl = `${base}/`
let cookie = ''

// A `dsh web` host authenticates the index with a launch token: GET / with
// `?token=` answers 303 plus a signed cookie, and every later request needs
// that cookie. A desktop host needs none, so this is best effort.
if (token !== '') {
  const handshake = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  const setCookie = handshake.headers.getSetCookie?.() ?? []
  check('令牌交换返回重定向/会话', handshake.status === 303 || handshake.status === 200, `HTTP ${handshake.status}`)
  cookie = setCookie.map(entry => entry.split(';')[0]).join('; ')
  check('令牌交换下发会话 cookie', cookie !== '', JSON.stringify(setCookie))
}
const headers = cookie === '' ? {} : { cookie }

const response = await fetch(indexUrl, { headers })
const indexOk = response.status === 200
const html = indexOk ? await response.text() : ''

// The graph global is injected as `globalThis["__DSH_BOOT__"] = {...}`, with
// `<` escaped inside its JSON so it cannot break out of the script element.
const match = indexOk
  ? (/globalThis\["__DSH_BOOT__"\]\s*=\s*(\{.*?\})\s*<\/script>/s.exec(html)
    ?? /window\.__DSH_BOOT__\s*=\s*(\{.*?\})\s*;?\s*<\/script>/s.exec(html))
  : null

// A token-gated desktop host answers the index with 401 and exposes no graph.
// The plugin's own /api/selfcheck reads the SAME row out of the host's
// client-module registry, so the bundle checks below still apply there.
let rows = []
let rowSource = ''
if (match !== null) {
  check('首页可访问', true)
  check('首页带有启动图 __DSH_BOOT__', true)
  const boot = JSON.parse(match[1].replace(/\\u003c/g, '<'))
  const collect = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) collect(item)
      return
    }
    if (value !== null && typeof value === 'object') {
      if (typeof value.id === 'string' && typeof value.url === 'string') rows.push(value)
      for (const child of Object.values(value)) collect(child)
    }
  }
  collect(boot)
  rowSource = '__DSH_BOOT__'
} else {
  const status = response.status
  const self = await (await fetch(`${base}/dsh-git/api/selfcheck`)).json().catch(() => null)
  const selfRow = self?.client?.row
  const usable = status === 401 && selfRow?.id === PACKAGE_ID
  check('首页被 token 网关拦截时改用 selfcheck 取启动图行', usable || status !== 401, `HTTP ${status}`)
  if (selfRow !== undefined && selfRow !== null) rows = [selfRow]
  rowSource = 'selfcheck'
  if (!usable) {
    console.log(indexOk ? html.slice(0, 800) : `HTTP ${status}`)
    process.exit(1)
  }
}
console.log(`    启动图来源: ${rowSource}`)

const row = rows.find(entry => entry.id === PACKAGE_ID)
check('启动图包含 dsh-git-plugin 行', row !== undefined, rows.map(r => r.id).slice(0, 12).join(', '))
if (row === undefined) process.exit(1)
console.log(`    url=${row.url} rev=${row.rev}`)

// The row URL is a combo key (`plugins/??<ids>&rev=<rev>`) whose exact query
// string is the route key — adding a parameter changes the key and 404s, so it
// is used verbatim and authenticated by the cookie alone.
const bundleResponse = await fetch(`${base}/${row.url}`, { headers })
check('客户端 bundle 可获取', bundleResponse.status === 200, `HTTP ${bundleResponse.status}`)
const bundle = await bundleResponse.text()
check('bundle 为 javascript', (bundleResponse.headers.get('content-type') ?? '').includes('javascript'))
check('bundle 调用 __ModuleLoader__.load', bundle.includes('__ModuleLoader__.load'))
check('bundle 声明包 id', bundle.includes(PACKAGE_ID))
check('bundle 未打包进 react（走平台表）', bundle.includes('require("react")') || bundle.includes("require('react')"))

// Execute the bundle against a stub module system: the factory must hand back a
// cordis plugin with the seats this package registers.
let registration = null
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      registration = entry
    },
  },
  // The page polls the shell's persisted session; the stub records the timer
  // setup and lets the test drive localStorage directly.
  setInterval: () => 0,
  clearInterval: () => {},
  localStorage: {
    value: null,
    getItem() {
      return this.value
    },
    setItem(_key, next) {
      this.value = next
    },
  },
}
// A minimal store, so `useState` gives a real value and `useEffect` runs its
// body once (the page subscribes to the shell's persisted session there).
const reactStub = {
  createElement: (tag, props, ...children) => ({ tag, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: (callback) => { callback() },
}
const required = []
const requireStub = (specifier) => {
  required.push(specifier)
  if (specifier === 'react') return reactStub
  throw new Error(`unexpected external: ${specifier}`)
}
new Function(bundle)()
check('bundle 注册了工厂', registration !== null)
check('注册的 id 正确', registration?.id === PACKAGE_ID, registration?.id)
if (registration === null) {
  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  process.exit(1)
}

const exportsObject = registration.factory(requireStub)
check('工厂只请求了 react', required.every(name => name === 'react'), required.join(', '))
check('导出 apply', typeof exportsObject.apply === 'function')
check('导出 inject=slots', Array.isArray(exportsObject.inject) && exportsObject.inject.includes('slots'), JSON.stringify(exportsObject.inject))

// Run apply() against a minimal slot host and record what it claims. `slots.inject`
// runs its callback through the host's `effect`, which accepts a disposer or an
// ITERABLE of disposers — the generator form this package uses for `main`.
const registrations = []
const disposers = []
const drain = (value) => {
  if (value === null || value === undefined) return
  if (typeof value === 'function') {
    disposers.push(value)
    return
  }
  if (typeof value[Symbol.iterator] === 'function') {
    for (const item of value) drain(item)
  }
}
const ctx = {
  locale: {
    register: (namespace, dicts) => { registrations.push({ kind: 'locale', namespace, dicts }); return () => {} },
    bind: (namespace) => (key) => `${namespace}:${key}`,
  },
  effect: (callback) => {
    drain(callback())
    return () => {}
  },
  // The right-sidebar seats are gated behind ctx.inject([...]); resolving the
  // services immediately is what makes those registrations observable here.
  inject: (services, callback) => {
    registrations.push({ kind: 'injected', services })
    callback(ctx)
  },
  sidebarRightTabs: {
    register: (definition) => {
      registrations.push({ kind: 'tabType', definition })
      return () => {}
    },
  },
  sidebarRight: {
    openTab: (kind) => {
      registrations.push({ kind: 'openTab', kind })
      return 'tab-1'
    },
  },
  layout: {
    selectPanel: (id) => { registrations.push({ kind: 'selectPanel', id }) },
  },
  slots: {
    inject: (slot, callback) => { registrations.push({ kind: 'inject', slot }); drain(callback()) },
    register: (options, component) => {
      registrations.push({ kind: 'register', options, component })
      return () => {}
    },
  },
}
exportsObject.apply(ctx)

const panelList = registrations.find(entry => entry.kind === 'register' && entry.options.name === 'sidebar.panellist')
const mainPanel = registrations.find(entry => entry.kind === 'register' && entry.options.name === 'main')
check('注册 sidebar.panellist 图标', panelList !== undefined)
check('注册 main 面板', mainPanel !== undefined)
check('两处 id 一致', panelList?.options.id === mainPanel?.options.key, `${panelList?.options.id} vs ${mainPanel?.options.key}`)
check('panellist 有 label', typeof panelList?.options.label === 'function')
check('注册了 locale 字典', registrations.some(entry => entry.kind === 'locale'))
check('等待 main 槽声明', registrations.some(entry => entry.kind === 'inject' && entry.slot === 'main'))

// The brief window in the right sidebar: a page tab type, the body seat that
// type renders into, and the left sidebar footer action that opens it.
const tabType = registrations.find(entry => entry.kind === 'tabType')
check('注册右侧边栏 tab 类型', tabType?.definition?.kind === 'git-summary', JSON.stringify(tabType?.definition))
check('tab 类型带 id 与 title', typeof tabType?.definition?.id === 'string' && typeof tabType?.definition?.title === 'function')
check(
  '只向宿主请求右侧边栏服务',
  registrations.some(entry => entry.kind === 'injected' && Array.isArray(entry.services)
    && entry.services.includes('sidebarRightTabs') && entry.services.includes('sidebarRight')),
)
const summaryBody = registrations.find(entry => entry.kind === 'register' && entry.options.name === 'sidebar.right.pane.tab')
check('注册简要窗口 body', summaryBody !== undefined)
check(
  'body key 与 tab 类型 id 一致',
  summaryBody?.options.key === tabType?.definition?.id,
  `${summaryBody?.options.key} vs ${tabType?.definition?.id}`,
)
const footerAction = registrations.find(entry => entry.kind === 'register' && entry.options.name === 'sidebar.footer.action')
check('注册左栏页脚入口', footerAction !== undefined)
// A registered seat may be a wrapper element around the real component; the
// stub has no reconciler, so unwrap by hand until a DOM tag appears.
const render = (node) => (typeof node?.tag === 'function' ? render(node.tag(node.props)) : node)
check('页脚入口渲染出按钮', render(footerAction?.component({ wide: true, copy: (key) => key }))?.tag === 'button')
check('简要窗口渲染出内容', render(summaryBody?.component({ copy: (key) => key }))?.tag === 'div')

// Render both components: the icon must be an element, the page must embed the app.
const icon = panelList.component({ size: 20 })
check('图标渲染出元素', icon !== null && typeof icon === 'object' && icon.tag === 'svg')
const page = mainPanel.component({})
check('页面渲染出容器', page !== null && typeof page === 'object')

/** Depth-first search for the embedded frame. */
function findIframe(node) {
  if (node === null || typeof node !== 'object') return null
  if (node.tag === 'iframe') return node
  for (const child of node.children ?? []) {
    const hit = findIframe(child)
    if (hit !== null) return hit
  }
  return null
}

const iframe = findIframe(page)
check('页面内嵌 /dsh-git/', typeof iframe?.props?.src === 'string' && iframe.props.src.startsWith('/dsh-git/'), iframe?.props?.src)
check('无会话时不带 session 参数', iframe?.props?.src === '/dsh-git/?embed=1', iframe?.props?.src)

// With a session persisted by the shell, the frame must carry it so the host
// can open the workspace that session belongs to.
globalThis.window.localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: 'session-test-1' }))
const withSession = findIframe(mainPanel.component({}))
check(
  '带会话时 iframe 传 session 参数',
  typeof withSession?.props?.src === 'string' && withSession.props.src.includes('session=session-test-1'),
  withSession?.props?.src,
)
const withSessionLink = (function findLink(node) {
  if (node === null || typeof node !== 'object') return null
  if (node.tag === 'a') return node
  for (const child of node.children ?? []) {
    const hit = findLink(child)
    if (hit !== null) return hit
  }
  return null
})(mainPanel.component({}))
check(
  '新标签页链接同样带 session',
  typeof withSessionLink?.props?.href === 'string' && withSessionLink.props.href.includes('session=session-test-1'),
  withSessionLink?.props?.href,
)

// The live host must actually serve that app.
const appResponse = await fetch(`${base}/dsh-git/`)
check('宿主提供应用页面', appResponse.status === 200, `HTTP ${appResponse.status}`)
const appHtml = await appResponse.text()
check('页面引用 app.js', appHtml.includes('/dsh-git/app.js'))

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exitCode = failed === 0 ? 0 : 1
