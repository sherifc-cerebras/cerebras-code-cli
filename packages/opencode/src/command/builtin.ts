import { Config } from "../config/config"
import { Global } from "../global"
import { Identifier } from "../id/id"
import { Instance } from "../project/instance"
import { Log } from "../util/log"
import { Session } from "../session"
import { MessageV2 } from "../session/message-v2"
import fs from "fs/promises"
import path from "path"

/**
 * Built-in commands that execute directly without going to the AI.
 * These create messages in the session and return the result.
 */
export namespace BuiltinCommand {
  export type ExecuteResult = {
    userMessage: MessageV2.User
    userParts: MessageV2.Part[]
    assistantMessage: MessageV2.Assistant
    assistantParts: MessageV2.Part[]
    filePath?: string
  }

  export type Handler = (args: {
    sessionID: string
    arguments: string
    agent: string
    model: { providerID: string; modelID: string }
  }) => Promise<ExecuteResult>

  const commands: Record<string, Handler> = {
    debug: debugHandler,
  }

  export function has(name: string): boolean {
    return name in commands
  }

  export function get(name: string): Handler | undefined {
    return commands[name]
  }

  async function debugHandler(args: {
    sessionID: string
    arguments: string
    agent: string
    model: { providerID: string; modelID: string }
  }): Promise<ExecuteResult> {
    const now = Date.now()
    const output: string[] = []

    output.push("# Debug Export\n")
    output.push(`Generated: ${new Date(now).toISOString()}\n`)

    // Paths
    output.push("## Paths\n")
    output.push("```")
    for (const [key, value] of Object.entries(Global.Path)) {
      output.push(`${key.padEnd(10)} ${value}`)
    }
    output.push("```\n")

    // Project info
    output.push("## Project\n")
    output.push("```")
    output.push(`ID:        ${Instance.project.id}`)
    output.push(`Worktree:  ${Instance.worktree}`)
    output.push(`Directory: ${Instance.directory}`)
    output.push("```\n")

    // Config
    output.push("## Config\n")
    try {
      const config = await Config.get()
      output.push("```json")
      output.push(JSON.stringify(config, null, 2))
      output.push("```\n")
    } catch (e) {
      output.push("```")
      output.push(`Error loading config: ${e instanceof Error ? e.message : String(e)}`)
      output.push("```\n")
    }

    // Current session info
    output.push("## Current Session\n")
    try {
      const session = await Session.get(args.sessionID)
      output.push("```")
      output.push(`ID:      ${session.id}`)
      output.push(`Title:   ${session.title}`)
      output.push(`Created: ${new Date(session.time.created).toISOString()}`)
      output.push(`Updated: ${session.time.updated ? new Date(session.time.updated).toISOString() : "N/A"}`)
      output.push("```\n")

      // Message count and details
      const messages: MessageV2.WithParts[] = []
      for await (const msg of MessageV2.stream(args.sessionID)) {
        messages.push(msg)
      }
      output.push(`Messages: ${messages.length}\n`)

      // Recent messages summary
      if (messages.length > 0) {
        output.push("### Recent Messages\n")
        output.push("```")
        const recent = messages.slice(-10).reverse()
        for (const msg of recent) {
          const role = msg.info.role
          const agent = role === "user" ? ` [${(msg.info as MessageV2.User).agent}]` : ""
          const time = new Date(msg.info.time.created).toISOString()
          const partTypes = msg.parts.map((p) => p.type).join(", ")
          output.push(`${time} | ${role}${agent} | parts: ${partTypes}`)
        }
        if (messages.length > 10) {
          output.push(`... and ${messages.length - 10} more messages`)
        }
        output.push("```\n")
      }
    } catch (e) {
      output.push("```")
      output.push(`Error loading session: ${e instanceof Error ? e.message : String(e)}`)
      output.push("```\n")
    }

    // Log file
    output.push("## Log File\n")
    const logFile = Log.file()
    output.push(`Path: \`${logFile}\`\n`)

    // Recent log entries
    try {
      const logContent = await fs.readFile(logFile, "utf-8")
      const lines = logContent.split("\n").slice(-50)
      if (lines.length > 0) {
        output.push("### Recent Log Entries\n")
        output.push("```")
        output.push(lines.join("\n"))
        output.push("```\n")
      }
    } catch {
      output.push("_No log file found or unable to read_\n")
    }

    // Storage info
    output.push("## Storage\n")
    const storagePath = path.join(Global.Path.data, "storage")
    output.push(`Path: \`${storagePath}\`\n`)

    try {
      const sessionDir = path.join(storagePath, "session", Instance.project.id)
      const sessions = await fs.readdir(sessionDir).catch(() => [])
      output.push(`Sessions in project: ${sessions.length}\n`)
    } catch {
      output.push("_Unable to read storage directory_\n")
    }

    const content = output.join("\n")

    // Write to file
    const debugDir = path.join(Global.Path.data, "debug")
    await fs.mkdir(debugDir, { recursive: true })
    const fileName = `debug-${new Date(now).toISOString().replace(/[:.]/g, "-")}.md`
    const filePath = path.join(debugDir, fileName)
    await fs.writeFile(filePath, content)

    // Create messages
    const userMessageId = Identifier.ascending("message")
    const assistantMessageId = Identifier.ascending("message")
    const userPartId = Identifier.ascending("part")
    const assistantPartId = Identifier.ascending("part")

    const userMessage: MessageV2.User = {
      id: userMessageId,
      role: "user",
      sessionID: args.sessionID,
      time: { created: now },
      agent: args.agent,
      model: args.model,
    }

    const userParts: MessageV2.Part[] = [
      {
        id: userPartId,
        messageID: userMessageId,
        sessionID: args.sessionID,
        type: "text",
        text: "/debug",
      },
    ]

    const assistantMessage: MessageV2.Assistant = {
      id: assistantMessageId,
      role: "assistant",
      sessionID: args.sessionID,
      parentID: userMessageId,
      time: { created: now, completed: now },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
      modelID: "builtin",
      providerID: "builtin",
      mode: args.agent,
      path: { cwd: Instance.directory, root: Instance.worktree },
      finish: "complete",
    }

    const assistantParts: MessageV2.Part[] = [
      {
        id: assistantPartId,
        messageID: assistantMessageId,
        sessionID: args.sessionID,
        type: "text",
        text: `Debug export saved to:\n\`${filePath}\`\n\n${content}`,
      },
    ]

    // Store messages in session
    await Session.updateMessage(userMessage)
    for (const part of userParts) {
      await Session.updatePart(part)
    }
    await Session.updateMessage(assistantMessage)
    for (const part of assistantParts) {
      await Session.updatePart(part)
    }

    return {
      userMessage,
      userParts,
      assistantMessage,
      assistantParts,
      filePath,
    }
  }
}
