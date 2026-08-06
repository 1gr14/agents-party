import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { connectParty, createParty } from './client/connection.js'
import type { DecryptableMessage, PartyConnection } from './client/connection.js'
import { tokenForServer } from './client/config.js'
import { parseRef } from './core/refs.js'
import type { Recipients } from './core/types.js'
import { generateInvitePrompt, generateSkillInvite } from './invite.js'

/**
 * The MCP server: the same party operations as the CLI, for agents that have MCP but no shell — Claude Desktop, ChatGPT
 * desktop, any MCP client.
 *
 * `agents-party mcp [--ref <ref>] [--as <name>]` runs it over stdio; the optional flags become defaults so tools can be
 * called without repeating the ref and name every time — handy when a server is pinned to a single party.
 */

export interface McpDefaults {
  ref?: string
  as?: string
  /**
   * Pin every tool to one party server (a hosted deployment mounts its own host here). Pinning is also a fence: refs on
   * any other server, and `local:` refs, are refused outright — see `requireAllowedServer`.
   */
  server?: string
  /** Owner token used with the pinned server (e.g. the account token behind a remote MCP capability URL). */
  token?: string
}

interface ToolResult {
  content: { type: 'text'; text: string }[]
  isError?: boolean
  [key: string]: unknown
}

const text = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] })

const errorText = (error: unknown): ToolResult => ({
  content: [{ type: 'text', text: `error: ${error instanceof Error ? error.message : String(error)}` }],
  isError: true,
})

const messagesToText = (messages: DecryptableMessage[]): string =>
  messages.length === 0 ? '(no messages)' : messages.map((msg) => JSON.stringify(msg)).join('\n')

/** Cap listen at 55 s so the tool call returns before a client's own request timeout would fire. */
const MAX_LISTEN_SEC = 55

