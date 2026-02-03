import { $, spawn } from "bun"
import path from "path"
import fs from "fs/promises"
import { Log } from "../util/log"
import { Global } from "../global"
import z from "zod"
import { Config } from "../config/config"
import { Instance } from "../project/instance"

export namespace Snapshot {
  const log = Log.create({ service: "snapshot" })

  // Safeguards for non-git directories
  const MAX_FILE_COUNT = 5000
  const GIT_ADD_TIMEOUT_MS = 10000 // 10 seconds

  // Default ignore patterns for snapshot (applied to non-git directories)
  const DEFAULT_IGNORE_PATTERNS = [
    "node_modules/",
    ".git/",
    "*.log",
    "*.tmp",
    ".DS_Store",
    "Thumbs.db",
    "*.pyc",
    "__pycache__/",
    ".env",
    ".venv/",
    "venv/",
    "dist/",
    "build/",
    ".cache/",
    "*.iso",
    "*.dmg",
    "*.zip",
    "*.tar.gz",
    "*.rar",
    "*.7z",
    "*.mp4",
    "*.mov",
    "*.avi",
    "*.mkv",
  ].join("\n")

  async function countFiles(dir: string, limit: number): Promise<number> {
    let count = 0
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (count >= limit) return count
        if (entry.name.startsWith(".")) continue // skip hidden
        if (entry.isDirectory()) {
          // Skip common large directories
          if (["node_modules", ".git", "venv", ".venv", "__pycache__", "dist", "build"].includes(entry.name)) continue
          count += await countFiles(path.join(dir, entry.name), limit - count)
        } else {
          count++
        }
      }
    } catch {
      // Ignore permission errors etc
    }
    return count
  }

  async function runWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    onTimeout: () => void,
  ): Promise<T | undefined> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<undefined>((resolve) => {
      timeoutId = setTimeout(() => {
        onTimeout()
        resolve(undefined)
      }, timeoutMs)
    })
    try {
      const result = await Promise.race([promise, timeoutPromise])
      clearTimeout(timeoutId)
      return result
    } catch {
      clearTimeout(timeoutId)
      return undefined
    }
  }

  export async function track() {
    const cfg = await Config.get()
    if (cfg.snapshot === false) return
    const git = gitdir()
    const isNewRepo = await fs.mkdir(git, { recursive: true })

    // For non-git projects, check file count before proceeding
    if (Instance.project.vcs !== "git") {
      const fileCount = await countFiles(Instance.worktree, MAX_FILE_COUNT + 1)
      if (fileCount > MAX_FILE_COUNT) {
        log.warn("skipping snapshots - too many files in non-git directory", {
          count: fileCount,
          limit: MAX_FILE_COUNT,
          worktree: Instance.worktree,
        })
        return
      }
    }

    if (isNewRepo) {
      await $`git init`
        .env({
          ...process.env,
          GIT_DIR: git,
          GIT_WORK_TREE: Instance.worktree,
        })
        .quiet()
        .nothrow()
      // Configure git to not convert line endings on Windows
      await $`git --git-dir ${git} config core.autocrlf false`.quiet().nothrow()

      // For non-git directories, add default ignore patterns
      if (Instance.project.vcs !== "git") {
        const excludeFile = path.join(git, "info", "exclude")
        await fs.mkdir(path.dirname(excludeFile), { recursive: true })
        await fs.writeFile(excludeFile, DEFAULT_IGNORE_PATTERNS)
        log.info("added default ignore patterns for non-git directory")
      }

      log.info("initialized")
    }

    // Run git add with timeout for safety
    const addPromise = $`git --git-dir ${git} --work-tree ${Instance.worktree} add .`
      .quiet()
      .cwd(Instance.directory)
      .nothrow()

    const addResult = await runWithTimeout(addPromise, GIT_ADD_TIMEOUT_MS, () => {
      log.warn("git add timed out - directory may be too large", {
        timeout: GIT_ADD_TIMEOUT_MS,
        worktree: Instance.worktree,
      })
    })

    if (!addResult) {
      return // Timed out
    }

    const hash = await $`git --git-dir ${git} --work-tree ${Instance.worktree} write-tree`
      .quiet()
      .cwd(Instance.directory)
      .nothrow()
      .text()
    log.info("tracking", { hash, cwd: Instance.directory, git })
    return hash.trim()
  }

  export const Patch = z.object({
    hash: z.string(),
    files: z.string().array(),
  })
  export type Patch = z.infer<typeof Patch>

  export async function patch(hash: string): Promise<Patch> {
    const git = gitdir()
    await $`git --git-dir ${git} --work-tree ${Instance.worktree} add .`.quiet().cwd(Instance.directory).nothrow()
    const result =
      await $`git -c core.autocrlf=false --git-dir ${git} --work-tree ${Instance.worktree} diff --no-ext-diff --name-only ${hash} -- .`
        .quiet()
        .cwd(Instance.directory)
        .nothrow()

    // If git diff fails, return empty patch
    if (result.exitCode !== 0) {
      log.warn("failed to get diff", { hash, exitCode: result.exitCode })
      return { hash, files: [] }
    }

    const files = result.text()
    return {
      hash,
      files: files
        .trim()
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => path.join(Instance.worktree, x)),
    }
  }

  export async function restore(snapshot: string) {
    log.info("restore", { commit: snapshot })
    const git = gitdir()
    const result =
      await $`git --git-dir ${git} --work-tree ${Instance.worktree} read-tree ${snapshot} && git --git-dir ${git} --work-tree ${Instance.worktree} checkout-index -a -f`
        .quiet()
        .cwd(Instance.worktree)
        .nothrow()

    if (result.exitCode !== 0) {
      log.error("failed to restore snapshot", {
        snapshot,
        exitCode: result.exitCode,
        stderr: result.stderr.toString(),
        stdout: result.stdout.toString(),
      })
    }
  }

  export async function revert(patches: Patch[]) {
    const files = new Set<string>()
    const git = gitdir()
    for (const item of patches) {
      for (const file of item.files) {
        if (files.has(file)) continue
        log.info("reverting", { file, hash: item.hash })
        const result = await $`git --git-dir ${git} --work-tree ${Instance.worktree} checkout ${item.hash} -- ${file}`
          .quiet()
          .cwd(Instance.worktree)
          .nothrow()
        if (result.exitCode !== 0) {
          const relativePath = path.relative(Instance.worktree, file)
          const checkTree =
            await $`git --git-dir ${git} --work-tree ${Instance.worktree} ls-tree ${item.hash} -- ${relativePath}`
              .quiet()
              .cwd(Instance.worktree)
              .nothrow()
          if (checkTree.exitCode === 0 && checkTree.text().trim()) {
            log.info("file existed in snapshot but checkout failed, keeping", {
              file,
            })
          } else {
            log.info("file did not exist in snapshot, deleting", { file })
            await fs.unlink(file).catch(() => {})
          }
        }
        files.add(file)
      }
    }
  }

  export async function diff(hash: string) {
    const git = gitdir()
    await $`git --git-dir ${git} --work-tree ${Instance.worktree} add .`.quiet().cwd(Instance.directory).nothrow()
    const result =
      await $`git -c core.autocrlf=false --git-dir ${git} --work-tree ${Instance.worktree} diff --no-ext-diff ${hash} -- .`
        .quiet()
        .cwd(Instance.worktree)
        .nothrow()

    if (result.exitCode !== 0) {
      log.warn("failed to get diff", {
        hash,
        exitCode: result.exitCode,
        stderr: result.stderr.toString(),
        stdout: result.stdout.toString(),
      })
      return ""
    }

    return result.text().trim()
  }

  export const FileDiff = z
    .object({
      file: z.string(),
      before: z.string(),
      after: z.string(),
      additions: z.number(),
      deletions: z.number(),
    })
    .meta({
      ref: "FileDiff",
    })
  export type FileDiff = z.infer<typeof FileDiff>
  export async function diffFull(from: string, to: string): Promise<FileDiff[]> {
    const git = gitdir()
    const result: FileDiff[] = []
    for await (const line of $`git -c core.autocrlf=false --git-dir ${git} --work-tree ${Instance.worktree} diff --no-ext-diff --no-renames --numstat ${from} ${to} -- .`
      .quiet()
      .cwd(Instance.directory)
      .nothrow()
      .lines()) {
      if (!line) continue
      const [additions, deletions, file] = line.split("\t")
      const isBinaryFile = additions === "-" && deletions === "-"
      const before = isBinaryFile
        ? ""
        : await $`git -c core.autocrlf=false --git-dir ${git} --work-tree ${Instance.worktree} show ${from}:${file}`
            .quiet()
            .nothrow()
            .text()
      const after = isBinaryFile
        ? ""
        : await $`git -c core.autocrlf=false --git-dir ${git} --work-tree ${Instance.worktree} show ${to}:${file}`
            .quiet()
            .nothrow()
            .text()
      result.push({
        file,
        before,
        after,
        additions: parseInt(additions),
        deletions: parseInt(deletions),
      })
    }
    return result
  }

  function gitdir() {
    const project = Instance.project
    return path.join(Global.Path.data, "snapshot", project.id)
  }
}
