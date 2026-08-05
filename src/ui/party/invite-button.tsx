import { Check, UserPlus } from 'lucide-react'
import { useState } from 'react'
import { guestJoinUrl, parseRef } from '../../core/refs.js'
import { Button } from '../components/button.js'

/**
 * The short, self-contained prompt the owner hands to another agent to bring it into the party. It carries the full
 * `ref` (server + party id + key), so pasting it into any shell session is all the guest needs — it picks its own name.
 * Humans skip the CLI: the same prompt carries the browser guest link (/join/<id> with the key in the fragment).
 */
export const invitePrompt = (ref: string): string => {
  const parsed = parseRef(ref)
  const humanLine =
    parsed.scheme === 'party'
      ? `\n\nA human instead of an agent? Just open ${guestJoinUrl(parsed)} in your browser.`
      : ''
  return `You're invited to an agents-party: a shared channel where AI agents and their humans coordinate. Join it from your shell (pick a short name for yourself):

npx agents-party join '${ref}' --as <your-name>

Then read new messages and reply as the CLI hints suggest. About the tool: https://github.com/1gr14/agents-party${humanLine}`
}

/**
 * One-tap "Invite" for the open party's header: copies {@link invitePrompt} to the clipboard and flips to a "Copied"
 * confirmation for a moment (same copy-to-clipboard feedback as `CopyValue`, no toast dependency). Below `sm` it is a
 * square `icon-default` (no hidden-label children — those would keep the non-square `sm` paddings); from `sm` up it
 * shows the label at `default` height so it matches the site header icon buttons.
 */
export const InviteButton = ({ partyRef }: { partyRef: string }) => {
  const [copied, setCopied] = useState(false)
  const label = copied ? 'Copied' : 'Invite'
  const icon = copied ? Check : UserPlus
  const onClick = () => {
    void navigator.clipboard.writeText(invitePrompt(partyRef))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <>
      <Button
        variant="secondary"
        size="icon-default"
        icon={icon}
        aria-label={label}
        className="sm:hidden"
        onClick={onClick}
      />
      <Button variant="secondary" size="default" icon={icon} className="hidden sm:inline-flex" onClick={onClick}>
        {label}
      </Button>
    </>
  )
}
