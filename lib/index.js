/**
 * dsh-git-plugin — host half.
 *
 * A DSH host plugin: it claims `/dsh-git/*` on the profile's `webServer` and
 * serves the browser app plus a small JSON API over the git executable. It is
 * deliberately thin — every git decision lives in `lib/git.js` and every HTTP
 * decision in `lib/routes.js`, both plain Node modules with no cordis import.
 *
 * Config (all optional):
 *   gitPath        - explicit git executable (skips auto-detection)
 *   repo           - default repository (an absolute path)
 *   roots          - allow-list of directories a request may name a repo in
 *   trustedHosts   - extra authorities accepted as same-origin
 *   logLimit       - default /api/log page size (10..500)
 */

import { createRoutes } from './routes.js'

export const name = 'dsh-git-plugin'

/** @param ctx - host context. @param config - the entry's config block. */
export function apply(ctx, config) {
  const options = config ?? {}

  /**
   * Directories the host already knows as projects, read at request time so a
   * workspace created after mount is picked up without a restart.
   * @returns workspace directories, best effort.
   */
  function workspaceDirs() {
    const dirs = []
    try {
      const registry = ctx.get('workspaceRegistry')
      if (registry !== undefined && typeof registry.list === 'function') {
        for (const entity of registry.list()) {
          const dir = entity?.path ?? entity?.directory
          if (typeof dir === 'string' && dir.trim() !== '') dirs.push(dir)
        }
      }
    } catch {
      /* an older or absent registry simply contributes no candidates */
    }
    return dirs
  }

  const table = createRoutes({
    gitPath: options.gitPath,
    repo: options.repo,
    roots: options.roots,
    trustedHosts: options.trustedHosts,
    logLimit: options.logLimit,
    workspaceDirs,
    // Read lazily: the client-module registry may mount after this plugin, and
    // /api/selfcheck is what proves the browser half is composed.
    clientModules: () => ctx.get('clientModules'),
  })

  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(() => {
      const disposers = []
      for (const route of table.routes) {
        try {
          disposers.push(hostCtx.webServer.register(route))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger?.warn?.(`[dsh-git-plugin] 路由注册失败 ${route.path}: ${message}`)
        }
      }
      const described = table.describe()
      ctx.logger?.info?.(
        `[dsh-git-plugin] 已挂载 ${disposers.length} 条路由；git=${described.gitPath}；默认仓库=${described.repo ?? '(自动探测)'}`,
      )
      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* the webserver is going away anyway */
          }
        }
      }
    }, 'dsh-git-plugin: routes')
  })
}
