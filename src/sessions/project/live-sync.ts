import { subscribe } from "@/lib/platform"
import {
  CONVERSATION_CHANGED_EVENT,
  type ConversationChange,
} from "@/lib/types"
import { applyProjectSessionConversationChange } from "./cache"

let consumers = 0
let generation = 0
let unsubscribes: Array<() => void> = []

export function retainProjectSessionLiveSync(): () => void {
  consumers += 1
  if (consumers === 1) {
    const currentGeneration = ++generation
    const subscriptions = [
      subscribe<ConversationChange>(
        CONVERSATION_CHANGED_EVENT,
        applyProjectSessionConversationChange
      ),
    ]
    for (const subscription of subscriptions) {
      void subscription
        .then((dispose) => {
          if (currentGeneration !== generation || consumers === 0) dispose()
          else unsubscribes.push(dispose)
        })
        .catch(() => {
          // Session listing remains available through the request path. A
          // later zero-to-one consumer transition retries subscriptions.
        })
    }
  }

  let released = false
  return () => {
    if (released) return
    released = true
    consumers = Math.max(0, consumers - 1)
    if (consumers === 0) {
      generation += 1
      for (const unsubscribe of unsubscribes) unsubscribe()
      unsubscribes = []
    }
  }
}
