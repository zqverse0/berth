"use client"

import {
  registerDocument as registerDocumentAction,
  clearDocument as clearDocumentAction,
} from "@/stores/document-context-store"
import type { DocumentContextDocument } from "@/stores/document-context-store"

export type { DocumentContextDocument } from "@/stores/document-context-store"

export interface DocumentContextActions {
  registerDocument: (document: DocumentContextDocument) => void
  clearDocument: (documentId?: string) => void
}

const documentContextActions: DocumentContextActions = {
  registerDocument: registerDocumentAction,
  clearDocument: clearDocumentAction,
}

/** 保留渲染器的稳定动作接口；文档快照与同步由 store 管理。 */
export function useDocumentContext(): DocumentContextActions {
  return documentContextActions
}
