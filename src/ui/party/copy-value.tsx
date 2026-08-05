import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { Button } from '../components/button.js'

/** A labelled, monospaced value with a one-tap copy button — for refs, invite tokens and the like. */
export const CopyValue = ({ value, label }: { value: string; label: string }) => {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-1.5">
      <span className="shrink-0 font-accent text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{value}</span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Copy ${label}`}
        icon={copied ? Check : Copy}
        onClick={() => {
          void navigator.clipboard.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        }}
      />
    </div>
  )
}
