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
check('首页可访问', response.status === 200, `HTTP ${response.status}`)
const html = await response.text()

// The graph global is injected as `globalThis["__DSH_BOOT__"] = {...}`, with
// `<` escaped inside its JSON so it cannot break out of the script element.
const match = /globalThis\["__DSH_BOOT__"\]\s*=\s*(\{.*?\})\s*<\/script>/s.exec(html)
  ?? /window\.__DSH_BOOT__\s*=\s*(\{.*?\})\s*;?\s*<\/script>/s.exec(html)
check('首页带有启动图 __DSH_BOOT__', match !== null)
if (match === null) {
  console.log(html.slice(0, 800))
  process.exit(1)
}

const boot = JSON.parse(match[1].replace(/\\u003c/g, '<'))
const rows = []
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
}
const reactStub = {
  createElement: (tag, props, ...children) => ({ tag, props, children }),
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

// Render both components: the icon must be an element, the page must embed the app.
const icon = panelList.component({ size: 20 })
check('图标渲染出元素', icon !== null && typeof icon === 'object' && icon.tag === 'svg')
const page = mainPanel.component({})
check('页面渲染出容器', page !== null && typeof page === 'object')
const iframe = (function find(node) {
  if (node === null || typeof node !== 'object') return null
  if (node.tag === 'iframe') return node
  for (const child of node.children ?? []) {
    const hit = find(child)
    if (hit !== null) return hit
  }
  return null
})(page)
check('页面内嵌 /dsh-git/', typeof iframe?.props?.src === 'string' && iframe.props.src.startsWith('/dsh-git/'), iframe?.props?.src)

// The live host must actually serve that app.
const appResponse = await fetch(`${base}/dsh-git/`)
check('宿主提供应用页面', appResponse.status === 200, `HTTP ${appResponse.status}`)
const appHtml = await appResponse.text()
check('页面引用 app.js', appHtml.includes('/dsh-git/app.js'))

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exitCode = failed === 0 ? 0 : 1
