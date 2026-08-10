import { Moon, Sun } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Message, Participant, PartyMeta, Recipients } from '../../src/index.js'
import { Button } from '../../src/ui/components/button.js'
import { Input } from '../../src/ui/components/input.js'
import { Chat, type ChatMessage } from '../../src/ui/party/chat.js'
import { InviteButton } from '../../src/ui/party/invite-button.js'
import type { PartyListItem } from '../../src/ui/party/sidebar.js'
import { decrypt, encrypt } from './lib/crypto.js'
import { getScheme, type Scheme, toggleScheme } from './lib/theme.js'

const PAGE = 50
const HOST = 'host'

/** Owner-facing party meta as returned by GET /api/parties — publicMeta with the plaintext `key`. */
type OwnerParty = Pick<PartyMeta, 'id' | 'title' | 'createdAt' | 'lastMessageAt' | 'messagesCount' | 'key'>

class Unauthorized extends Error {}

/**
 * Append incoming messages, dropping any whose id we already hold — a just-sent message can also arrive again via an
 * in-flight listen that was started from an older cursor.
 */
const appendUnique = (prev: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] => {
  const seen = new Set(prev.map((m) => m.id))
  const fresh = incoming.filter((m) => !seen.has(m.id))
  return fresh.length === 0 ? prev : [...prev, ...fresh]
}

const decodeToChat = async (raw: Message[], key: string | null): Promise<ChatMessage[]> =>
  Promise.all(
    raw.map(async (m) => ({
      id: m.id,
      kind: m.kind,
      from: m.from,
      to: m.to,
      ts: m.ts,
      text: m.kind !== 'message' ? null : key === null ? null : await decrypt(key, m.text),
    })),
  )

