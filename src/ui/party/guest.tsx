import { useCallback, useEffect, useRef, useState } from 'react'
import { validateParticipantName } from '../../core/names.js'
import type { Message, Participant, Recipients } from '../../core/types.js'
import { Button } from '../components/button.js'
import { Input } from '../components/input.js'
import { Chat, type ChatMessage } from './chat.js'

const PAGE = 50

/** Message-layer crypto, injected by the app (the site and the package web use different — byte-compatible — impls). */
export interface GuestCrypto {
  encrypt: (key: string, plaintext: string) => Promise<string>
  decrypt: (key: string, blob: string) => Promise<string | null>
}

/** The link's `#k=` fragment — the guest's key, and the only form of it that never reaches a server. */
const keyFromHash = (): string | null => {
  try {
    return new URLSearchParams(window.location.hash.slice(1)).get('k')
  } catch {
    return null
  }
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * Which key this guest page may use. The link's `#k=` fragment always wins — it is the only form that never reaches a
 * server. The meta's plaintext `key` is a fallback ONLY when the page itself is served from this machine: a
 * single-owner server stores party keys openly, and on loopback the reader is that owner. Off loopback the very same
 * meta is handed to anyone who opens the URL, so a bare `/join/<id>` must stay keyless instead of giving the party's
 * key to whoever the link reached.
 */
export const guestPartyKey = (opts: {
  fromHash: string | null
  fromMeta?: string | null
  hostname: string
}): string | null => opts.fromHash ?? (LOOPBACK_HOSTNAMES.has(opts.hostname) ? (opts.fromMeta ?? null) : null)

const storageKey = (partyId: string): string => `apGuestName:${partyId}`

const readStoredName = (partyId: string): string | null => {
  try {
    return localStorage.getItem(storageKey(partyId))
  } catch {
    return null
  }
}

/** Append incoming messages, dropping ids we already hold (a just-sent message can also arrive via an in-flight listen). */
const appendUnique = (prev: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] => {
  const seen = new Set(prev.map((m) => m.id))
  const fresh = incoming.filter((m) => !seen.has(m.id))
  return fresh.length === 0 ? prev : [...prev, ...fresh]
}

/** Same-origin fetch to the party API; non-ok responses become errors carrying the wire `code`. */
const api = async (path: string, opts: RequestInit = {}): Promise<any> => {
  const res = await fetch(path, {
    ...opts,
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...opts.headers },
  })
  const body = await res.json()
  if (!res.ok) {
    const err = new Error(typeof body?.message === 'string' ? body.message : String(res.status)) as Error & {
      code?: string
    }
    if (typeof body?.code === 'string') err.code = body.code
    throw err
  }
  return body
}

/** Centered card for every pre-chat state (nickname form, not-found, missing key). */
const GuestGate = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="flex min-h-0 flex-1 items-center justify-center p-6">
    <div className="flex w-full max-w-md flex-col gap-4 rounded-lg border border-border bg-card p-6">
      <h1 className="font-title text-xl font-semibold text-accent-foreground">{title}</h1>
      {children}
    </div>
  </div>
)

/**
 * The guest view of ONE party — what a HUMAN gets by opening a `/join/<partyId>#k=<key>` link in a browser: no account,
 * no party list, just this conversation. To the server a guest is exactly an agent (the open party endpoints:
 * join/messages/listen/participants by knowledge of the id); the key never leaves the browser. The nickname is asked
 * once and kept per party in localStorage; a rejoin under the stored name treats NAME_TAKEN as "already joined" — guest
 * names are honest-but-unverified until the identity feature, like any group chat joined by link.
 *
 * The key comes from the link's `#k=` fragment; the meta's plaintext `key` is a fallback only on a loopback page (see
 * {@link guestPartyKey}). Off the local machine a link without `#k=` opens keyless — the composer stays disabled and
 * messages render undecrypted — instead of the server handing the key to whoever opened it.
 *
 * Purely same-origin: every deployment (the site, self-hosted `agents-party web`) mounts it on its own guest page.
 */
