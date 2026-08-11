/**
 * agents-party/ui — the reusable chat components (React + Tailwind, no Point0). The package's own web app renders them;
 * the site imports the same compiled components so the two stay in visual lockstep. All data arrives via props — with
 * one deliberate exception: {@link GuestParty} talks to the party API itself (same-origin fetch), because the guest
 * experience is identical on every deployment and only the crypto impl differs (injected via props).
 */

export { cn } from './utils.js'

// Browser-safe core helpers the guest page needs (pure — no node imports)
export { HOST_NAME, validateParticipantName } from '../core/names.js'
export { guestJoinUrl, parseRef, formatPartyRef, serverBaseUrl } from '../core/refs.js'
export { PartyError } from '../core/errors.js'

// Primitives
export { Button, buttonVariants, type ButtonProps, type ButtonSize, type IconType } from './components/button.js'
export { Textarea } from './components/textarea.js'
export { Input, inputVariants } from './components/input.js'
export { Badge, badgeVariants, type BadgeVariant } from './components/badge.js'
export { InfiniteScroll, type InfiniteScrollProps } from './components/infinite-scroll.js'
export { Menu, type MenuOption } from './components/menu.js'

// Party pieces
export { CopyValue } from './party/copy-value.js'
export { InviteButton, invitePrompt } from './party/invite-button.js'
export { DeletePartyButton } from './party/delete-party-button.js'
export { MessageText, ParticipantDot, participantDotClass } from './party/message.js'
export { DiffCard, DiffModal } from './party/diff-modal.js'
export { PartyComposer } from './party/composer.js'
export { PartySidebar, type PartyListItem } from './party/sidebar.js'
export { Chat, type ChatMessage, type ChatProps, type RecipientsState } from './party/chat.js'
export { chatViewModes, isVisibleInView, type ChatViewMode } from './party/view-mode.js'
export { GuestParty, type GuestCrypto } from './party/guest.js'
