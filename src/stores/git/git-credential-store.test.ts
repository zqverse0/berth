import { afterEach, describe, expect, it, vi } from "vitest"
import type { GitCredentials } from "@/lib/types"
import {
  resetGitCredentialStore,
  useGitCredentialStore,
  withCredentialRetry,
  type GitRemoteHint,
} from "./git-credential-store"

const { getGitHubAccounts, saveAccountToken, updateGitHubAccounts } =
  vi.hoisted(() => ({
    getGitHubAccounts: vi.fn(),
    saveAccountToken: vi.fn(),
    updateGitHubAccounts: vi.fn(),
  }))

vi.mock("@/lib/api", () => ({
  gitListRemotes: vi.fn(),
  validateGitHubToken: vi.fn(),
  getGitHubAccounts,
  saveAccountToken,
  updateGitHubAccounts,
}))

// openUrl 会动态 import Tauri 插件,jsdom 下不可用
vi.mock("@/lib/platform", () => ({ openUrl: vi.fn() }))

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  vi.clearAllMocks()
  resetGitCredentialStore()
})

const AUTH_ERROR = new Error("authentication failed")

describe("withCredentialRetry", () => {
  it("第一次成功时不弹对话框", async () => {
    const op = vi.fn().mockResolvedValue("ok")
    const result = await withCredentialRetry(op, { remoteUrl: "x" })
    expect(result).toBe("ok")
    expect(useGitCredentialStore.getState().open).toBe(false)
  })

  it("非认证错误直接抛出", async () => {
    const op = vi.fn().mockRejectedValue(new Error("network down"))
    await expect(
      withCredentialRetry(op, { remoteUrl: "https://gitlab.com/a" })
    ).rejects.toThrow("network down")
    expect(useGitCredentialStore.getState().open).toBe(false)
  })

  it("认证失败后按 remote 打开 generic 对话框,提交后重试成功", async () => {
    const hint: GitRemoteHint = { remoteUrl: "https://gitlab.com/a.git" }
    const creds: GitCredentials = { username: "u", password: "p" }
    // 第一次无凭据失败;带凭据成功
    const op = vi
      .fn<(credentials?: GitCredentials) => Promise<string>>()
      .mockRejectedValueOnce(AUTH_ERROR)
      .mockImplementationOnce((c) => {
        expect(c).toEqual(creds)
        return Promise.resolve("done")
      })

    const pending = withCredentialRetry(op, hint)
    await tick()

    // 对话框已打开,generic 模式
    expect(useGitCredentialStore.getState().open).toBe(true)
    expect(useGitCredentialStore.getState().mode).toBe("generic")
    expect(useGitCredentialStore.getState().remoteHost).toBe("gitlab.com")

    // 模拟用户输入并提交
    const s = useGitCredentialStore.getState()
    s.setUsername("u")
    s.setPassword("p")
    s.setSaveCredentials(false) // 关闭保存,避免走 account 写入分支
    s.submit()

    await expect(pending).resolves.toBe("done")
    expect(useGitCredentialStore.getState().open).toBe(false)
  })

  it("取消对话框时抛出原始错误", async () => {
    const op = vi
      .fn<(credentials?: GitCredentials) => Promise<string>>()
      .mockRejectedValueOnce(AUTH_ERROR)
      .mockResolvedValue("never")

    const pending = withCredentialRetry(op, { remoteUrl: "https://x.com/a" })
    await tick()
    useGitCredentialStore.getState().cancel()

    await expect(pending).rejects.toThrow("authentication failed")
    expect(useGitCredentialStore.getState().open).toBe(false)
  })

  it("重试仍认证失败时进入重试等待,再提交新凭据成功", async () => {
    const hint: GitRemoteHint = { remoteUrl: "https://gitlab.com/a.git" }
    const op = vi
      .fn<(credentials?: GitCredentials) => Promise<string>>()
      .mockRejectedValueOnce(AUTH_ERROR) // 无凭据
      .mockRejectedValueOnce(AUTH_ERROR) // 第一次凭据
      .mockImplementationOnce((c) => Promise.resolve(`ok:${c?.username}`))

    const pending = withCredentialRetry(op, hint)
    await tick()

    const s1 = useGitCredentialStore.getState()
    s1.setUsername("u1")
    s1.setPassword("p1")
    s1.setSaveCredentials(false)
    s1.submit()
    await tick()

    // 重试再次认证失败 → 重试等待态:invalid 哨兵 + submitting 复位
    const s2 = useGitCredentialStore.getState()
    expect(s2.open).toBe(true)
    expect(s2.error).toEqual({ invalid: true })
    expect(s2.submitting).toBe(false)

    // 用户改密码重试
    s2.setPassword("p2")
    s2.submit()

    await expect(pending).resolves.toBe("ok:u1")
    expect(useGitCredentialStore.getState().open).toBe(false)
  })
})

describe("输入行为", () => {
  it("文本输入清除错误", () => {
    useGitCredentialStore.setState({ error: { invalid: true } })
    useGitCredentialStore.getState().setUsername("a")
    expect(useGitCredentialStore.getState().error).toBeNull()
  })

  it("resetGitCredentialStore 恢复初始态", () => {
    useGitCredentialStore.setState({ open: true, token: "t", mode: "github" })
    resetGitCredentialStore()
    const s = useGitCredentialStore.getState()
    expect(s.open).toBe(false)
    expect(s.token).toBe("")
    expect(s.mode).toBe("generic")
  })
})