export const GuestParty = ({ partyId, crypto }: { partyId: string; crypto: GuestCrypto }) => {
  const [meta, setMeta] = useState<{ title: string } | 'loading' | 'notFound'>('loading')
  const [name, setName] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [joining, setJoining] = useState(false)
  const [joinError, setJoinError] = useState('')

  const [participants, setParticipants] = useState<Participant[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [hasOlder, setHasOlder] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)

  const keyRef = useRef<string | null>(null)
  const cursorRef = useRef<string | null>(null) // newest seen — the long-poll `since`
  const oldestRef = useRef<string | null>(null) // oldest loaded — the `before` for older pages
  const listenAbortRef = useRef<AbortController | null>(null)

  const decodeToChat = useCallback(
    async (raw: Message[]): Promise<ChatMessage[]> =>
      Promise.all(
        raw.map(async (m) => ({
          id: m.id,
          kind: m.kind,
          from: m.from,
          to: m.to,
          ts: m.ts,
          text:
            m.kind !== 'message' ? null : keyRef.current === null ? null : await crypto.decrypt(keyRef.current, m.text),
        })),
      ),
    [crypto],
  )

  const refreshParticipants = useCallback(async () => {
    const { participants: list } = (await api(`/api/parties/${partyId}/participants`)) as {
      participants: Participant[]
    }
    setParticipants(list)
  }, [partyId])

  const listenLoop = useCallback(
    (as: string) => {
      const ctl = new AbortController()
      listenAbortRef.current = ctl
      // A getter, not a narrowed read — `aborted` flips externally (abort()), so the checks below are real.
      const aborted = (): boolean => ctl.signal.aborted
      void (async () => {
        while (!aborted()) {
          try {
            const since = cursorRef.current === null ? '' : `&since=${cursorRef.current}`
            const res = await fetch(
              `/api/parties/${partyId}/listen?for=${encodeURIComponent(as)}&timeoutSec=50${since}`,
              {
                signal: ctl.signal,
              },
            )
            if (aborted()) return
            if (!res.ok) {
              // Party deleted or server hiccup: back off instead of spinning a hot request loop.
              await new Promise((r) => setTimeout(r, 2000))
              continue
            }
            const body = (await res.json()) as { messages?: Message[] }
            const incoming = body.messages ?? []
            if (incoming.length > 0) {
              cursorRef.current = incoming[incoming.length - 1]!.cursor
              const chat = await decodeToChat(incoming)
              if (aborted()) return
              setMessages((prev) => appendUnique(prev, chat))
              void refreshParticipants()
            }
          } catch {
            if (aborted()) return
            await new Promise((r) => setTimeout(r, 2000))
          }
        }
      })()
    },
    [partyId, decodeToChat, refreshParticipants],
  )

  const enterChat = useCallback(
    async (as: string) => {
      setName(as)
      await refreshParticipants()
      const { messages: raw } = (await api(
        `/api/parties/${partyId}/messages?limit=${PAGE}&for=${encodeURIComponent(as)}`,
      )) as {
        messages: Message[]
      }
      oldestRef.current = raw[0]?.cursor ?? null
      cursorRef.current = raw.at(-1)?.cursor ?? null
      setHasOlder(raw.length >= PAGE)
      setMessages(await decodeToChat(raw))
      listenLoop(as)
    },
    [partyId, refreshParticipants, decodeToChat, listenLoop],
  )

  const join = useCallback(
    async (as: string): Promise<void> => {
      try {
        await api(`/api/parties/${partyId}/join`, { method: 'POST', body: JSON.stringify({ name: as, desc: 'human' }) })
      } catch (error) {
        // NAME_TAKEN on the name WE stored earlier just means our previous join is still active — proceed.
        const code = (error as { code?: string }).code
        const stored = readStoredName(partyId)
        if (code === 'NAME_TAKEN' && stored === as) return
        throw error
      }
    },
    [partyId],
  )

  const submitName = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault()
      const as = draft.trim()
      if (as === '' || joining) return
      setJoining(true)
      setJoinError('')
      try {
        validateParticipantName(as)
        await join(as)
        try {
          localStorage.setItem(storageKey(partyId), as)
        } catch {
          // private mode — the name just won't survive a reload
        }
        await enterChat(as)
      } catch (error) {
        setJoinError(error instanceof Error ? error.message : 'Could not join, try another name.')
      } finally {
        setJoining(false)
      }
    },
    [draft, joining, partyId, join, enterChat],
  )

  // Boot: read the key, fetch the meta; a returning guest (stored name) re-enters without the form.
  useEffect(() => {
    void (async () => {
      try {
        const raw = (await api(`/api/parties/${partyId}`)) as { title: string; key?: string | null }
        keyRef.current = guestPartyKey({
          fromHash: keyFromHash(),
          fromMeta: raw.key,
          hostname: window.location.hostname,
        })
        setMeta({ title: raw.title })
        const stored = readStoredName(partyId)
        if (stored !== null) {
          await join(stored)
          await enterChat(stored)
        }
      } catch {
        setMeta('notFound')
      }
    })()
    return () => listenAbortRef.current?.abort()
    // Deliberately keyed on the party alone: this is the one-time boot (meta + a returning guest's rejoin), and the
    // callbacks it calls are recreated on every render.
  }, [partyId])

  const loadOlder = useCallback(async () => {
    if (name === null || oldestRef.current === null || loadingOlder) return
    setLoadingOlder(true)
    try {
      const { messages: raw } = (await api(
        `/api/parties/${partyId}/messages?limit=${PAGE}&before=${oldestRef.current}&for=${encodeURIComponent(name)}`,
      )) as { messages: Message[] }
      if (raw.length === 0) {
        setHasOlder(false)
        return
      }
      oldestRef.current = raw[0]!.cursor
      const chat = await decodeToChat(raw)
      setMessages((prev) => [...chat, ...prev])
      setHasOlder(raw.length >= PAGE)
    } finally {
      setLoadingOlder(false)
    }
  }, [partyId, name, loadingOlder, decodeToChat])

  const send = useCallback(
    async (text: string) => {
      if (name === null || keyRef.current === null) return
      const to: Recipients = selected.length === 0 ? '*' : selected
      const payload = await crypto.encrypt(keyRef.current, text)
      const { message } = (await api(`/api/parties/${partyId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ from: name, to, text: payload }),
      })) as { message: Message }
      cursorRef.current = message.cursor
      const [chat] = await decodeToChat([message])
      setMessages((prev) => appendUnique(prev, [chat!]))
    },
    [partyId, name, selected, crypto, decodeToChat],
  )

  if (meta === 'loading') {
    return <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">Loading…</div>
  }

  if (meta === 'notFound') {
    return (
      <GuestGate title="Party not found">
        <p className="text-sm text-muted-foreground">
          This party does not exist (anymore). Check the link with whoever invited you.
        </p>
      </GuestGate>
    )
  }

  if (name === null) {
    return (
      <GuestGate title={`Join “${meta.title}”`}>
        <p className="text-sm text-muted-foreground">
          You were invited to this party, where agents and humans talk in one channel. Pick a name and you're in.
        </p>
        <form onSubmit={(event) => void submitName(event)} className="flex flex-col gap-3">
          <Input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="your name (e.g. sergei)"
            disabled={joining}
          />
          <Button type="submit" disabled={joining || draft.trim() === ''}>
            {joining ? 'Joining…' : 'Join the party'}
          </Button>
          {joinError !== '' && <p className="text-sm text-destructive">{joinError}</p>}
        </form>
      </GuestGate>
    )
  }

  const recipientOptions = participants
    .filter((p) => p.leftAt === undefined && p.name !== name)
    .map((p) => ({ name: p.name, color: p.color }))

  return (
    <Chat
      parties={[]}
      activeId={partyId}
      onOpenParty={() => {}}
      sidebarClassName="hidden"
      title={meta.title}
      participants={participants}
      messages={messages}
      hasOlder={hasOlder}
      loadingOlder={loadingOlder}
      onLoadOlder={() => void loadOlder()}
      onSend={send}
      composerDisabled={keyRef.current === null}
      recipients={{
        options: recipientOptions,
        selected,
        onToggle: (n) => setSelected((prev) => (prev.includes(n) ? prev.filter((x) => x !== n) : [...prev, n])),
        onEveryone: () => setSelected([]),
      }}
      currentName={name}
    />
  )
}
