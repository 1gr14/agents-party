import type { ReactNode } from 'react'
import type { Message, Participant } from '../../index.js'
import { useMemo, useState } from 'react'
import { looksLikeDiff, summarizeDiff } from '../../core/diff.js'
import { Badge } from '../components/badge.js'
import { Button } from '../components/button.js'
import { InfiniteScroll } from '../components/infinite-scroll.js'
import { cn } from '../utils.js'
import { PartyComposer } from './composer.js'
import { DiffCard, DiffModal } from './diff-modal.js'
import { MessageText, ParticipantDot } from './message.js'
import { PartySidebar, type PartyListItem } from './sidebar.js'

/** A message ready to render: the body is already decrypted (or `null` when it couldn't be). */
export type ChatMessage = Pick<Message, 'id' | 'kind' | 'from' | 'to' | 'ts'> & {
  /** Decrypted plaintext, or `null` when the key is wrong/missing. Empty for join/leave events. */
  text: string | null
}

/** Recipients multiselect: `selected` empty ⇒ everyone. The host owns the state; the chip row just toggles it. */
export interface RecipientsState {
  /** Addressable participants (active, excluding the current sender). */
  options: Pick<Participant, 'name' | 'color'>[]
  selected: string[]
  onToggle: (name: string) => void
  onEveryone: () => void
}

const timeLabel = (ts: number): string => new Date(ts).toLocaleTimeString()

/** A short label for the diff modal title bar: the file when there's one, else the file count. */
const diffTitle = (text: string): string => {
  const s = summarizeDiff(text)
  return s.firstFile ?? `${s.files} ${s.files === 1 ? 'file' : 'files'}`
}

export interface ChatProps {
  /** Left pane. */
  parties: PartyListItem[]
  activeId: string | null
  onOpenParty: (id: string) => void
  /** Party-list paging (scroll-driven): more registry pages exist / fetch the next one. */
  partiesHasMore?: boolean
  partiesLoadingMore?: boolean
  onLoadMoreParties?: () => void
  /** First party-list fetch still in flight — the sidebar shows a spinner instead of the "no parties yet" hint. */
  partiesLoading?: boolean
  /** Pinned above the party list (doesn't scroll) — the site puts its "create party" form here. */
  sidebarHeader?: ReactNode
  /** Actions for the open party's header, beside the title/participants — e.g. Invite / Delete. */
  headerActions?: ReactNode
  /** Current party (null ⇒ nothing opened yet). */
  title: string | null
  closed?: boolean
  participants: Participant[]
  messages: ChatMessage[]
  hasOlder?: boolean
  loadingOlder?: boolean
  onLoadOlder?: () => void
  onSend: (text: string) => Promise<void>
  composerDisabled?: boolean
  recipients: RecipientsState
  /** The viewer's own participant name — drives listen/send addressing (not shown as a marker). Defaults to `host`. */
  currentName?: string
  sidebarClassName?: string
  /** Close the opened party (small screens show either the list or the conversation — this is the way back). */
  onBack?: () => void
}

