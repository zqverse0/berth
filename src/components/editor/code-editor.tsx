"use client"

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react"
import { Compartment, EditorState, type Extension } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import type {
  EditorAppearance,
  EditorCapabilities,
  EditorHandle,
} from "@/lib/editor/contracts"
import {
  editorDocumentRegistry,
  type EditorDocumentRuntime,
} from "@/lib/editor/document-registry"
import type {
  EditorLineMarker,
  EditorLineRange,
} from "@/lib/editor/visual-ranges"
import { createVisualRangeExtension } from "@/lib/editor/visual-ranges"
import {
  createAppearanceExtensions,
  createBaseExtensions,
  createCapabilityExtensions,
  openEditorSearch,
} from "@/lib/editor/extensions"

interface CodeEditorProps {
  documentId: string
  value: string
  appearance: EditorAppearance
  capabilities?: EditorCapabilities
  languageExtension?: Extension
  hiddenLineRanges?: readonly EditorLineRange[]
  lineMarkers?: readonly EditorLineMarker[]
  preserveState?: boolean
  className?: string
  onReady?: () => void
  onChange?: (value: string) => void
  onCursorLineChange?: (line: number) => void
  onSelectionChange?: (text: string, fromLine: number, toLine: number) => void
  onCompositionChange?: (composing: boolean) => void
}

