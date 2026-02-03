import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { z } from "zod"

type MultiAgentConfig = {
  enabled?: boolean
  max_agents?: number
  agent_model?: string
  manager_model?: string
}

type SubAgent = {
  id: string
  role: string
  task: string
  inputs?: string[]
}

type AgentResult = {
  agentId: string
  role: string
  task: string
  output: string
  sessionId?: string
  error?: string
}

type ManagerSpec = {
  role: string
  task: string
}

type MultiAgentTask = {
  type: "multi_agent_task"
  goal: string
  agents: SubAgent[]
  manager: ManagerSpec
  context?: Record<string, string>
}

type ModelRef = {
  providerID: string
  modelID: string
}

const MultiAgentTaskSchema = z
  .object({
    type: z.literal("multi_agent_task"),
    goal: z.string(),
    agents: z
      .array(
        z.object({
          id: z.string(),
          role: z.string(),
          task: z.string(),
          inputs: z.array(z.string()).optional(),
        }),
      )
      .min(1),
    manager: z.object({
      role: z.string().optional(),
      task: z.string(),
    }),
    context: z.record(z.string(), z.string()).optional(),
  })
  .passthrough()

const handledMessageIds = new Set<string>()
const ignoredSessions = new Set<string>()

let cachedConfig: MultiAgentConfig | undefined

export default async function multiAgentOrchestrator(input: PluginInput): Promise<Hooks> {
  return {
    config: async (config) => {
      cachedConfig = (config as any)?.multi_agent as MultiAgentConfig | undefined
    },
    "experimental.text.complete": async (hookInput, output) => {
      if (ignoredSessions.has(hookInput.sessionID)) {
        return
      }

      const effectiveConfig = getEffectiveConfig(cachedConfig)
      if (effectiveConfig.enabled === false) {
        return
      }

      if (handledMessageIds.has(hookInput.messageID)) {
        return
      }

      const message = await fetchMessage(input, hookInput.sessionID, hookInput.messageID)
      if (!message) return
      if (message.info.role !== "assistant") return
      if (message.info.mode !== "plan") return

      const plan = extractMultiAgentTask(output.text)
      if (!plan) return

      handledMessageIds.add(hookInput.messageID)

      const generatedPlan = await onPlanGenerated(plan, {
        sessionID: hookInput.sessionID,
        messageID: hookInput.messageID,
      })

      const readyPlan = await onBeforeExecution(generatedPlan, {
        sessionID: hookInput.sessionID,
        messageID: hookInput.messageID,
      })

      const baseModel: ModelRef = {
        providerID: message.info.providerID,
        modelID: message.info.modelID,
      }

      const lastUserText = await fetchLastUserText(input, hookInput.sessionID)

      const execution = await executePlan({
        input,
        plan: readyPlan,
        sessionID: hookInput.sessionID,
        baseModel,
        config: effectiveConfig,
        sharedContext: lastUserText,
      })

      output.text = execution.text
      output.metadata = {
        ...(output.metadata ?? {}),
        ...execution.metadata,
      }
    },
  }
}

function getEffectiveConfig(config?: MultiAgentConfig): Required<Pick<MultiAgentConfig, "enabled">> &
  Omit<MultiAgentConfig, "enabled"> {
  const enabledOverride = envBool("OPENCODE_MULTI_AGENT")
  const maxAgentsOverride = envNumber("OPENCODE_MULTI_AGENT_MAX_AGENTS")
  const agentModelOverride = envString("OPENCODE_MULTI_AGENT_AGENT_MODEL")
  const managerModelOverride = envString("OPENCODE_MULTI_AGENT_MANAGER_MODEL")

  return {
    enabled: enabledOverride ?? config?.enabled ?? true,
    max_agents: maxAgentsOverride ?? config?.max_agents,
    agent_model: agentModelOverride ?? config?.agent_model,
    manager_model: managerModelOverride ?? config?.manager_model,
  }
}