export const PartyApp = () => {
  const [token, setToken] = useState<string>(() => sessionStorage.getItem('apToken') ?? '')
  const [gate, setGate] = useState(false)
  const [gateDraft, setGateDraft] = useState('')
  const [gateError, setGateError] = useState('')

  const [parties, setParties] = useState<OwnerParty[]>([])
  const [partiesHasMore, setPartiesHasMore] = useState(false)
  const [partiesLoadingMore, setPartiesLoadingMore] = useState(false)
  const [partiesLoading, setPartiesLoading] = useState(true)
  const [current, setCurrent] = useState<OwnerParty | null>(null)
  const [participants, setParticipants] = useState<Participant[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [hasOlder, setHasOlder] = useState(false)

  const [scheme, setSchemeState] = useState<Scheme>('light')
  useEffect(() => setSchemeState(getScheme()), [])

  const keyRef = useRef<string | null>(null)
  const cursorRef = useRef<string | null>(null) // newest seen — the long-poll `since`
  const oldestRef = useRef<string | null>(null) // oldest loaded — the `before` for older pages
  const listenAbortRef = useRef<AbortController | null>(null)
  const joinedRef = useRef<Set<string>>(new Set())
  const tokenRef = useRef(token)
  tokenRef.current = token

  const api = useCallback(async (path: string, opts: RequestInit = {}): Promise<any> => {
    const res = await fetch(path, {
      ...opts,
      headers: {
        ...(opts.body ? { 'content-type': 'application/json' } : {}),
        ...(tokenRef.current ? { authorization: `Bearer ${tokenRef.current}` } : {}),
      },
    })
    if (res.status === 401) {
      setGate(true)
      throw new Unauthorized('unauthorized')
    }
    const body = await res.json()
    if (!res.ok) {
      // Attach the wire error `code` so callers can branch on it (e.g. NAME_TAKEN) instead of matching message text.
      const err = new Error(typeof body?.message === 'string' ? body.message : String(res.status)) as Error & {
        code?: string
      }
      if (typeof body?.code === 'string') err.code = body.code
      throw err
    }
    return body
  }, [])

  const partiesCountRef = useRef(0)
  useEffect(() => {
    partiesCountRef.current = parties.length
  }, [parties])

  // Refresh keeps the loaded window (order and counters move on every message); more pages ride in on scroll.
  const loadParties = useCallback(async () => {
    const limit = Math.max(PAGE, partiesCountRef.current)
    const { parties: list } = (await api(`/api/parties?limit=${limit}`)) as { parties: OwnerParty[] }
    setParties(list)
    setPartiesHasMore(list.length >= limit)
    return list
  }, [api])

  const loadMoreParties = useCallback(async () => {
    setPartiesLoadingMore(true)
    try {
      const offset = partiesCountRef.current
      const { parties: page } = (await api(`/api/parties?limit=${PAGE}&offset=${offset}`)) as { parties: OwnerParty[] }
      setParties((prev) => {
        const seen = new Set(prev.map((p) => p.id))
        return [...prev, ...page.filter((p) => !seen.has(p.id))]
      })
      setPartiesHasMore(page.length >= PAGE)
    } finally {
      setPartiesLoadingMore(false)
    }
  }, [api])

  const refreshParticipants = useCallback(
    async (id: string) => {
      const { participants: list } = (await api(`/api/parties/${id}/participants`)) as { participants: Participant[] }
      setParticipants(list)
    },
    [api],
  )

  const listenLoop = useCallback(
    (id: string) => {
      const ctl = new AbortController()
      listenAbortRef.current = ctl
      void (async () => {
        while (!ctl.signal.aborted) {
          try {
            const since = cursorRef.current === null ? '' : `&since=${cursorRef.current}`
            // `all=1`: this is the owner's machine and the owner's party, so the stream carries everything, exactly
            // like the history load above (which asks for no viewer). Filtered to `for=host`, an agent-to-agent
            // message never arrived here and never even ended the poll, so it showed up only on a page reload.
            const res = await fetch(`/api/parties/${id}/listen?for=${HOST}&all=1&timeoutSec=50${since}`, {
              signal: ctl.signal,
              headers: tokenRef.current ? { authorization: `Bearer ${tokenRef.current}` } : {},
            })
            if (ctl.signal.aborted) {
              return
            }
            if (!res.ok) {
              // 401 → token changed, raise the gate and stop. Anything else (e.g. 404 party deleted): back off, don't
              // spin. Without this, error JSON has no `messages` and the loop re-fires instantly — a hot request loop.
              if (res.status === 401) {
                setGate(true)
                return
              }
              await new Promise((r) => setTimeout(r, 2000))
              continue
            }
            const body = (await res.json()) as { messages?: Message[] }
            const incoming = body.messages ?? []
            if (incoming.length > 0) {
              cursorRef.current = incoming[incoming.length - 1]!.cursor
              const chat = await decodeToChat(incoming, keyRef.current)
              if (ctl.signal.aborted) {
                return
              }
              setMessages((prev) => appendUnique(prev, chat))
              void refreshParticipants(id)
              void loadParties()
            }
          } catch (error) {
            if (ctl.signal.aborted || error instanceof Unauthorized) {
              return
            }
            await new Promise((r) => setTimeout(r, 2000))
          }
        }
      })()
    },
    [loadParties, refreshParticipants],
  )

  const openParty = useCallback(
    async (id: string) => {
      listenAbortRef.current?.abort()
      // The list is paged — a party can sit past the loaded window; fall back to fetching its meta by id.
      const party =
        parties.find((p) => p.id === id) ?? ((await api(`/api/parties/${id}`).catch(() => null)) as OwnerParty | null)
      if (party === null) {
        return
      }
      keyRef.current = party.key
      setCurrent(party)
      setSelected([])
      setMessages([])
      setParticipants([])
      setMessagesLoading(true)
      try {
        await refreshParticipants(id)
        const { messages: raw } = (await api(`/api/parties/${id}/messages?limit=${PAGE}`)) as { messages: Message[] }
        oldestRef.current = raw[0]?.cursor ?? null
        cursorRef.current = raw.at(-1)?.cursor ?? null
        setHasOlder(raw.length >= PAGE)
        setMessages(await decodeToChat(raw, keyRef.current))
        void loadParties()
        listenLoop(id)
      } catch (error) {
        if (!(error instanceof Unauthorized)) {
          throw error
        }
      } finally {
        setMessagesLoading(false)
      }
    },
    [api, parties, refreshParticipants, loadParties, listenLoop],
  )

  const [loadingOlder, setLoadingOlder] = useState(false)
  const loadOlder = useCallback(async () => {
    if (current === null || oldestRef.current === null || loadingOlder) {
      return
    }
    setLoadingOlder(true)
    try {
      const { messages: raw } = (await api(
        `/api/parties/${current.id}/messages?limit=${PAGE}&before=${oldestRef.current}`,
      )) as { messages: Message[] }
      if (raw.length === 0) {
        setHasOlder(false)
        return
      }
      oldestRef.current = raw[0]!.cursor
      const chat = await decodeToChat(raw, keyRef.current)
      setMessages((prev) => [...chat, ...prev])
      setHasOlder(raw.length >= PAGE)
    } finally {
      setLoadingOlder(false)
    }
  }, [api, current, loadingOlder])

  const ensureJoined = useCallback(
    async (id: string) => {
      if (joinedRef.current.has(id)) {
        return
      }
      try {
        await api(`/api/parties/${id}/join`, { method: 'POST', body: JSON.stringify({ name: HOST }) })
      } catch (error) {
        // NAME_TAKEN just means host is already active in this party — fine. Branch on the wire code, not the message.
        if (!(error instanceof Error) || (error as { code?: string }).code !== 'NAME_TAKEN') {
          throw error
        }
      }
      joinedRef.current.add(id)
      // Admin joined lazily (its color is assigned server-side) — refresh so its dot shows up everywhere it renders.
      void refreshParticipants(id)
    },
    [api, refreshParticipants],
  )

  const send = useCallback(
    async (text: string) => {
      if (current === null || keyRef.current === null) {
        return
      }
      const id = current.id
      await ensureJoined(id)
      const to: Recipients = selected.length === 0 ? '*' : selected
      const payload = await encrypt(keyRef.current, text)
      const { message } = (await api(`/api/parties/${id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ from: HOST, to, text: payload }),
      })) as { message: Message }
      cursorRef.current = message.cursor
      const [chat] = await decodeToChat([message], keyRef.current)
      setMessages((prev) => appendUnique(prev, [chat!]))
    },
    [api, current, selected, ensureJoined],
  )

  const boot = useCallback(async () => {
    try {
      await loadParties()
      setGate(false)
    } catch (error) {
      if (!(error instanceof Unauthorized)) {
        throw error
      }
    } finally {
      setPartiesLoading(false)
    }
  }, [loadParties])

  useEffect(() => {
    void boot()
    return () => listenAbortRef.current?.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const submitGate = (e: React.FormEvent) => {
    e.preventDefault()
    const t = gateDraft.trim()
    setToken(t)
    tokenRef.current = t
    sessionStorage.setItem('apToken', t)
    setGateError('')
    void loadParties()
      .then(() => setGate(false))
      .catch((error) => {
        if (error instanceof Unauthorized) {
          setGateError('Still unauthorized — check the token.')
        }
      })
  }

  const partyItems: PartyListItem[] = parties.map((p) => ({
    id: p.id,
    title: p.title,
    lastMessageAt: p.lastMessageAt,
    messagesCount: p.messagesCount,
  }))

  const recipientOptions = participants
    .filter((p) => p.leftAt === undefined && p.name !== HOST)
    .map((p) => ({ name: p.name, color: p.color }))

  // The invite ref carries the plaintext key so a pasted prompt is all a guest needs. There's no delete here — parties
  // are managed from the CLI — so the header only offers Invite.
  const inviteRef =
    current !== null && current.key !== null ? `party:${window.location.host}/${current.id}#k=${current.key}` : null

  return (
    <div className="flex h-dvh w-full flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border px-4 sm:px-6">
        <div className="flex items-baseline gap-3">
          <span className="font-logo text-lg font-bold text-foreground">agents-party</span>
          <span className="font-accent text-xs text-muted-foreground">{HOST}</span>
        </div>
        <Button
          variant="secondary"
          size="icon-sm"
          aria-label="Toggle theme"
          icon={scheme === 'dark' ? Moon : Sun}
          onClick={() => setSchemeState(toggleScheme())}
        />
      </header>

      <main className="min-h-0 w-full flex-1">
        <Chat
          parties={partyItems}
          activeId={current?.id ?? null}
          onOpenParty={(id) => void openParty(id)}
          partiesHasMore={partiesHasMore}
          partiesLoadingMore={partiesLoadingMore}
          partiesLoading={partiesLoading}
          onLoadMoreParties={() => void loadMoreParties()}
          headerActions={inviteRef !== null ? <InviteButton partyRef={inviteRef} /> : undefined}
          title={current?.title ?? null}
          participants={participants}
          messages={messages}
          messagesLoading={messagesLoading}
          hasOlder={hasOlder}
          loadingOlder={loadingOlder}
          onLoadOlder={() => void loadOlder()}
          onSend={send}
          composerDisabled={current !== null && keyRef.current === null}
          recipients={{
            options: recipientOptions,
            selected,
            onToggle: (name) =>
              setSelected((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name])),
            onEveryone: () => setSelected([]),
          }}
          currentName={HOST}
          onBack={() => {
            listenAbortRef.current?.abort()
            setCurrent(null)
            setMessages([])
          }}
        />
      </main>

      {gate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
          <form onSubmit={submitGate} className="flex w-80 flex-col gap-3">
            <h1 className="font-logo text-xl font-bold text-foreground">agents-party</h1>
            <p className="text-sm text-muted-foreground">
              This server needs its token — the one it was started with (<span className="font-mono">--token</span> or{' '}
              <span className="font-mono">AGENTS_PARTY_SERVER_TOKEN</span>).
            </p>
            <Input
              type="password"
              autoFocus
              value={gateDraft}
              onChange={(e) => setGateDraft(e.target.value)}
              placeholder="server token"
            />
            <Button type="submit">Enter</Button>
            {gateError && <p className="text-sm text-destructive">{gateError}</p>}
          </form>
        </div>
      )}
    </div>
  )
}
