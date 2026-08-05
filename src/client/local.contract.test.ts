import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describePartyContract } from '../testing/party-contract.js'
import { connectParty, createParty } from './connection.js'

/** The local protocol runs the contract straight over the files. */

const makeParty = async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-party-local-'))
  const { ref } = await createParty({ title: 'contract', dir })
  return { connect: () => connectParty(ref, { dir }) }
}

describePartyContract('local', makeParty)