/** The two-pane party screen: party list on the left, the opened conversation on the right. */
export const Chat = ({
  parties,
  activeId,
  onOpenParty,
  partiesHasMore,
  partiesLoadingMore,
  onLoadMoreParties,
  partiesLoading,
  sidebarHeader,
  headerActions,
  title,
  closed,
  participants,
  messages,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  onSend,
  composerDisabled,
  recipients,
  sidebarClassName,
  onBack,
}: ChatProps) => {
  // One pane at a time on small screens: the list until a party is opened, then the conversation (with a back
  // button); side by side from `md` up.
  const sidebarClasses =
    sidebarClassName ?? cn('w-72 md:flex lg:w-80', title === null ? 'flex w-full md:w-72' : 'hidden')
  const colorOf = useMemo(() => {
    const map = new Map(participants.map((p) => [p.name, p.color]))
    return (name: string): string | undefined => map.get(name)
  }, [participants])

  // A diff message opens in a modal on click; null when nothing is open.
  const [openDiff, setOpenDiff] = useState<{ text: string; title: string } | null>(null)

  const recipientsRow = (
    <>
      <span>to:</span>
      <button
        type="button"
        onClick={recipients.onEveryone}
        className={cn(
          'rounded-full border border-border px-2.5 py-0.5 transition-colors select-none hover:bg-muted/60',
          recipients.selected.length === 0 && 'border-primary bg-primary text-primary-foreground hover:bg-primary',
        )}
      >
        everyone
      </button>
      {recipients.options.map((option) => {
        const on = recipients.selected.includes(option.name)
        return (
          <button
            key={option.name}
            type="button"
            onClick={() => recipients.onToggle(option.name)}
            className={cn(
              'flex items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 transition-colors select-none hover:bg-muted/60',
              on && 'border-primary bg-primary text-primary-foreground hover:bg-primary',
            )}
          >
            <ParticipantDot color={option.color} />
            {option.name}
          </button>
        )
      })}
    </>
  )

  return (
    <div className="flex h-full min-h-0 flex-1">
      <PartySidebar
        parties={parties}
        activeId={activeId}
        onOpen={onOpenParty}
        hasMore={partiesHasMore ?? false}
        isLoadingMore={partiesLoadingMore ?? false}
        loading={partiesLoading ?? false}
        header={sidebarHeader}
        {...(onLoadMoreParties === undefined ? {} : { onLoadMore: onLoadMoreParties })}
        className={sidebarClasses}
      />

      {title === null ? (
        <div className="hidden flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground md:flex">
          Pick a party on the left, or start a new one there. Your agents create parties themselves with{' '}
          <code className="mx-1 font-mono">agents-party create</code>
        </div>
      ) : (
        <div className="flex h-full min-w-0 flex-1 flex-col">
          {/* Same horizontal padding + min-height as the party-list header (`px-4 py-3 sm:px-6` + h-9 control). */}
          <div className="flex min-h-[3.75rem] flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3 sm:px-6">
            {onBack !== undefined && (
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 md:hidden"
                onClick={onBack}
                aria-label="back to the list"
              >
                ←
              </Button>
            )}
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="min-w-0 font-title text-lg font-semibold break-words text-accent-foreground">{title}</h1>
              {closed && <Badge variant="secondary">closed</Badge>}
              {/* Optical nudge: serif title + mono xs sit on different visual centers despite items-center. */}
              {participants.length === 0 ? (
                <span className="translate-y-px font-accent text-xs text-muted-foreground">
                  Nobody yet. Send the invite to your agents and friends
                </span>
              ) : (
                participants.map((participant) => (
                  <span
                    key={participant.name}
                    className="flex min-w-0 translate-y-px items-center gap-1.5 font-accent text-xs"
                  >
                    <ParticipantDot color={participant.color} />
                    <span
                      className={cn(
                        'min-w-0 font-semibold break-words text-foreground',
                        participant.leftAt !== undefined && 'text-muted-foreground line-through',
                      )}
                    >
                      {participant.name}
                    </span>
                    {participant.desc !== undefined && participant.desc !== '' && (
                      <span className="min-w-0 break-words text-muted-foreground">— {participant.desc}</span>
                    )}
                  </span>
                ))
              )}
            </div>
            {/* gap-1 matches the site header theme↔burger icon pair */}
            {headerActions !== undefined && <div className="flex shrink-0 items-center gap-1">{headerActions}</div>}
          </div>

          {/* Messages: virtualized reverse chat — stickKey jumps to latest on party open; prepends stay anchored. */}
          <InfiniteScroll
            data={messages}
            getItemKey={(message) => message.id}
            direction="up"
            estimateSize={88}
            stickKey={activeId ?? undefined}
            canLoadMore={hasOlder ?? false}
            isLoadingMore={loadingOlder ?? false}
            {...(onLoadOlder === undefined ? {} : { onLoadMore: onLoadOlder })}
            empty={<p className="px-4 py-4 text-sm text-muted-foreground sm:px-6">No messages yet.</p>}
            className="min-h-0 flex-1 px-4 pt-4 sm:px-6"
            renderItem={(message) =>
              message.kind === 'message' ? (
                <div className="flex flex-col gap-0.5 pb-3">
                  <div className="flex items-center gap-2 font-accent text-xs text-muted-foreground">
                    <ParticipantDot color={colorOf(message.from)} />
                    <span className="font-semibold text-foreground">{message.from}</span>
                    {message.to !== '*' && <span>→ {message.to.join(', ')}</span>}
                    <span>{timeLabel(message.ts)}</span>
                  </div>
                  <div className="max-w-3xl pl-4">
                    {message.text !== null && looksLikeDiff(message.text) ? (
                      <DiffCard
                        text={message.text}
                        onOpen={() =>
                          setOpenDiff({
                            text: message.text as string,
                            title: `${message.from} · ${diffTitle(message.text as string)}`,
                          })
                        }
                      />
                    ) : (
                      <MessageText text={message.text} />
                    )}
                  </div>
                </div>
              ) : (
                <p className="pb-3 font-accent text-xs text-muted-foreground italic">
                  {message.from} {message.kind === 'join' ? 'joined' : 'left'} · {timeLabel(message.ts)}
                </p>
              )
            }
          />

          {/* Input pinned to the bottom — placeholder defaults to "Message…" in PartyComposer. */}
          {!closed && <PartyComposer onSend={onSend} disabled={composerDisabled} toolbar={recipientsRow} />}
        </div>
      )}

      {openDiff !== null && <DiffModal text={openDiff.text} title={openDiff.title} onClose={() => setOpenDiff(null)} />}
    </div>
  )
}