function envBool(key: string): boolean | undefined {
  const raw = process.env[key]
  if (!raw) return undefined
  if (raw === "1") return true
  if (raw === "0") return false
  const normalized = raw.toLowerCase()
  if (normalized === "true") return true
  if (normalized === "false") return false
  return undefined
}

function envNumber(key: string): number | undefined {
  const raw = process.env[key]
  if (!raw) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value)) return undefined
  return value
}

function envString(key: string): string | undefined {
  const raw = process.env[key]
  if (!raw) return undefined
  return raw
}

async function fetchMessage(input: PluginInput, sessionID: string, messageID: string) {
  const result = await input.client.session.messages(
    {
      path: { id: sessionID },
      query: { directory: input.directory, limit: 20 },
    },
    { throwOnError: true },
  )
  const messages = result.data ?? []
  return messages.find((msg: any) => msg.info?.id === messageID)
}

async function fetchLastUserText(input: PluginInput, sessionID: string) {
  const result = await input.client.session.messages(
    {
      path: { id: sessionID },
      query: { directory: input.directory, limit: 50 },
    },
    { throwOnError: true },
  )
  const messages = result.data ?? []
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.info?.role !== "user") continue
    const text = textFromParts(msg.parts ?? [])
    if (text.trim()) return text.trim()
  }
  return undefined
}

function textFromParts(parts: Array<{ type: string; text?: string }>): string {
  return parts
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n")
}

function extractMultiAgentTask(text: string): MultiAgentTask | undefined {
  const candidates = extractJsonCandidates(text)

  for (const candidate of candidates) {
    const parsed = safeJsonParse(candidate)
    if (!parsed) continue
    const found = findMultiAgentTask(parsed)
    if (found) return found
  }

  const inline = extractInlineJson(text)
  for (const candidate of inline) {
    const parsed = safeJsonParse(candidate)
    if (!parsed) continue
    const found = findMultiAgentTask(parsed)
    if (found) return found
  }

  return undefined
}

function extractJsonCandidates(text: string): string[] {
  const candidates: string[] = []
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi
  for (const match of text.matchAll(fenceRegex)) {
    const block = match[1]?.trim()
    if (block) candidates.push(block)
  }
  const trimmed = text.trim()
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    candidates.push(trimmed)
  }
  return candidates
}

function extractInlineJson(text: string): string[] {
  const marker = "\"type\": \"multi_agent_task\""
  const index = text.indexOf(marker)
  if (index === -1) return []
  const start = text.lastIndexOf("{", index)
  if (start === -1) return []
  const end = findMatchingBrace(text, start)
  if (end === -1) return []
  return [text.slice(start, end + 1)]
}

function findMatchingBrace(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (escape) {
        escape = false
      } else if (char === "\\") {
        escape = true
      } else if (char === "\"") {
        inString = false
      }
      continue
    }

    if (char === "\"") {
      inString = true
      continue
    }

    if (char === "{") {
      depth += 1
    } else if (char === "}") {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function safeJsonParse(value: string): unknown | undefined {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function findMultiAgentTask(value: unknown): MultiAgentTask | undefined {
  if (!value) return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findMultiAgentTask(item)
      if (found) return found
    }
    return undefined
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    if (record.type === "multi_agent_task") {
      const parsed = MultiAgentTaskSchema.safeParse(record)
      if (parsed.success) {
        return normalizePlan(parsed.data)
      }
    }

    for (const child of Object.values(record)) {
      if (child && (typeof child === "object" || Array.isArray(child))) {
        const found = findMultiAgentTask(child)
        if (found) return found
      }
    }
  }
  return undefined
}

function normalizePlan(plan: z.infer<typeof MultiAgentTaskSchema>): MultiAgentTask {
  return {
    ...plan,
    manager: {
      role: plan.manager.role ?? "Manager",
      task: plan.manager.task,
    },
  }
}

