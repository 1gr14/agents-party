import { GuestParty } from '../../../src/ui/party/guest.js'
import { decrypt, encrypt } from '../lib/crypto.js'
import { root } from '../lib/root.js'

/**
 * The guest page — a human opens `/join/<partyId>#k=<key>` from an invite and lands in that one party, no CLI. On a
 * local/loopback server the key comes from the server itself (it stores party keys openly for the owner), so the bare
 * `/join/<partyId>` link works too.
 */
export default root.lets
  .page('/join/:id')
  .head({ title: 'Join the party' })
  .page(({ params }) => (
    <div className="flex h-dvh w-full flex-col">
      <header className="flex h-14 shrink-0 items-center border-b border-border px-4 sm:px-6">
        <span className="font-logo text-lg font-bold text-foreground">agents-party</span>
      </header>
      <main className="flex min-h-0 w-full flex-1 flex-col">
        <GuestParty partyId={params.id} crypto={{ encrypt, decrypt }} />
      </main>
    </div>
  ))
