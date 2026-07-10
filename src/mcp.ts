import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { generateInvitePrompt } from './invite.js'
import { connect } from './party.js'
import { REMOTE_COMING_SOON } from './transports/index.js'
import { createLocalParty } from './transports/local.js'
import { createNtfyParty } from './transports/ntfy.js'
import type { PartyClient } from './party.js'
import type { Message, Recipients } from './types.js'

/**
 * The MCP server: the same party operations as the CLI, for agents that have MCP but no shell — Claude Desktop, ChatGPT
 * desktop, any MCP client.
 *
 * `agents-party mcp [--ref <ref>] [--as <name>]` runs it over stdio; the optional flags become defaults so tools can be
 * called without repeating the ref and name every time.
 */

export interface McpDefaults {
  ref?: string
  as?: string
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

const messagesToText = (messages: Message[]): string =>
  messages.length === 0 ? '(no messages)' : messages.map((msg) => JSON.stringify(msg)).join('\n')

const MAX_LISTEN_SEC = 120

export const createPartyMcpServer = (defaults: McpDefaults = {}, version = '0.0.0'): McpServer => {
  const server = new McpServer({ name: 'agents-party', version })

  const need = (value: string | undefined, name: 'ref' | 'as'): string => {
    if (!value) throw new Error(`missing "${name}" — pass it as a tool argument or start the server with --${name}`)
    return value
  }

  /** Open a client, run the operation, always close the transport. */
  const withClient = async <T>(
    args: { ref?: string; as?: string },
    fallbackAs: string | undefined,
    operation: (client: PartyClient) => Promise<T>,
  ): Promise<T> => {
    const client = await connect(need(args.ref ?? defaults.ref, 'ref'), {
      as: args.as ?? defaults.as ?? fallbackAs ?? '',
    })
    try {
      return await operation(client)
    } finally {
      await client.close()
    }
  }

  const refArg = z
    .string()
    .optional()
    .describe('Party ref (local:…, ntfy:… or party:…); omit if the server was started with --ref')
  const asArg = z.string().optional().describe('Your participant name; omit if the server was started with --as')

  server.registerTool(
    'party_create',
    {
      description:
        'Create a new agents-party (a shared channel for several agents and humans) and join it as the host. Returns the party ref — hand it to party_invite to bring others in.',
      inputSchema: {
        name: z.string().optional().describe('Short slug for the party name'),
        as: z.string().optional().describe('Your participant name (default: host)'),
        desc: z.string().optional().describe('Your role in the party, e.g. "runs the party"'),
        ntfy: z
          .boolean()
          .optional()
          .describe('Put the party on an E2E-encrypted ntfy topic (cross-machine) instead of a local file'),
        remote: z
          .boolean()
          .optional()
          .describe('Hosted parties on agents-party.com — coming soon; use ntfy for cross-machine today'),
        server: z.string().optional().describe('ntfy server (default https://ntfy.sh)'),
        dir: z.string().optional().describe('Directory for the local party file'),
      },
    },
    async (args) => {
      try {
        if (args.remote === true) throw new Error(REMOTE_COMING_SOON)
        const created = args.ntfy
          ? createNtfyParty({ server: args.server })
          : await createLocalParty({ name: args.name, dir: args.dir })
        const as = args.as ?? defaults.as ?? 'host'
        const client = await connect(created.ref, { as })
        try {
          await client.join({ desc: args.desc })
        } finally {
          await client.close()
        }
        return text(`ref: ${created.ref}\njoined: ${as}`)
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
        desc: z.string().optional().describe('Your role in the party'),
      },
    },
    async (args) => {
      try {
        return await withClient(args, undefined, async (client) => {
          const joined = await client.join({ desc: args.desc })
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
        'Send a message to the party — to everyone by default, or to specific participants. Mention people with @name in the text.',
      inputSchema: {
        ref: refArg,
        as: asArg,
        text: z.string().describe('The message text'),
        to: z.array(z.string()).optional().describe('Deliver only to these participant names (omit for everyone)'),
        replyTo: z.string().optional().describe('Id of the message this replies to'),
        diff: z.boolean().optional().describe('The text is a unified diff — clients render it as one'),
      },
    },
    async (args) => {
      try {
        return await withClient(args, undefined, async (client) => {
          const to: Recipients = args.to === undefined || args.to.length === 0 ? 'all' : args.to
          const sent = await client.send(args.text, { to, replyTo: args.replyTo, diff: args.diff })
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
        'Read the party conversation visible to you (broadcasts, messages addressed to you, your own). Returns JSON lines; each message carries a cursor — pass the last one as "since" next time to read only newer messages.',
      inputSchema: {
        ref: refArg,
        as: asArg,
        since: z.string().optional().describe('Opaque cursor from a previous read'),
      },
    },
    async (args) => {
      try {
        return await withClient(args, undefined, async (client) => {
          return text(messagesToText(await client.read({ since: args.since })))
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
        "Wait for the next message from someone else (blocks up to timeoutSec, max 120). Returns the new messages as JSON lines, or 'TIMEOUT' if nothing arrived — call it again to keep listening.",
      inputSchema: {
        ref: refArg,
        as: asArg,
        since: z.string().optional().describe('Opaque cursor to start after (default: only brand-new messages)'),
        timeoutSec: z.number().min(0).max(MAX_LISTEN_SEC).optional().describe('How long to wait (default 25 s)'),
        toMe: z.boolean().optional().describe('Wake only on messages addressed to me or mentioning @me'),
      },
    },
    async (args) => {
      try {
        return await withClient(args, undefined, async (client) => {
          const messages = await client.listen({
            since: args.since,
            timeoutMs: (args.timeoutSec ?? 25) * 1000,
            toMe: args.toMe,
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
        return await withClient({ ref: args.ref, as: 'observer' }, 'observer', async (client) => {
          const participants = await client.who()
          if (participants.length === 0) return text('(nobody joined yet)')
          return text(participants.map((p) => JSON.stringify(p)).join('\n'))
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
        'Generate the self-contained invite prompt for another agent session — paste it there verbatim; it carries the ref, the commands and the behaviour contract.',
      inputSchema: {
        ref: refArg,
        guestName: z.string().optional().describe('Pin the guest name; omit to let the guest pick its own'),
        desc: z.string().optional().describe("The guest's role in the party"),
        from: z.string().optional().describe('Who invites (default: host)'),
      },
    },
    async (args) => {
      try {
        return text(
          generateInvitePrompt({
            ref: need(args.ref ?? defaults.ref, 'ref'),
            guestName: args.guestName,
            desc: args.desc,
            from: args.from ?? defaults.as,
          }),
        )
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
        return await withClient(args, undefined, async (client) => {
          await client.leave()
          return text(`left: ${client.name}`)
        })
      } catch (error) {
        return errorText(error)
      }
    },
  )

  server.registerTool(
    'party_close',
    {
      description: 'Close the party for everyone — no new joins or messages after this.',
      inputSchema: { ref: refArg, as: asArg },
    },
    async (args) => {
      try {
        return await withClient(args, undefined, async (client) => {
          await client.endParty()
          return text(`party closed by ${client.name}`)
        })
      } catch (error) {
        return errorText(error)
      }
    },
  )

  server.registerTool(
    'party_export',
    {
      description: 'Export the party transcript (your view) as JSON lines.',
      inputSchema: { ref: refArg, as: asArg },
    },
    async (args) => {
      try {
        return await withClient(args, undefined, async (client) => {
          return text(messagesToText(await client.read()))
        })
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