async function onPlanGenerated(plan: MultiAgentTask, _context: { sessionID: string; messageID: string }) {
  return plan
}

async function onBeforeExecution(plan: MultiAgentTask, _context: { sessionID: string; messageID: string }) {
  return plan
}

async function executePlan(params: {
  input: PluginInput
  plan: MultiAgentTask
  sessionID: string
  baseModel: ModelRef
  config: MultiAgentConfig
  sharedContext?: string
}): Promise<{ text: string; metadata: Record<string, any> }> {
  const { plan, baseModel, config } = params
  const agentModel = parseModel(config.agent_model) ?? baseModel
  const managerModel = parseModel(config.manager_model) ?? agentModel

  const maxAgents = config.max_agents && config.max_agents > 0 ? Math.floor(config.max_agents) : plan.agents.length
  const agentsToRun = plan.agents.slice(0, maxAgents)

  const results = await Promise.all(
    agentsToRun.map((agent) =>
      runSubAgent({
        input: params.input,
        parentSessionID: params.sessionID,
        agent,
        model: agentModel,
        goal: plan.goal,
        context: plan.context,
        sharedContext: params.sharedContext,
      }).catch((error: unknown) => ({
        agentId: agent.id,
        role: agent.role,
        task: agent.task,
        output: "",
        error: error instanceof Error ? error.message : String(error),
      })),
    ),
  )

  const successes = results.filter((result) => result.output.trim().length > 0)

  const metadata: Record<string, any> = {
    execution_mode: "multi_agent",
    agents_used: results.map((result) => ({
      id: result.agentId,
      role: result.role,
      status: result.output.trim() ? "success" : "error",
      session_id: result.sessionId,
      error: result.error,
    })),
    manager: {
      role: plan.manager.role,
    },
    multi_agent: {
      goal: plan.goal,
      total_agents: plan.agents.length,
      executed_agents: agentsToRun.length,
      successful_agents: successes.length,
    },
  }

  if (successes.length === 0) {
    return {
      text:
        "Multi-agent execution failed: all sub-agents returned empty output or errored. " +
        "Check the plan format and try again.",
      metadata: {
        ...metadata,
        status: "error",
      },
    }
  }

  const managerResult = await runManager({
    input: params.input,
    parentSessionID: params.sessionID,
    manager: plan.manager,
    goal: plan.goal,
    results: successes,
    model: managerModel,
  }).catch(() => undefined)

  if (!managerResult || !managerResult.output.trim()) {
    return {
      text: successes[0].output,
      metadata: {
        ...metadata,
        manager: {
          ...metadata.manager,
          status: "error",
        },
      },
    }
  }

  return {
    text: managerResult.output,
    metadata: {
      ...metadata,
      manager: {
        ...metadata.manager,
        status: "success",
        session_id: managerResult.sessionId,
      },
    },
  }
}

async function runSubAgent(input: {
  input: PluginInput
  parentSessionID: string
  agent: SubAgent
  model: ModelRef
  goal: string
  context?: Record<string, string>
  sharedContext?: string
}): Promise<AgentResult> {
  const session = await input.input.client.session.create(
    {
      query: { directory: input.input.directory },
      body: {
        parentID: input.parentSessionID,
        title: `${input.agent.id} (${input.agent.role})`,
      },
    },
    { throwOnError: true },
  )

  const sessionId = session.data?.id
  if (!sessionId) {
    throw new Error("Failed to create sub-agent session")
  }

  ignoredSessions.add(sessionId)

  const systemPrompt = [
    `You are a ${input.agent.role}.`,
    `Your task is: ${input.agent.task}.`,
    "Output only your result.",
  ].join("\n")

  const userPrompt = buildSubAgentPrompt({
    goal: input.goal,
    agent: input.agent,
    context: input.context,
    sharedContext: input.sharedContext,
  })

  const response = await input.input.client.session.prompt(
    {
      path: { id: sessionId },
      query: { directory: input.input.directory },
      body: {
        agent: "build",
        model: input.model,
        system: systemPrompt,
        tools: { "*": false },
        parts: [{ type: "text", text: userPrompt }],
      },
    },
    { throwOnError: true },
  )

  const output = textFromParts(response.data?.parts ?? []).trim()
  if (!output) {
    throw new Error("Sub-agent produced no output")
  }

  return {
    agentId: input.agent.id,
    role: input.agent.role,
    task: input.agent.task,
    output,
    sessionId,
  }
}

