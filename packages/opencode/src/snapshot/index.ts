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

  // Commit metadata schema
  export const CommitInfo = z.object({
    hash: z.string(),
    treeHash: z.string(),
    parentHash: z.string().optional(),
    message: z.string(),
    messageID: z.string().optional(),
    sessionID: z.string().optional(),
    files: z.string().array(),
    timestamp: z.number(),
  })
  export type CommitInfo = z.infer<typeof CommitInfo>

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

  // Returns file count, or null if permission error encountered (signals unsafe to proceed)
  async function countFiles(dir: string, limit: number): Promise<number | null> {
    let count = 0
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (count >= limit) return count
        if (entry.name.startsWith(".")) continue // skip hidden
        if (entry.isDirectory()) {
          // Skip common large directories
          if (["node_modules", ".git", "venv", ".venv", "__pycache__", "dist", "build"].includes(entry.name)) continue
          const subCount = await countFiles(path.join(dir, entry.name), limit - count)
          if (subCount === null) return null // propagate permission error
          count += subCount
        } else {
          count++
        }
      }
    } catch (err: any) {
      // Permission denied or other access errors - can't safely snapshot
      if (err?.code === "EACCES" || err?.code === "EPERM") {
        log.warn("permission error while counting files", { dir, error: err.code })
        return null
      }
      // Other errors (e.g., ENOENT for race conditions) - just skip that entry
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

  export interface TrackOptions {
    message?: string
    messageID?: string
    sessionID?: string
  }

  // Get the current HEAD commit hash (if any)
  async function getHead(): Promise<string | undefined> {
    const git = gitdir()
    const headFile = path.join(git, "refs", "heads", "opencode")
    try {
      const content = await fs.readFile(headFile, "utf-8")
      return content.trim() || undefined
    } catch {
      return undefined
    }
  }

  // Update the HEAD ref to point to a new commit
  async function updateHead(commitHash: string): Promise<void> {
    const git = gitdir()
    const refsDir = path.join(git, "refs", "heads")
    await fs.mkdir(refsDir, { recursive: true })
    await fs.writeFile(path.join(refsDir, "opencode"), commitHash + "\n")
  }

  export async function track(options: TrackOptions = {}): Promise<string | undefined> {
    const cfg = await Config.get()
    if (cfg.snapshot === false) return
    const git = gitdir()
    const isNewRepo = await fs.mkdir(git, { recursive: true })

    // For non-git projects, check file count before proceeding
    if (Instance.project.vcs !== "git") {
      const fileCount = await countFiles(Instance.worktree, MAX_FILE_COUNT + 1)
      if (fileCount === null) {
        log.warn("skipping snapshots - permission error accessing directory", {
          worktree: Instance.worktree,
        })
        return
      }
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

    // Write tree to get the tree hash
    const treeHash = (
      await $`git --git-dir ${git} --work-tree ${Instance.worktree} write-tree`
        .quiet()
        .cwd(Instance.directory)
        .nothrow()
        .text()
    ).trim()

    if (!treeHash) {
      log.warn("failed to write tree")
      return
    }

    // Get parent commit (if any)
    const parentHash = await getHead()

    // Check if tree has changed from parent
    if (parentHash) {
      const parentTreeHash = (
        await $`git --git-dir ${git} rev-parse ${parentHash}^{tree}`.quiet().nothrow().text()
      ).trim()

      // If tree hasn't changed, return the parent commit hash
      if (parentTreeHash === treeHash) {
        log.info("no changes, returning existing commit", { parentHash, treeHash })
        return parentHash
      }
    }

    // Build commit message with metadata
    const message = options.message || "Snapshot"
    const metadata: Record<string, string> = {}
    if (options.messageID) metadata.messageID = options.messageID
    if (options.sessionID) metadata.sessionID = options.sessionID

    const commitMessage =
      Object.keys(metadata).length > 0
        ? `${message}\n\n---\n${Object.entries(metadata)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\n")}`
        : message

    // Create commit with commit-tree
    const commitArgs = parentHash ? ["-p", parentHash] : []
    const commitHash = (
      await $`git --git-dir ${git} commit-tree ${treeHash} ${commitArgs} -m ${commitMessage}`
        .quiet()
        .cwd(Instance.directory)
        .nothrow()
        .text()
    ).trim()

    if (!commitHash) {
      log.warn("failed to create commit")
      return treeHash // Fall back to tree hash for backwards compatibility
    }

    // Update HEAD ref
    await updateHead(commitHash)

    log.info("tracking", { commitHash, treeHash, parentHash, message, cwd: Instance.directory, git })
    return commitHash
  }

  // Legacy track function for backwards compatibility (returns tree hash)
  export async function trackTree(): Promise<string | undefined> {
    const cfg = await Config.get()
    if (cfg.snapshot === false) return
    const git = gitdir()
    await fs.mkdir(git, { recursive: true })

    await $`git --git-dir ${git} --work-tree ${Instance.worktree} add .`
      .quiet()
      .cwd(Instance.directory)
      .nothrow()

    const hash = await $`git --git-dir ${git} --work-tree ${Instance.worktree} write-tree`
      .quiet()
      .cwd(Instance.directory)
      .nothrow()
      .text()
    return hash.trim()
  }

  // Parse commit metadata from commit message body
  function parseCommitMetadata(body: string): { messageID?: string; sessionID?: string } {
    const metadata: { messageID?: string; sessionID?: string } = {}
    const lines = body.split("\n")
    for (const line of lines) {
      const match = line.match(/^(\w+):\s*(.+)$/)
      if (match) {
        const [, key, value] = match
        if (key === "messageID") metadata.messageID = value
        if (key === "sessionID") metadata.sessionID = value
      }
    }
    return metadata
  }

  // Get commit history
  export async function history(options: { limit?: number; sessionID?: string } = {}): Promise<CommitInfo[]> {
    const git = gitdir()
    // Fetch more than limit if filtering by sessionID, since we'll filter after
    const fetchLimit = options.sessionID ? (options.limit ?? 100) * 3 : (options.limit ?? 100)

    // Check if repo exists
    try {
      await fs.access(git)
    } catch {
      return []
    }

    // Get commit log with format: hash|tree|parent|timestamp|subject|body
    // Use %x00 (null byte) as record separator to handle multiline bodies
    const format = "%H|%T|%P|%ct|%s|%b%x00"
    const result = await $`git --git-dir ${git} log --format=${format} -n ${fetchLimit} opencode`
      .quiet()
      .cwd(Instance.directory)
      .nothrow()
      .text()

    if (!result.trim()) {
      return []
    }

    const commits: CommitInfo[] = []
    // Split by null byte to get each commit record
    const records = result.split("\x00").filter((r) => r.trim())

    for (const record of records) {
      const parts = record.trim().split("|")
      if (parts.length < 5) continue
      const [hash, treeHash, parentHash, timestamp, subject, ...bodyParts] = parts
      const body = bodyParts.join("|")
      const metadata = parseCommitMetadata(body)

      // Skip if filtering by sessionID and doesn't match
      if (options.sessionID && metadata.sessionID !== options.sessionID) {
        continue
      }

      // Get files changed in this commit
      let files: string[] = []
      if (parentHash) {
        const diffResult = await $`git --git-dir ${git} diff --name-only ${parentHash} ${hash}`
          .quiet()
          .cwd(Instance.directory)
          .nothrow()
          .text()
        files = diffResult
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((f) => path.join(Instance.worktree, f))
      } else {
        // First commit - list all files
        const lsResult = await $`git --git-dir ${git} ls-tree -r --name-only ${hash}`
          .quiet()
          .cwd(Instance.directory)
          .nothrow()
          .text()
        files = lsResult
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((f) => path.join(Instance.worktree, f))
      }

      commits.push({
        hash,
        treeHash,
        parentHash: parentHash || undefined,
        message: subject,
        messageID: metadata.messageID,
        sessionID: metadata.sessionID,
        files,
        timestamp: parseInt(timestamp) * 1000, // Convert to milliseconds
      })

      // Apply limit after filtering
      if (commits.length >= (options.limit ?? 100)) {
        break
      }
    }

    return commits
  }

  // Get a specific commit's info
  export async function getCommit(hash: string): Promise<CommitInfo | undefined> {
    const git = gitdir()
    const format = "%H|%T|%P|%ct|%s|%b"
    const result = await $`git --git-dir ${git} show --format=${format} -s ${hash}`
      .quiet()
      .cwd(Instance.directory)
      .nothrow()
      .text()

    if (!result.trim()) {
      return undefined
    }

    const [commitHash, treeHash, parentHash, timestamp, subject, ...bodyParts] = result.trim().split("|")
    const body = bodyParts.join("|")
    const metadata = parseCommitMetadata(body)

    // Get files changed
    let files: string[] = []
    if (parentHash) {
      const diffResult = await $`git --git-dir ${git} diff --name-only ${parentHash} ${commitHash}`
        .quiet()
        .cwd(Instance.directory)
        .nothrow()
        .text()
      files = diffResult
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((f) => path.join(Instance.worktree, f))
    }

    return {
      hash: commitHash,
      treeHash,
      parentHash: parentHash || undefined,
      message: subject,
      messageID: metadata.messageID,
      sessionID: metadata.sessionID,
      files,
      timestamp: parseInt(timestamp) * 1000,
    }
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

  export async function restore(snapshot: string): Promise<{ success: boolean; error?: string }> {
    log.info("restore", { commit: snapshot, worktree: Instance.worktree })
    const git = gitdir()
    
    // Get list of files in the target snapshot
    const snapshotFiles = await $`git --git-dir ${git} ls-tree -r --name-only ${snapshot}`
      .quiet()
      .cwd(Instance.worktree)
      .nothrow()
      .text()
    
    const filesInSnapshot = new Set(snapshotFiles.trim().split("\n").filter(Boolean))
    
    // Get list of files currently tracked (in the current index)
    const currentHead = await getHead()
    if (currentHead) {
      const currentFiles = await $`git --git-dir ${git} ls-tree -r --name-only ${currentHead}`
        .quiet()
        .cwd(Instance.worktree)
        .nothrow()
        .text()
      
      // Delete files that exist now but not in the target snapshot
      for (const file of currentFiles.trim().split("\n").filter(Boolean)) {
        if (!filesInSnapshot.has(file)) {
          const fullPath = path.join(Instance.worktree, file)
          try {
            await fs.unlink(fullPath)
            log.info("deleted file not in snapshot", { file })
          } catch {
            // File might already be deleted or not exist
          }
        }
      }
    }
    
    // Read the tree into the index
    const readTree = await $`git --git-dir ${git} --work-tree ${Instance.worktree} read-tree ${snapshot}`
      .quiet()
      .cwd(Instance.worktree)
      .nothrow()
    
    if (readTree.exitCode !== 0) {
      const error = `read-tree failed: ${readTree.stderr.toString()}`
      log.error("failed to read tree", { snapshot, error })
      return { success: false, error }
    }
    
    // Checkout the files from the index
    const checkout = await $`git --git-dir ${git} --work-tree ${Instance.worktree} checkout-index -a -f`
      .quiet()
      .cwd(Instance.worktree)
      .nothrow()

    if (checkout.exitCode !== 0) {
      const error = `checkout-index failed: ${checkout.stderr.toString()}`
      log.error("failed to checkout index", { snapshot, error })
      return { success: false, error }
    }
    
    log.info("restore complete", { snapshot })
    return { success: true }
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
