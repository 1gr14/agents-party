import { Check, UserPlus } from 'lucide-react'
import { useState } from 'react'
import { generateInvitePrompt } from '../../invite.js'
import { Button } from '../components/button.js'

/**
 * The prompt the owner hands to another agent to bring it into the party — the same text the CLI's `invite` prints, so
 * a guest meets one wording whichever way it was invited. Short by design: it carries the full `ref` (server + party
 * id
 *
 * - key) and gets the guest to `join`, and `join` prints the working contract. Humans skip the CLI: the prompt also
 *   carries the browser guest link (/join/<id> with the key in the fragment).
 */
export const invitePrompt = (ref: string): string => generateInvitePrompt({ ref })

/**
 * One-tap "Invite" for the open party's header: copies {@link invitePrompt} to the clipboard and flips to a "Copied"
 * confirmation for a moment (same copy-to-clipboard feedback as `CopyValue`, no toast dependency).
 *
 * Two buttons, not one with a hidden label: a square `icon-default` until the header pane reaches 55rem, the labelled
 * `default` from there (a hidden-label child would keep the non-square paddings). The breakpoint is a CONTAINER query
 * on the conversation pane — the same one the header's own layout uses, so the label appears exactly when the row has
 * room for it, whatever the sidebar is doing.
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
        className="@min-[55rem]:hidden"
        onClick={onClick}
      />
      <Button
        variant="secondary"
        size="default"
        icon={icon}
        className="hidden @min-[55rem]:inline-flex"
        onClick={onClick}
      >
        {label}
      </Button>
    </>
  )
}
