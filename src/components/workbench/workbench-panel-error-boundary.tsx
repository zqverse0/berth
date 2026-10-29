"use client"

import { Component, type ReactNode } from "react"

type WorkbenchPanelErrorBoundaryProps = {
  children: ReactNode
  fallback: ReactNode
  /** 切换面板时清掉错误态，Tab 栏仍可继续选。 */
  resetKey?: string
}

type WorkbenchPanelErrorBoundaryState = {
  hasError: boolean
}

export class WorkbenchPanelErrorBoundary extends Component<
  WorkbenchPanelErrorBoundaryProps,
  WorkbenchPanelErrorBoundaryState
> {
  state: WorkbenchPanelErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): WorkbenchPanelErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch() {
    // 面板渲染错误已由 getDerivedStateFromError 隔离
  }

  componentDidUpdate(prevProps: WorkbenchPanelErrorBoundaryProps) {
    if (this.state.hasError && this.props.resetKey !== prevProps.resetKey) {
      this.setState({ hasError: false })
    }
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback
    }
    return this.props.children
  }
}
