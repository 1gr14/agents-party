/**
 * agents-party — a party line for AI agents. One model, two protocols (local files, party servers over HTTP), one
 * server implementation reused by the standalone CLI web server and by agents-party.com.
 */

// Core model
export type {
  Message,
  MessageKind,
  NewMessage,
  Participant,
  PartyMeta,
  PartySettings,
  Recipients,
} from './core/types.js'
export { defaultSettings, isVisibleTo } from './core/types.js'
export { errorFromCode, HTTP_STATUS, PartyError } from './core/errors.js'
export type { PartyErrorCode } from './core/errors.js'
export { HOST_NAME, validateParticipantName } from './core/names.js'
export { HOST_COLOR, PARTICIPANT_COLORS, pickParticipantColor } from './core/colors.js'
export { concernsParticipant, extractMentions } from './core/mentions.js'
export { looksLikeDiff, summarizeDiff } from './core/diff.js'
export type { DiffSummary } from './core/diff.js'

// Crypto: message layer + master-password key wrapping
export {
  decryptText,
  deriveMasterKeyPair,
  encryptText,
  generateMasterSalt,
  generatePartyKey,
  seal,
  unseal,
  X25519_PKCS8_PREFIX,
} from './core/crypto.js'
export type { MasterKeyPair } from './core/crypto.js'

// Refs and keys
export { formatLocalRef, formatPartyRef, guestJoinUrl, KNOWN_SCHEMES, parseRef } from './core/refs.js'
export type { ParsedRef } from './core/refs.js'
export { keyFromRefOrRegistry, keyFromRegistry, keyFromValue } from './core/keys.js'
export type { KeyResolver } from './core/keys.js'
export { dataDir, ensureDataDir, partiesDir, partyFilePath, registryPath } from './core/dirs.js'

// Registry and party store (the persistence seams)
export type { PartyStats, Registry, RegistryEntry } from './registry/registry.js'
export { createSqliteRegistry } from './registry/sqlite.js'
export { openPartyStore } from './store/store.js'
export type { PartyStore, ReadOptions } from './store/store.js'
export { createStorePool } from './store/pool.js'
export type { StorePool } from './store/pool.js'

// The server: pure fetch handlers + the standalone wrapper
export { createPartyApi } from './server/api.js'
export type { Owner, PartyApi, PartyApiContext } from './server/api.js'
export { startServer } from './server/http.js'
export type { RunningServer, ServerOptions } from './server/http.js'

// The client: one connection interface over both protocols
export { connectParty, createParty } from './client/connection.js'
export type {
  ConnectOptions,
  CreatePartyOptions,
  DecryptableMessage,
  PartyConnection,
  SendOptions,
} from './client/connection.js'
export { deleteParty } from './client/manage.js'
export { readConfig, saveServerToken, tokenForServer } from './client/config.js'

// Invites are just text; the MCP server and installers ride along
export { generateInvitePrompt, generateSkillInvite } from './invite.js'
export type { InviteOptions } from './invite.js'
export { createPartyMcpServer, runPartyMcpServer } from './mcp.js'
export { install } from './install.js'
export type { InstallOptions, InstallTarget } from './install.js'
