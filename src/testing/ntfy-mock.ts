/**
 * An in-process mock of the ntfy HTTP API surface our transport uses: `POST /<topic>` to publish, `GET
 * /<topic>/json?poll=1&since=<all|id>` to read. Keeps the ntfy transport tests offline and instant.
 */

interface StoredMessage {
  id: string
  time: number
  event: 'message'
  message: string
}

export interface NtfyMock {
  url: string
  stop(): void
  /** Make the next `n` requests (of any kind) answer HTTP 429. */
  rateLimitNext(n: number): void
}

export const startNtfyMock = (): NtfyMock => {
  const topics = new Map<string, StoredMessage[]>()
  let counter = 0
  let rateLimitBudget = 0

  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      if (rateLimitBudget > 0) {
        rateLimitBudget--
        return new Response('too many requests', { status: 429 })
      }
      const url = new URL(req.url)
      const segments = url.pathname.split('/').filter(Boolean)
      const topic = segments[0]
      if (!topic) return new Response('not found', { status: 404 })

      if (req.method === 'POST' && segments.length === 1) {
        const stored: StoredMessage = {
          id: `n${++counter}`,
          time: Math.floor(Date.now() / 1000),
          event: 'message',
          message: await req.text(),
        }
        const list = topics.get(topic) ?? []
        list.push(stored)
        topics.set(topic, list)
        return Response.json(stored)
      }

      if (req.method === 'GET' && segments[1] === 'json') {
        const since = url.searchParams.get('since') ?? 'all'
        const list = topics.get(topic) ?? []
        let slice = list
        if (since !== 'all') {
          const anchor = list.findIndex((msg) => msg.id === since)
          slice = anchor === -1 ? list : list.slice(anchor + 1)
        }
        const body = slice.map((msg) => JSON.stringify(msg)).join('\n')
        return new Response(body ? `${body}\n` : '')
      }

      return new Response('not found', { status: 404 })
    },
  })

  return {
    url: `http://localhost:${server.port}`,
    stop: () => {
      void server.stop(true)
    },
    rateLimitNext: (n) => {
      rateLimitBudget = n
    },
  }
}
