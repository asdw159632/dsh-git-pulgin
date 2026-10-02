/**
 * dsh-git-plugin — browser half.
 *
 * Loaded by the DSH client module system: this file is the package's `./client`
 * export, the host serves it under `/plugins/dsh-git-plugin/client.js`, and
 * executing it registers one factory. The factory resolves `react` from the
 * shell's frozen platform table, so no bundler and no `dsh.client.external`
 * entry is needed.
 *
 * What it registers:
 *   1. `sidebar.panellist` — the sidebar icon that selects the page.
 *   2. `main` keyed by the same id — the page itself, which embeds the
 *      host-served app (`/dsh-git/`) in a same-origin iframe. All git work
 *      happens in the host plugin; this half only claims the seats.
 */
window.__ModuleLoader__.load({
  id: 'dsh-git-plugin',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /** The id shared by the sidebar row and the main panel it opens. */
    const PANEL_ID = 'git'
    /** Locale namespace owned by this plugin. */
    const NS = 'dshGit'
    /** Where the host serves the app. */
    const APP_URL = '/dsh-git/'
    /**
     * The store the workspace shell persists the session shown in the main
     * panel under (`createSnapshotStore(..., { persist: { name } })`). Reading
     * it is how this half knows which workspace the user is actually in.
     */
    const CURRENT_SESSION_KEY = 'dsh.sessions.current'
    /** The right-sidebar tab kind this package owns: a brief Git window. */
    const SUMMARY_KIND = 'git-summary'
    /** Identity in the tab-type registry; must be unique across registrations. */
    const SUMMARY_ID = 'dsh-git-plugin/summary'
    /** How often the brief window re-reads the repository. */
    const SUMMARY_INTERVAL_MS = 10000

    const DICTS = {
      zh: {
        panel: 'Git',
        title: 'Git 历史与操作',
        open: '在新标签页打开',
        hint: '若面板未渲染，请在新标签页打开。',
        summary: 'Git 简要',
        summaryHint: '右侧边栏的简要窗口',
        branch: '分支',
        ahead: '待推送',
        behind: '待拉取',
        staged: '已暂存',
        unstaged: '未暂存',
        untracked: '未跟踪',
        conflicted: '冲突',
        clean: '工作区干净',
        lastCommit: '最近提交',
        refresh: '刷新',
        openPanel: '完整面板',
        reading: '读取中…',
        noRepo: '未发现仓库',
      },
      en: {
        panel: 'Git',
        title: 'Git history and operations',
        open: 'Open in a new tab',
        hint: 'If the panel does not render, open it in a new tab.',
        summary: 'Git brief',
        summaryHint: 'Brief Git window in the right sidebar',
        branch: 'Branch',
        ahead: 'To push',
        behind: 'To pull',
        staged: 'Staged',
        unstaged: 'Unstaged',
        untracked: 'Untracked',
        conflicted: 'Conflicted',
        clean: 'Working tree clean',
        lastCommit: 'Last commit',
        refresh: 'Refresh',
        openPanel: 'Full panel',
        reading: 'Reading…',
        noRepo: 'No repository found',
      },
    }

    /**
     * The sidebar glyph: a branch with a commit on each end.
     * @param props - the sidebar's icon share (`size`).
     */
    function GitPanelIcon(props) {
      const size = typeof props?.size === 'number' && props.size > 0 ? props.size : 20
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block' },
        },
        h('circle', { cx: 6.5, cy: 5, r: 2.4 }),
        h('circle', { cx: 6.5, cy: 19, r: 2.4 }),
        h('circle', { cx: 17.5, cy: 8.5, r: 2.4 }),
        h('path', { d: 'M6.5 7.4v9.2' }),
        h('path', { d: 'M6.5 12.2c0-3.4 2.2-3.7 5-3.7h3.6' }),
      )
    }

    /**
     * The session the shell currently shows, read from the selection store the
     * workspace shell itself persists. Best effort by design: a missing,
     * unreadable or unexpected entry simply means "no session hint", and the
     * host then falls back to plain workspace detection.
     * @returns the session id, or '' when unknown.
     */
    function readCurrentSession() {
      try {
        const raw = window.localStorage.getItem(CURRENT_SESSION_KEY)
        if (raw === null) return ''
        const value = JSON.parse(raw)
        return typeof value?.sessionId === 'string' ? value.sessionId : ''
      } catch {
        return ''
      }
    }

    /**
     * The Git page: one same-origin iframe over the host's app.
     * The wrapper keeps a real height even where `height: 100%` cannot resolve.
     *
     * The current session id rides along as `?session=`, so the embedded app
     * opens the workspace that session belongs to. The shell rewrites the
     * selection on every navigation, so it is re-read on a timer and the iframe
     * is re-keyed only when the value actually changes.
     */
    function GitPage() {
      const [sessionId, setSessionId] = React.useState(readCurrentSession)
      React.useEffect(() => {
        const timer = window.setInterval(() => {
          const next = readCurrentSession()
          setSessionId((current) => (current === next ? current : next))
        }, 1500)
        return () => window.clearInterval(timer)
      }, [])

      const query = sessionId === '' ? '' : `?session=${encodeURIComponent(sessionId)}`
      const embedUrl = `${APP_URL}${query}${query === '' ? '?' : '&'}embed=1`
      const tabUrl = `${APP_URL}${query}`

      return h(
        'div',
        {
          style: {
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            minHeight: '70vh',
            width: '100%',
            overflow: 'hidden',
            background: 'var(--dsh-color-bg, transparent)',
          },
        },
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '8px',
              padding: '6px 10px',
              fontSize: '12px',
              opacity: 0.72,
              borderBottom: '1px solid color-mix(in srgb, currentColor 14%, transparent)',
            },
          },
          h('span', null, 'Git 历史与操作'),
          h(
            'a',
            { href: tabUrl, target: '_blank', rel: 'noreferrer', style: { color: 'inherit' } },
            '在新标签页打开 ↗',
          ),
        ),
        h('iframe', {
          key: embedUrl,
          src: embedUrl,
          title: 'Git',
          style: { flex: '1 1 auto', width: '100%', minHeight: 0, border: '0', background: 'transparent' },
        }),
      )
    }

    /**
     * Read one plugin JSON endpoint.
     * @param path - plugin path including its query string.
     * @returns the parsed `{ ok: true, ... }` envelope.
     */
    async function getJson(path) {
      const response = await fetch(path, { headers: { accept: 'application/json' } })
      const payload = await response.json().catch(() => null)
      if (payload === null || payload.ok !== true) {
        const message = payload !== null && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`
        throw new Error(message)
      }
      return payload
    }

    /**
     * Poll the repository that belongs to the session the shell currently shows.
     * @param nonce - bump to force an immediate re-read.
     * @returns the latest snapshot the brief window renders.
     */
    function useSummarySnapshot(nonce) {
      const [snapshot, setSnapshot] = React.useState({ phase: 'reading', repo: null, status: null, last: null, error: null })
      React.useEffect(() => {
        let cancelled = false
        const load = async () => {
          try {
            const sessionId = readCurrentSession()
            const suffix = sessionId === '' ? '' : `?session=${encodeURIComponent(sessionId)}`
            const repos = await getJson(`${APP_URL}api/repos${suffix}`)
            const repo = repos.defaultRepo
            if (typeof repo !== 'string' || repo === '') {
              if (!cancelled) setSnapshot({ phase: 'empty', repo: null, status: null, last: null, error: null })
              return
            }
            const query = `?repo=${encodeURIComponent(repo)}`
            const [statusPayload, logPayload] = await Promise.all([
              getJson(`${APP_URL}api/status${query}`),
              getJson(`${APP_URL}api/log${query}&limit=1`),
            ])
            if (cancelled) return
            setSnapshot({
              phase: 'ready',
              repo,
              status: statusPayload.status ?? null,
              last: (logPayload.commits ?? [])[0] ?? null,
              error: null,
            })
          } catch (error) {
            if (!cancelled) {
              setSnapshot({
                phase: 'error',
                repo: null,
                status: null,
                last: null,
                error: error instanceof Error ? error.message : String(error),
              })
            }
          }
        }
        load()
        const timer = window.setInterval(load, SUMMARY_INTERVAL_MS)
        return () => {
          cancelled = true
          window.clearInterval(timer)
        }
      }, [nonce])
      return snapshot
    }

    /** One label/value line of the brief window. */
    function summaryRow(label, value, tone) {
      return h(
        'div',
        { style: { display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '12px', lineHeight: '19px' } },
        h('span', { style: { opacity: 0.6 } }, label),
        h('span', { style: tone === undefined ? undefined : { color: tone } }, String(value)),
      )
    }

    /** A quiet action button for the brief window. */
    function summaryButton(label, onClick) {
      return h(
        'button',
        {
          type: 'button',
          onClick,
          style: {
            background: 'transparent',
            border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
            borderRadius: '6px',
            color: 'inherit',
            font: 'inherit',
            fontSize: '11.5px',
            padding: '3px 8px',
            cursor: 'pointer',
          },
        },
        label,
      )
    }

    /**
     * The brief Git window in the right sidebar: which repository the current
     * session uses, how it stands against its upstream, what is uncommitted, and
     * the last commit. Deliberately read-only — changes belong to the full panel.
     * @param props - `copy` (translator) and `onOpenPanel`.
     */
    function GitSummary(props) {
      const copy = typeof props?.copy === 'function' ? props.copy : (key) => key
      const [nonce, setNonce] = React.useState(0)
      const snapshot = useSummarySnapshot(nonce)
      const children = []

      children.push(
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '6px' } },
          h('strong', { style: { fontSize: '12.5px' } }, copy('summary')),
          h(
            'span',
            { style: { display: 'flex', gap: '6px' } },
            summaryButton(copy('refresh'), () => setNonce((value) => value + 1)),
            typeof props?.onOpenPanel === 'function' ? summaryButton(copy('openPanel'), props.onOpenPanel) : null,
          ),
        ),
      )

      if (snapshot.phase === 'reading') {
        children.push(h('div', { style: { fontSize: '12px', opacity: 0.6 } }, copy('reading')))
      } else if (snapshot.phase === 'empty') {
        children.push(h('div', { style: { fontSize: '12px', opacity: 0.6 } }, copy('noRepo')))
      } else if (snapshot.phase === 'error') {
        children.push(
          h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary, #f85149)' } }, snapshot.error),
        )
      } else {
        const status = snapshot.status ?? {}
        const entries = (status.entries ?? []).filter((entry) => entry.kind !== 'ignored')
        const staged = entries.filter((entry) => entry.staged).length
        const conflicted = entries.filter((entry) => entry.conflicted).length
        const unstaged = entries.filter((entry) => entry.unstaged && !entry.conflicted).length
        const untracked = entries.filter((entry) => entry.kind === 'untracked').length
        const branch = status.branch?.head ?? ''
        const name = snapshot.repo.split(/[\\/]/).filter(Boolean).pop() ?? snapshot.repo

        children.push(h('div', { style: { fontSize: '12px', fontWeight: 600, wordBreak: 'break-all' } }, name))
        children.push(summaryRow(copy('branch'), branch === '' ? '(detached)' : branch))
        if (Number.isFinite(status.branch?.ahead) && Number.isFinite(status.branch?.behind)) {
          children.push(summaryRow(copy('ahead'), status.branch.ahead))
          children.push(summaryRow(copy('behind'), status.branch.behind))
        }
        const active = Object.entries(status.state ?? {}).filter(([, value]) => value).map(([key]) => key)
        if (active.length > 0) children.push(summaryRow('状态', active.join(' / ')))
        if (entries.length === 0) {
          children.push(summaryRow(copy('clean'), ''))
        } else {
          children.push(summaryRow(copy('conflicted'), conflicted, conflicted > 0 ? '#f85149' : undefined))
          children.push(summaryRow(copy('staged'), staged))
          children.push(summaryRow(copy('unstaged'), unstaged))
          children.push(summaryRow(copy('untracked'), untracked))
        }
        if (snapshot.last !== null) {
          const sha = String(snapshot.last.sha ?? '').slice(0, 7)
          children.push(
            h(
              'div',
              { style: { marginTop: '8px', fontSize: '11.5px', lineHeight: '16px', opacity: 0.78 } },
              h('div', null, `${copy('lastCommit')} ${sha}`),
              h('div', { style: { wordBreak: 'break-word' } }, String(snapshot.last.subject ?? '')),
            ),
          )
        }
      }

      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '2px',
            padding: '10px 12px',
            fontFamily: 'var(--dsw-alias-font-sans, inherit)',
            color: 'var(--dsw-alias-label-primary, inherit)',
          },
        },
        ...children,
      )
    }

    /**
     * The left sidebar's footer action that opens the brief window.
     * @param props - the sidebar seat share (`wide`), plus `copy` and `onOpen`.
     */
    function SummaryFooterButton(props) {
      const copy = typeof props?.copy === 'function' ? props.copy : (key) => key
      const wide = props?.wide !== false
      return h(
        'button',
        {
          type: 'button',
          title: copy('summaryHint'),
          onClick: () => {
            try {
              props?.onOpen?.()
            } catch (error) {
              console.warn('[dsh-git-plugin] 打开简要窗口失败', error)
            }
          },
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: wide ? 'flex-start' : 'center',
            gap: '8px',
            width: '100%',
            height: '32px',
            padding: wide ? '0 8px' : '0',
            margin: '2px 0',
            background: 'transparent',
            border: 'none',
            borderRadius: '6px',
            color: 'inherit',
            font: 'inherit',
            fontSize: '12px',
            cursor: 'pointer',
            textAlign: 'left',
          },
        },
        h(
          'svg',
          {
            width: 16,
            height: 16,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.7,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true',
            style: { display: 'block', flex: 'none' },
          },
          h('path', { d: 'M4 6h16' }),
          h('path', { d: 'M4 12h10' }),
          h('path', { d: 'M4 18h13' }),
        ),
        wide ? h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, copy('summary')) : null,
      )
    }

    /**
     * Register the sidebar row and the panel it opens.
     * @param ctx - the browser plugin context (`inject` guarantees `slots`).
     */
    function apply(ctx) {
      // The locale service is not required for the seats to work, so a host
      // without it keeps a plain-label Git row instead of losing the plugin.
      let t = (key) => DICTS.zh[key] ?? key
      try {
        if (ctx.locale !== undefined && typeof ctx.locale.register === 'function' && typeof ctx.locale.bind === 'function') {
          ctx.effect(() => ctx.locale.register(NS, DICTS), 'dsh-git-plugin: dictionaries')
          t = ctx.locale.bind(NS)
        }
      } catch (error) {
        console.warn('[dsh-git-plugin] locale registration failed, using plain labels', error)
      }

      ctx.slots.inject('main', function* registerGitPage() {
        yield ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            locale: NS,
          },
          GitPage,
        )
      })

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 40,
            label: () => t('panel') ?? 'Git',
            locale: NS,
          },
          GitPanelIcon,
        ),
      )

      // The brief window lives in the RIGHT sidebar, which is a tab dock rather
      // than a plain slot: a package owns a page tab TYPE plus the body seat that
      // type renders into, and something opens it. Both services come from the
      // right-sidebar package, so a host without one simply skips this block.
      ctx.inject(['sidebarRightTabs', 'sidebarRight'], (sidebarCtx) => {
        sidebarCtx.effect(
          () =>
            sidebarCtx.sidebarRightTabs.register({
              id: SUMMARY_ID,
              kind: SUMMARY_KIND,
              title: () => t('summary'),
              // Without `guide` the type exists but nothing ever offers it: the
              // right sidebar's guide page is where a page type lists its entry
              // box, and the strip's add control opens that page.
              guide: [
                {
                  id: 'summary',
                  order: 60,
                  title: () => t('summary'),
                  description: () => t('summaryHint'),
                  icon: GitPanelIcon,
                },
              ],
            }),
          'dsh-git-plugin: summary tab type',
        )

        sidebarCtx.effect(
          () =>
            sidebarCtx.slots.inject('sidebar.right.pane.tab', () =>
              sidebarCtx.slots.register(
                { name: 'sidebar.right.pane.tab', key: SUMMARY_ID, locale: NS },
                (props) =>
                  h(GitSummary, {
                    ...props,
                    copy: t,
                    onOpenPanel: () => {
                      try {
                        ctx.layout?.selectPanel?.(PANEL_ID)
                      } catch (error) {
                        console.warn('[dsh-git-plugin] 打开完整面板失败', error)
                      }
                    },
                  }),
              ),
            ),
          'dsh-git-plugin: summary tab body',
        )

        // The left sidebar's footer action opens it too — the guide entry above
        // is the discoverable path, this is the shortcut.
        sidebarCtx.slots.inject('sidebar.footer.action', () =>
          sidebarCtx.slots.register({ name: 'sidebar.footer.action', id: 'git-summary', order: 60, locale: NS }, (props) =>
            h(SummaryFooterButton, {
              ...props,
              copy: t,
              onOpen: () => sidebarCtx.sidebarRight.openTab(SUMMARY_KIND),
            }),
          ),
        )
      })
    }

    return { name: 'dsh-git-plugin', inject: ['slots'], apply }
  },
})
