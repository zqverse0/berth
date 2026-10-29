import { create } from "zustand"
import type { ScrollToIndexOpts } from "virtua"
import type { MessageNavEntry } from "@/lib/message-navigation"

export interface MessageNavigationSnapshot {
  count: number
  entries: MessageNavEntry[]
  scrollToIndex: (index: number, opts?: ScrollToIndexOpts) => void
}

interface MessageNavigationState {
  open: boolean
  owner: number | null
  snapshot: MessageNavigationSnapshot | null
  setOpen: (open: boolean) => void
  setSnapshot: (owner: number, snapshot: MessageNavigationSnapshot) => void
  clear: (owner: number) => void
}

let nextOwner = 1

export function allocateMessageNavigationOwner(): number {
  const owner = nextOwner
  nextOwner += 1
  return owner
}

export const useMessageNavigationStore = create<MessageNavigationState>(
  (set) => ({
    open: false,
    owner: null,
    snapshot: null,
    setOpen: (open) =>
      set({
        open,
        ...(open ? {} : { owner: null, snapshot: null }),
      }),
    setSnapshot: (owner, snapshot) =>
      set((state) => ({ ...state, owner, snapshot })),
    clear: (owner) =>
      set((state) =>
        state.owner === owner
          ? { ...state, owner: null, snapshot: null }
          : state
      ),
  })
)