async function runManager(input: {
  input: PluginInput
  parentSessionID: string
  manager: ManagerSpec
  goal: string
  results: AgentResult[]
  model: ModelRef
}): Promise<AgentResult> {
  const session = await input.input.client.session.create(
    {
      query: { directory: input.input.directory },
      body: {
        parentID: input.parentSessionID,
        title: `Manager (${input.manager.role})`,
      },
    },
    { throwOnError: true },
  )

  const sessionId = session.data?.id
  if (!sessionId) {
    throw new Error("Failed to create manager session")
  }

  ignoredSessions.add(sessionId)

  const systemPrompt = `You are the ${input.manager.role}.`
  const managerPrompt = buildManagerPrompt({
    goal: input.goal,
    manager: input.manager,
    results: input.results,
  })

  const response = await input.input.client.session.prompt(
    {
      path: { id: sessionId },
      query: { directory: input.input.directory },
      body: {
        agent: "build",
        model: input.model,
        system: systemPrompt,
        tools: { "*": false },
        parts: [{ type: "text", text: managerPrompt }],
      },
    },
    { throwOnError: true },
  )

  const output = textFromParts(response.data?.parts ?? []).trim()
  if (!output) {
    throw new Error("Manager produced no output")
  }

  return {
    agentId: "manager",
    role: input.manager.role,
    task: input.manager.task,
    output,
    sessionId,
  }
}

function buildSubAgentPrompt(input: {
  goal: string
  agent: SubAgent
  context?: Record<string, string>
  sharedContext?: string
}): string {
  const lines: string[] = []
  lines.push(`Goal: ${input.goal}`)
  lines.push(`Task: ${input.agent.task}`)

  const resolvedInputs = resolveInputs(input.agent.inputs, input.context)
  if (resolvedInputs.length) {
    lines.push("")
    lines.push("Inputs:")
    for (const item of resolvedInputs) {
      lines.push(`- ${item}`)
    }
  }

  if (input.sharedContext) {
    lines.push("")
    lines.push("User context:")
    lines.push(input.sharedContext)
  }

  return lines.join("\n")
}

function buildManagerPrompt(input: { goal: string; manager: ManagerSpec; results: AgentResult[] }): string {
  const lines: string[] = []
  lines.push("You are the manager agent.")
  lines.push("")
  lines.push("Goal:")
  lines.push(input.manager.task)
  lines.push("")
  lines.push("Plan goal:")
  lines.push(input.goal)
  lines.push("")
  lines.push("Sub-agent outputs:")
  for (const result of input.results) {
    lines.push(`- ${result.agentId} (${result.role}): ${result.output}`)
  }
  lines.push("")
  lines.push("Instructions:")
  lines.push("1. Identify inconsistencies")
  lines.push("2. Resolve conflicts")
  lines.push("3. Produce a single coherent final answer")
  lines.push("4. Be concise and decisive")
  return lines.join("\n")
}

function resolveInputs(inputs?: string[], context?: Record<string, string>): string[] {
  if (!inputs || inputs.length === 0) return []
  if (!context) return inputs
  return inputs.map((item) => context[item] ?? item)
}

function parseModel(value?: string): ModelRef | undefined {
  if (!value) return undefined
  const [providerID, ...modelParts] = value.split("/")
  if (!providerID || modelParts.length === 0) return undefined
  return {
    providerID,
    modelID: modelParts.join("/"),
  }
}
