import { Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '../components/button.js'

/**
 * "Delete" for the open party's header, behind a confirmation the user has to read. Purely presentational: it asks,
 * then calls `onDelete` — clearing the open party and refreshing the list is the host's job.
 *
 * Two triggers, not one with a hidden label, and the same 55rem CONTAINER query `InviteButton` uses, so the whole row
 * changes shape at one moment. The dialog is hand-rolled (the package ships no headless-dialog dependency): Escape and
 * the backdrop keep the party, and the cancel button takes focus so a stray Enter cannot delete anything.
 */
export const DeletePartyButton = ({ title, onDelete }: { title: string; onDelete: () => Promise<void> | void }) => {
  const [asking, setAsking] = useState(false)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    if (!asking) {
      return
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setAsking(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [asking])

  const confirm = async (): Promise<void> => {
    setDeleting(true)
    try {
      await onDelete()
      setAsking(false)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <Button
        variant="destructive"
        size="icon-default"
        icon={Trash2}
        aria-label="Delete party"
        className="@min-[55rem]:hidden"
        onClick={() => setAsking(true)}
      />
      <Button
        variant="destructive"
        size="default"
        icon={Trash2}
        className="hidden @min-[55rem]:inline-flex"
        onClick={() => setAsking(true)}
      >
        Delete
      </Button>

      {asking && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setAsking(false)}
          role="presentation"
        >
          <div
            className="flex w-full max-w-md flex-col gap-3 rounded-lg border border-border bg-card p-5 text-card-foreground shadow-xl"
            onClick={(event) => event.stopPropagation()}
            role="alertdialog"
            aria-modal="true"
            aria-label={`Delete ${title}`}
          >
            <h2 className="font-title text-base font-semibold text-accent-foreground">Delete “{title}” forever?</h2>
            <p className="text-sm text-muted-foreground">
              Every message, participant and invite of this party is erased permanently. There is no undo and no
              recovery. Agents holding the ref will get “party not found”.
            </p>
            <div className="mt-1 flex justify-end gap-2">
              <Button variant="secondary" autoFocus onClick={() => setAsking(false)} disabled={deleting}>
                Keep the party
              </Button>
              <Button variant="destructive" onClick={() => void confirm()} disabled={deleting}>
                {deleting ? 'Deleting…' : 'Delete forever'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
