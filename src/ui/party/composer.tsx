import { Send } from 'lucide-react'
import { type ReactNode, useRef, useState } from 'react'
import { Button } from '../components/button.js'
import { Textarea } from '../components/textarea.js'

const MAX_HEIGHT_PX = 144 // ~6 lines, then the textarea scrolls inside

/**
 * The chat input pinned to the bottom of the conversation: auto-grows while typing, Enter sends, Shift+Enter breaks the
 * line. Purely presentational — it hands the trimmed text to `onSend` and never touches the network itself. An optional
 * `toolbar` (e.g. the recipients row) renders in the section's top padding.
 *
 * The whole section reads as one field: it has a top divider and inner padding but no frame around the textarea, and a
 * click anywhere inside it (except the send button and a toolbar chip) focuses the textarea. Send is an icon button
 * with a generous hit area.
 */
export const PartyComposer = ({
  onSend,
  disabled,
  placeholder = 'Message…',
  toolbar,
}: {
  onSend: (text: string) => Promise<void>
  disabled?: boolean
  placeholder?: string
  toolbar?: ReactNode
}) => {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const canSend = !disabled

  const autoGrow = () => {
    const el = textareaRef.current
    if (!el) {
      return
    }
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`
  }

  const send = async () => {
    const trimmed = text.trim()
    if (!trimmed || !canSend || sending) {
      return
    }
    setSending(true)
    try {
      await onSend(trimmed)
      setText('')
      autoGrow()
    } finally {
      setSending(false)
      textareaRef.current?.focus()
    }
  }

  return (
    <div
      className="cursor-text border-t border-border bg-background px-4 py-2 sm:px-6"
      onMouseDown={(event) => {
        // Clicking the padding (anywhere but the textarea itself, the send button or a toolbar chip) focuses the field,
        // so the whole section behaves like one input.
        const target = event.target as HTMLElement
        if (target === textareaRef.current || target.closest('button') !== null) {
          return
        }
        event.preventDefault()
        textareaRef.current?.focus()
      }}
    >
      {toolbar !== undefined && (
        // `px-1` matches the textarea's horizontal padding so "to:" lines up with the placeholder.
        <div className="mb-1.5 flex max-w-3xl flex-wrap items-center gap-2 px-1 font-accent text-xs text-muted-foreground">
          {toolbar}
        </div>
      )}
      {/* Same measure as a message body in the chat: reading and writing line up instead of the input running to the bezel. */}
      <div className="flex max-w-3xl items-end gap-1">
        <Textarea
          ref={textareaRef}
          value={text}
          rows={1}
          disabled={!canSend}
          placeholder={placeholder}
          className="max-h-36 min-h-9 flex-1 resize-none overflow-y-auto border-0 bg-transparent px-1 py-1.5 shadow-none focus-visible:border-transparent dark:bg-transparent"
          onChange={(event) => {
            setText(event.target.value)
            autoGrow()
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
        />
        <Button
          variant="ghost"
          size="icon-default"
          icon={Send}
          aria-label="Send message"
          onClick={() => void send()}
          disabled={!canSend || !text.trim() || sending}
        />
      </div>
    </div>
  )
}