export const CodeEditor = forwardRef<EditorHandle, CodeEditorProps>(
  function CodeEditor(
    {
      documentId,
      value,
      appearance,
      capabilities = {},
      languageExtension = [],
      hiddenLineRanges = [],
      lineMarkers = [],
      preserveState = true,
      className,
      onReady,
      onChange,
      onCursorLineChange,
      onSelectionChange,
      onCompositionChange,
    },
    forwardedRef
  ) {
    const hostRef = useRef<HTMLDivElement | null>(null)
    const viewRef = useRef<EditorView | null>(null)
    const initialValueRef = useRef(value)
    const callbacksRef = useRef({
      onChange,
      onCursorLineChange,
      onSelectionChange,
    })
    useEffect(() => {
      callbacksRef.current = {
        onChange,
        onCursorLineChange,
        onSelectionChange,
      }
    }, [onChange, onCursorLineChange, onSelectionChange])

    useImperativeHandle(
      forwardedRef,
      () => ({
        focus: () => viewRef.current?.focus(),
        getContent: () => viewRef.current?.state.doc.toString() ?? "",
        replaceContent: (content) => {
          const view = viewRef.current
          if (!view || content === view.state.doc.toString()) return
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: content },
          })
        },
        revealLine: (lineNumber) => {
          const view = viewRef.current
          if (!view) return null
          const line = view.state.doc.line(
            Math.min(Math.max(1, Math.floor(lineNumber)), view.state.doc.lines)
          )
          view.dispatch({
            selection: { anchor: line.from },
            effects: EditorView.scrollIntoView(line.from, { y: "center" }),
          })
          // 用户正在终端 / 输入框里打字时不抢焦点（如 Agent 执行 `berth open`）
          const active = document.activeElement
          const typingElsewhere =
            active instanceof HTMLElement &&
            !view.dom.contains(active) &&
            (active.isContentEditable || active.matches("input, textarea"))
          if (!typingElsewhere) view.focus()
          return view.state.doc.lineAt(view.state.selection.main.head).number
        },
        openSearch: () => {
          const view = viewRef.current
          if (view) openEditorSearch(view)
        },
        getView: () => viewRef.current,
      }),
      []
    )

    useLayoutEffect(() => {
      const host = hostRef.current
      if (!host) return

      const cached = preserveState
        ? editorDocumentRegistry.get(documentId)
        : undefined
      const appearanceSlot = cached?.appearance ?? new Compartment()
      const capabilitiesSlot = cached?.capabilities ?? new Compartment()
      const languageSlot = cached?.language ?? new Compartment()
      const visualsSlot = cached?.visuals ?? new Compartment()
      const callbacksSlot = cached?.callbacks ?? new Compartment()
      const updateListener = EditorView.updateListener.of((update) => {
        editorDocumentRegistry.updateState(documentId, update.state)
        if (update.docChanged) {
          callbacksRef.current.onChange?.(update.state.doc.toString())
        }
        if (update.selectionSet || update.docChanged) {
          const selection = update.state.selection.main
          const fromLine = update.state.doc.lineAt(selection.from).number
          const toLine = update.state.doc.lineAt(selection.to).number
          callbacksRef.current.onCursorLineChange?.(
            update.state.doc.lineAt(selection.head).number
          )
          callbacksRef.current.onSelectionChange?.(
            update.state.sliceDoc(selection.from, selection.to),
            fromLine,
            toLine
          )
        }
      })
      const state =
        cached?.state ??
        EditorState.create({
          doc: initialValueRef.current,
          extensions: [
            ...createBaseExtensions(),
            appearanceSlot.of(createAppearanceExtensions(appearance)),
            capabilitiesSlot.of(createCapabilityExtensions(capabilities)),
            languageSlot.of(languageExtension),
            visualsSlot.of(
              createVisualRangeExtension(hiddenLineRanges, lineMarkers)
            ),
            callbacksSlot.of(updateListener),
          ],
        })
      const view = new EditorView({ state, parent: host })
      const runtime: EditorDocumentRuntime = cached ?? {
        id: documentId,
        state,
        scrollTop: 0,
        appearance: appearanceSlot,
        capabilities: capabilitiesSlot,
        language: languageSlot,
        visuals: visualsSlot,
        callbacks: callbacksSlot,
      }
      view.dispatch({
        effects: [
          appearanceSlot.reconfigure(createAppearanceExtensions(appearance)),
          capabilitiesSlot.reconfigure(
            createCapabilityExtensions(capabilities)
          ),
          languageSlot.reconfigure(languageExtension),
          visualsSlot.reconfigure(
            createVisualRangeExtension(hiddenLineRanges, lineMarkers)
          ),
          callbacksSlot.reconfigure(updateListener),
        ],
      })
      viewRef.current = view
      runtime.state = view.state
      editorDocumentRegistry.set(runtime)
      if (runtime.scrollTop) view.scrollDOM.scrollTop = runtime.scrollTop

      return () => {
        runtime.state = view.state
        runtime.scrollTop = view.scrollDOM.scrollTop
        if (preserveState) editorDocumentRegistry.set(runtime)
        else editorDocumentRegistry.delete(documentId)
        view.destroy()
        viewRef.current = null
      }
      // 视图生命周期只由稳定文档身份控制，其他配置通过 Compartment 更新。
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [documentId])

    useEffect(() => {
      const view = viewRef.current
      const runtime = editorDocumentRegistry.get(documentId)
      if (!view || !runtime) return
      view.dispatch({
        effects: [
          runtime.appearance.reconfigure(
            createAppearanceExtensions(appearance)
          ),
          runtime.capabilities.reconfigure(
            createCapabilityExtensions(capabilities)
          ),
          runtime.language.reconfigure(languageExtension),
          runtime.visuals.reconfigure(
            createVisualRangeExtension(hiddenLineRanges, lineMarkers)
          ),
        ],
      })
    }, [
      appearance,
      capabilities,
      documentId,
      hiddenLineRanges,
      languageExtension,
      lineMarkers,
    ])

    useEffect(() => {
      const view = viewRef.current
      if (!view || view.state.doc.toString() === value) return
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
      })
    }, [value])

    // lazy 首次挂载和外部缓冲同步后，再通知调用方读取真实定位结果。
    useEffect(() => {
      if (viewRef.current) onReady?.()
    }, [documentId, onReady])

    useEffect(() => {
      const host = hostRef.current
      if (!host || !onCompositionChange) return
      const start = () => onCompositionChange(true)
      const end = () => onCompositionChange(false)
      host.addEventListener("compositionstart", start, true)
      host.addEventListener("compositionend", end, true)
      return () => {
        host.removeEventListener("compositionstart", start, true)
        host.removeEventListener("compositionend", end, true)
      }
    }, [onCompositionChange])

    return <div ref={hostRef} className={className ?? "h-full min-h-0"} />
  }
)
