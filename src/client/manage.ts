import { dataDir, registryPath } from '../core/dirs.js'
import { errorFromCode, PartyError } from '../core/errors.js'
import type { ParsedRef } from '../core/refs.js'
import { createSqliteRegistry } from '../registry/sqlite.js'
import { createStorePool } from '../store/pool.js'
import { tokenForServer } from './config.js'

/** Owner management that is not part of participating: irreversible deletion. */

export const deleteParty = async (parsed: ParsedRef, explicitToken?: string, dir?: string): Promise<void> => {
  if (parsed.scheme === 'local') {
    const registry = await createSqliteRegistry(registryPath(dir ?? dataDir()))
    try {
      if ((await registry.get(parsed.partyId)) === null) {
        throw new PartyError('PARTY_NOT_FOUND', 'Party not found in the local registry — check the ref.')
      }
      await createStorePool(dir).remove(parsed.partyId)
      await registry.remove(parsed.partyId)
    } finally {
      await registry.close()
    }
    return
  }

  const token = tokenForServer(parsed.server, explicitToken, dir)
  const response = await fetch(`${parsed.baseUrl}/api/parties/${encodeURIComponent(parsed.partyId)}`, {
    method: 'DELETE',
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { code?: string; message?: string }
    throw errorFromCode(body.code ?? 'BAD_REQUEST', body.message ?? `HTTP ${response.status} from the party server`)
  }
}
