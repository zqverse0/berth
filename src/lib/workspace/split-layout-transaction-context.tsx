"use client"

import { createContext, useContext, type ReactNode } from "react"
import type { SplitLayoutTransaction } from "@/lib/workspace/split-layout-transaction"

const SplitLayoutTransactionContext =
  createContext<SplitLayoutTransaction | null>(null)

export function SplitLayoutTransactionProvider({
  transaction,
  children,
}: {
  transaction: SplitLayoutTransaction
  children: ReactNode
}) {
  return (
    <SplitLayoutTransactionContext.Provider value={transaction}>
      {children}
    </SplitLayoutTransactionContext.Provider>
  )
}

export function useSplitLayoutTransaction(): SplitLayoutTransaction | null {
  return useContext(SplitLayoutTransactionContext)
}
