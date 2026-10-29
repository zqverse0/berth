import type {
  AgentContractDiagnostic,
  ContractDiagnosticSeverity,
} from "./model"

export interface DiagnosticSummary {
  code: string
  domain: string
  severity: ContractDiagnosticSeverity
  pointer: string
  message: string
  recovery?: string
  line?: number
  column?: number
}

/** Central frontend projection for backend and local contract diagnostics. */
export function projectContractDiagnostics(
  diagnostics: readonly AgentContractDiagnostic[]
): DiagnosticSummary[] {
  return diagnostics.map((diagnostic) => ({
    code: diagnostic.code ?? "contract.legacy_diagnostic",
    domain: diagnostic.domain ?? "normalize",
    severity: diagnostic.severity ?? "warning",
    pointer: diagnostic.pointer ?? diagnostic.path,
    message: diagnostic.message,
    recovery: diagnostic.recovery,
    line: diagnostic.line,
    column: diagnostic.column,
  }))
}

export function localDiagnostic(
  message: string,
  pointer = "/",
  severity: ContractDiagnosticSeverity = "error",
  code = "presentation.local_validation"
): AgentContractDiagnostic {
  return {
    code,
    domain: "presentation",
    severity,
    contractId: "",
    pointer,
    messageKey: "",
    file: "",
    path: pointer,
    message,
  }
}