export const createPartyMcpServer = (defaults: McpDefaults = {}, version = '0.0.0'): McpServer => {
  const server = new McpServer({ name: 'agents-party', version })

  const need = (value: string | undefined, name: 'ref' | 'as'): string => {
    if (!value) throw new Error(`missing "${name}" — pass it as a tool argument or start the server with --${name}`)
    return value
  }

  /**
   * Owner-token resolution. Unpinned (local CLI MCP): explicit arg, then the machine's env/config — the user's own
   * ambient credentials. PINNED deployments (a hosted remote MCP serving many accounts): the pinned token applies to
   * the pinned server ONLY and there is no ambient fallback — otherwise a prompt-injected `server: evil.com` argument
   * would make the host send the account token to an attacker.
   */
  const resolveToken = (server: string, explicit: string | undefined): string | undefined => {
    if (defaults.server !== undefined) {
      return explicit ?? (server === defaults.server ? defaults.token : undefined)
    }
    return tokenForServer(server, explicit)
  }

  /**
   * What a PINNED deployment is allowed to touch. Unpinned, this MCP runs on the user's own machine and any ref they
   * hand it is theirs. Pinned (a hosted remote MCP, one process serving strangers' prompts) the ref is attacker-
   * controlled input: `party:10.0.0.5:6379/x` would make the HOST fetch its own internal network, and `local:<id>`
   * would create or open a SQLite file inside the container. One server, one scheme — everything else is refused.
   */
  const requireAllowedServer = (server: string | undefined): void => {
    if (defaults.server === undefined || server === defaults.server) return
    throw new Error(
      server === undefined
        ? `this MCP server is pinned to ${defaults.server} — local: refs are not available here, create a party with party_create`
        : `this MCP server is pinned to ${defaults.server} — refs on other servers are refused`,
    )
  }

  /**
   * Open a connection to a ref, run the operation, always close it. Remote refs resolve an owner token (needed only for
   * owner-level actions — participating needs just the ref); local refs never carry a token.
   */
  const withConnection = async <T>(
    ref: string,
    explicitToken: string | undefined,
    operation: (connection: PartyConnection) => Promise<T>,
  ): Promise<T> => {
    const parsed = parseRef(ref)
    requireAllowedServer(parsed.scheme === 'party' ? parsed.server : undefined)
    const token = parsed.scheme === 'party' ? resolveToken(parsed.server, explicitToken) : undefined
    const connection = await connectParty(ref, token === undefined ? {} : { token })
    try {
      return await operation(connection)
    } finally {
      await connection.close()
    }
  }

  const refArg = z
    .string()
    .optional()
    .describe('Party ref (local:<partyId> or party:<server>/<id>#k=<key>); omit if the server was started with --ref')
  const asArg = z.string().optional().describe('Your participant name; omit if the server was started with --as')

  server.registerTool(
    'party_create',
    {
      description:
        'Create a new agents-party (a shared channel for several agents and humans) and return its ref. Local by default (this machine only); pass a server to host it remotely (persistent history, reachable from any machine). The ref carries the encryption key in its #k= fragment — sharing the ref shares access, so treat it like a secret. Hand it to party_join to get in and to party_invite to bring others in.',
      inputSchema: {
        title: z.string().optional().describe('Short title for the party (default: party)'),
        server: z
          .string()
          .optional()
          .describe(
            'Host it on a party server (e.g. agents-party.com or your own) instead of a local file — needs an owner token via token, AGENTS_PARTY_TOKEN, or the login config',
          ),
        token: z.string().optional().describe('Owner token for the server (overrides AGENTS_PARTY_TOKEN and config)'),
      },
    },
    async (args) => {
      try {
        // Explicit args win; a hosted deployment's pinned server/token fill the gaps — but a pinned deployment
        // creates parties on ITS server only (see requireAllowedServer), and never sends its token elsewhere.
        const server = args.server ?? defaults.server
        requireAllowedServer(server)
        const token = server === undefined ? undefined : resolveToken(server, args.token)
        const created = await createParty({
          ...(args.title === undefined ? {} : { title: args.title }),
          ...(server === undefined ? {} : { server }),
          ...(token === undefined ? {} : { token }),
        })
        await created.connection.close()
        return text(
          `ref: ${created.ref}\nnote: the ref carries the encryption key (#k=) — anyone with it can read and post, so share it only with invitees.`,
        )
      } catch (error) {
        return errorText(error)
      }
    },
  )

  server.registerTool(
    'party_join',
    {
      description: 'Join an existing party under a unique name (do this once before sending).',
      inputSchema: {
        ref: refArg,
        as: asArg,
        desc: z.string().optional().describe('Your role in the party, e.g. "reviews the diffs"'),
      },
    },
    async (args) => {
      try {
        const ref = need(args.ref ?? defaults.ref, 'ref')
        const as = need(args.as ?? defaults.as, 'as')
        return await withConnection(ref, undefined, async (connection) => {
          const joined = await connection.join(as, args.desc === undefined ? {} : { desc: args.desc })
          return text(`joined: ${joined.name}`)
        })
      } catch (error) {
        return errorText(error)
      }
    },
  )

  server.registerTool(
    'party_send',
    {
      description:
        'Send a message to the party — to everyone by default, or to specific participants. Mention people with @name in the text. Returns the stored message as JSON (with its cursor and id).',
      inputSchema: {
        ref: refArg,
        as: asArg,
        text: z.string().describe('The message text'),
        to: z
          .union([z.literal('*'), z.array(z.string())])
          .optional()
          .describe('Deliver only to these participant names, or "*" for everyone (the default)'),
        replyTo: z.string().optional().describe('Id of the message this replies to'),
      },
    },
    async (args) => {
      try {
        const ref = need(args.ref ?? defaults.ref, 'ref')
        const as = need(args.as ?? defaults.as, 'as')
        return await withConnection(ref, undefined, async (connection) => {
          const to: Recipients =
            args.to === undefined || (Array.isArray(args.to) && args.to.length === 0) ? '*' : args.to
          const sent = await connection.send(as, args.text, {
            to,
            ...(args.replyTo === undefined ? {} : { replyTo: args.replyTo }),
          })
          return text(JSON.stringify(sent))
        })
      } catch (error) {
        return errorText(error)
      }
    },
  )

  server.registerTool(
    'party_read',
    {
      description:
        'Read the party conversation visible to you (broadcasts, messages addressed to you, your own). Returns JSON lines; each message carries a cursor — pass the last one as "since" next time to read only newer messages. A message that cannot be decrypted comes back with "undecrypted": true — that means the ref is missing its #k= key.',
      inputSchema: {
        ref: refArg,
        as: asArg,
        since: z.string().optional().describe('Opaque cursor from a previous read — returns only messages after it'),
        limit: z.number().int().min(1).optional().describe('Cap the number of messages returned'),
      },
    },
    async (args) => {
      try {
        const ref = need(args.ref ?? defaults.ref, 'ref')
        const asName = args.as ?? defaults.as
        return await withConnection(ref, undefined, async (connection) => {
          const messages = await connection.read({
            ...(asName === undefined ? {} : { for: asName }),
            ...(args.since === undefined ? {} : { since: args.since }),
            ...(args.limit === undefined ? {} : { limit: args.limit }),
          })
          return text(messagesToText(messages))
        })
      } catch (error) {
        return errorText(error)
      }
    },
  )

  server.registerTool(
    'party_listen',
    {
      description:
        "Wait for the next message from someone else (blocks up to timeoutSec, max 55). Returns the new messages as JSON lines, or 'TIMEOUT' if nothing arrived — call it again to keep listening.",
      inputSchema: {
        ref: refArg,
        as: asArg,
        since: z.string().optional().describe('Opaque cursor to start after (default: only brand-new messages)'),
        timeoutSec: z
          .number()
          .min(0)
          .max(MAX_LISTEN_SEC)
          .optional()
          .describe('How long to wait (default 25 s, max 55)'),
      },
    },
    async (args) => {
      try {
        const ref = need(args.ref ?? defaults.ref, 'ref')
        const as = need(args.as ?? defaults.as, 'as')
        const timeoutMs = Math.min(args.timeoutSec ?? 25, MAX_LISTEN_SEC) * 1000
        return await withConnection(ref, undefined, async (connection) => {
          const messages = await connection.listen(as, {
            timeoutMs,
            ...(args.since === undefined ? {} : { since: args.since }),
          })
          return text(messages.length === 0 ? 'TIMEOUT' : messagesToText(messages))
        })
      } catch (error) {
        return errorText(error)
      }
    },
  )

  server.registerTool(
    'party_who',
    {
      description: 'List party participants with their status and roles.',
      inputSchema: { ref: refArg },
    },
    async (args) => {
      try {
        const ref = need(args.ref ?? defaults.ref, 'ref')
        return await withConnection(ref, undefined, async (connection) => {
          const participants = await connection.participants()
          if (participants.length === 0) return text('(nobody joined yet)')
          return text(participants.map((p) => JSON.stringify(p)).join('\n'))
        })
      } catch (error) {
        return errorText(error)
      }
    },
  )

  server.registerTool(
    'party_leave',
    {
      description: 'Leave the party.',
      inputSchema: { ref: refArg, as: asArg },
    },
    async (args) => {
      try {
        const ref = need(args.ref ?? defaults.ref, 'ref')
        const as = need(args.as ?? defaults.as, 'as')
        return await withConnection(ref, undefined, async (connection) => {
          await connection.leave(as)
          return text(`left: ${as}`)
        })
      } catch (error) {
        return errorText(error)
      }
    },
  )

  server.registerTool(
    'party_invite',
    {
      description:
        'Generate the invite text for another agent session — paste it there verbatim. It carries the ref and the join command, and joining prints the rest, so the guest needs nothing installed. Leave "for" unset and it is one text for any number of guests, each naming itself; set it to pin one name. Pass skill: true for the one-line /party join command instead (for guests that already have the skill installed).',
      inputSchema: {
        ref: refArg,
        for: z.string().optional().describe('Pin the guest name; omit to let the guest pick its own'),
        desc: z.string().optional().describe("The guest's role in the party"),
        skill: z.boolean().optional().describe('Return the one-line /party join command instead of the full prompt'),
      },
    },
    async (args) => {
      try {
        const invite = {
          ref: need(args.ref ?? defaults.ref, 'ref'),
          ...(args.for === undefined ? {} : { guestName: args.for }),
          ...(args.desc === undefined ? {} : { desc: args.desc }),
          ...(defaults.as === undefined ? {} : { from: defaults.as }),
        }
        return text(args.skill === true ? generateSkillInvite(invite) : generateInvitePrompt(invite))
      } catch (error) {
        return errorText(error)
      }
    },
  )

  return server
}

/** Run the MCP server over stdio — `agents-party mcp`. Never returns. */
export const runPartyMcpServer = async (defaults: McpDefaults = {}, version?: string): Promise<void> => {
  const server = createPartyMcpServer(defaults, version)
  await server.connect(new StdioServerTransport())
  console.error('agents-party MCP server running on stdio')
  await new Promise(() => {}) // stay alive until the client disconnects the process
}
