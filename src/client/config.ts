import fs from 'node:fs'
import path from 'node:path'
import { dataDir, ensureDataDir } from '../core/dirs.js'

/**
 * `<dir>/config.json` — owner credentials per server, written by `agents-party login`. One shape for both kinds of
 * server: the API key from the site's settings page, or a self-hosted server's token. Explicit `--token` and the
 * AGENTS_PARTY_TOKEN env always win over the config.
 */

export interface CliConfig {
  servers?: Record<string, { token: string }>
}

const configPath = (dir = dataDir()): string => path.join(dir, 'config.json')

export const readConfig = (dir = dataDir()): CliConfig => {
  try {
    return JSON.parse(fs.readFileSync(configPath(dir), 'utf8')) as CliConfig
  } catch {
    return {}
  }
}

export const saveServerToken = (server: string, token: string, dir = dataDir()): void => {
  ensureDataDir(dir)
  const config = readConfig(dir)
  config.servers = { ...config.servers, [server]: { token } }
  // Owner-powered secret — keep the file private (and re-tighten pre-existing files on rewrite).
  const path = configPath(dir)
  fs.writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 })
  fs.chmodSync(path, 0o600)
}

/** Token for a server: explicit flag > AGENTS_PARTY_TOKEN env > config.json. */
export const tokenForServer = (server: string, explicit?: string, dir = dataDir()): string | undefined =>
  explicit ?? process.env.AGENTS_PARTY_TOKEN ?? readConfig(dir).servers?.[server]?.token
