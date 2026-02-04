import { useSync } from "@tui/context/sync"
import { createMemo, createEffect, createSignal, For, Show, Switch, Match } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "../../context/theme"
import { useToast } from "../../ui/toast"
import { Locale } from "@/util/locale"
import path from "path"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { Installation } from "@/installation"
import { useDirectory } from "../../context/directory"

// Threshold for low cache hit rate warning
const LOW_CACHE_HIT_THRESHOLD = 40
const CONSECUTIVE_LOW_COUNT = 3

// Convert percentage (0-100) to block character (8 levels)
function percentToBar(percent: number): string {
  const blocks = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]
  const index = Math.round((percent / 100) * 8)
  return blocks[Math.min(8, Math.max(0, index))]
}

function ContextProgressBar(props: {
  used: number
  limit: number
}) {
  const { theme } = useTheme()
  
  const percentUsed = createMemo(() => 
    props.limit > 0 ? Math.min(100, (props.used / props.limit) * 100) : 0
  )
  
  const percentRemaining = createMemo(() => 100 - percentUsed())
  
  const barWidth = 20
  const filledBlocks = createMemo(() => Math.round((percentUsed() / 100) * barWidth))
  const progressBar = createMemo(() => {
    const filled = filledBlocks()
    const empty = barWidth - filled
    return "█".repeat(filled) + "░".repeat(empty)
  })
  
  // Color based on remaining (green = plenty left, red = almost full)
  const barColor = createMemo(() => {
    const remaining = percentRemaining()
    if (remaining >= 50) return theme.success
    if (remaining >= 20) return theme.warning
    return theme.error
  })
  
  const formatTokens = (tokens: number): string => {
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
    if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`
    return tokens.toLocaleString()
  }
  
  return (
    <box>
      <box flexDirection="row" gap={1}>
        <text>
          <span style={{ fg: barColor() }}>{progressBar()}</span>
        </text>
        <text fg={theme.textMuted}>{percentUsed().toFixed(0)}%</text>
      </box>
      <text fg={theme.textMuted}>
        {formatTokens(props.used)} / {formatTokens(props.limit)}
      </text>
    </box>
  )
}

// Visual representation of cache hit rate
function CacheVisual(props: { 
  hitRate: number
  cachedTokens: number
  promptTokens: number
  recentRates: number[]  // Last 10 message hit rates
}) {
  const { theme } = useTheme()

  // Progress bar using block characters
  const barWidth = 20
  const filledBlocks = createMemo(() => Math.round((props.hitRate / 100) * barWidth))
  const progressBar = createMemo(() => {
    const filled = filledBlocks()
    const empty = barWidth - filled
    return "█".repeat(filled) + "░".repeat(empty)
  })

  // Pie/wheel indicator using circle segments
  const pieIndicator = createMemo(() => {
    const rate = props.hitRate
    if (rate >= 87.5) return "●" // Full
    if (rate >= 62.5) return "◕" // 3/4
    if (rate >= 37.5) return "◑" // Half
    if (rate >= 12.5) return "◔" // 1/4
    return "○" // Empty
  })

  // Minesweeper-style face indicator
  const faceIndicator = createMemo(() => {
    const rate = props.hitRate
    if (rate >= 70) return "😊" // Happy - good cache
    if (rate >= 40) return "😐" // Neutral - okay cache
    return "😟" // Worried - bad cache
  })

  // Color based on hit rate (gradient from red to green)
  const rateColor = createMemo(() => {
    const rate = props.hitRate
    if (rate >= 70) return theme.success
    if (rate >= 40) return theme.warning
    return theme.error
  })

  // Get color for a rate
  const getRateColor = (rate: number) => {
    if (rate >= 70) return theme.success
    if (rate >= 40) return theme.warning
    return theme.error
  }

  // Last 10 rates as a memo for proper reactivity
  const recentRates = createMemo(() => {
    const rates = props.recentRates || []
    return rates.slice(-10)
  })

  // Pre-compute the sparkline to avoid For reactivity issues
  const sparkline = createMemo(() => {
    return recentRates().map((rate, i) => ({
      key: i,
      rate,
      char: percentToBar(rate),
      color: getRateColor(rate),
    }))
  })

  return (
    <>
      {/* Wheel indicator with percentage and face */}
      <box flexDirection="row" gap={1}>
        <text style={{ fg: rateColor() }}>{pieIndicator()}</text>
        <text fg={theme.textMuted}>
          {props.hitRate.toFixed(1)}% hit rate
        </text>
        <text>{faceIndicator()}</text>
      </box>
      {/* Progress bar with sparkline bar chart */}
      <box flexDirection="row" gap={1}>
        <text>
          <span style={{ fg: rateColor() }}>{progressBar()}</span>
        </text>
        <text>
          <For each={sparkline()}>
            {(item) => (
              <span style={{ fg: item.color }}>{item.char}</span>
            )}
          </For>
        </text>
      </box>
      {/* Token counts */}
      <text fg={theme.textMuted}>
        {props.cachedTokens.toLocaleString()} / {props.promptTokens.toLocaleString()} tokens
      </text>
    </>
  )
}

export function Sidebar(props: { sessionID: string }) {
  const sync = useSync()
  const { theme } = useTheme()
  const toast = useToast()
  const session = createMemo(() => sync.session.get(props.sessionID)!)
  const diff = createMemo(() => sync.data.session_diff[props.sessionID] ?? [])
  const todo = createMemo(() => sync.data.todo[props.sessionID] ?? [])
  const messages = createMemo(() => sync.data.message[props.sessionID] ?? [])

  // Track whether we've shown the low cache warning for this session
  const [hasShownCacheWarning, setHasShownCacheWarning] = createSignal(false)
  const [lastMessageCount, setLastMessageCount] = createSignal(0)

  const [expanded, setExpanded] = createStore({
    mcp: true,
    diff: true,
    todo: true,
    lsp: true,
  })

  // Sort MCP servers alphabetically for consistent display order
  const mcpEntries = createMemo(() => Object.entries(sync.data.mcp).sort(([a], [b]) => a.localeCompare(b)))

  const usage = createMemo(() => {
    const now = Date.now()
    const assistants = messages().filter((m) => m.role === "assistant")
    const total = assistants.length
    const countWithin = (ms: number) =>
      assistants.filter((m) => {
        const t = m.time?.completed ?? m.time?.created ?? 0
        return now - t <= ms
      }).length
    return {
      total,
      min1: countWithin(60_000),
      hour1: countWithin(60 * 60_000),
      day1: countWithin(24 * 60 * 60_000),
    }
  })

  const context = createMemo(() => {
    const last = messages().findLast((x) => x.role === "assistant" && x.tokens.output > 0) as AssistantMessage
    if (!last) return
    // Context sent = input tokens + cached tokens (what was actually sent to the API)
    const used = last.tokens.input + last.tokens.cache.read
    const model = sync.data.provider.find((x) => x.id === last.providerID)?.models[last.modelID]
    // Default to 128K (131072) for Cerebras GLM-4.7
    const limit = model?.limit.context || 131072
    const percentage = Math.min(100, Math.round((used / limit) * 100))
    return {
      used,
      limit,
      percentage,
    }
  })


  const cacheStats = createMemo(() => {
    const assistants = messages().filter((m) => m.role === "assistant") as AssistantMessage[]
    let totalCachedTokens = 0
    let totalPromptTokens = 0
    for (const msg of assistants) {
      // Total prompt = input + cached (input may be non-cached portion only)
      const cached = msg.tokens.cache.read
      const total = msg.tokens.input + cached
      totalCachedTokens += cached
      totalPromptTokens += total
    }
    const hitRate = totalPromptTokens > 0 ? (totalCachedTokens / totalPromptTokens) * 100 : 0
    return {
      promptTokens: totalPromptTokens,
      cachedTokens: totalCachedTokens,
      hitRate: hitRate.toFixed(1),
    }
  })

  // Calculate per-message cache hit rates for completed assistant messages
  const perMessageCacheRates = createMemo(() => {
    const assistants = messages().filter(
      (m) => m.role === "assistant" && m.time.completed
    ) as AssistantMessage[]
    return assistants.map((msg) => {
      const cached = msg.tokens.cache.read
      const total = msg.tokens.input + cached
      return total > 0 ? (cached / total) * 100 : 0
    })
  })

  // Monitor for consecutive low cache hit rates
  createEffect(() => {
    const rates = perMessageCacheRates()
    const currentCount = rates.length

    // Only check when we have new completed messages
    if (currentCount <= lastMessageCount()) {
      return
    }
    setLastMessageCount(currentCount)

    if (rates.length < CONSECUTIVE_LOW_COUNT) {
      return
    }

    const lastNRates = rates.slice(-CONSECUTIVE_LOW_COUNT)
    const allBelowThreshold = lastNRates.every((rate) => rate < LOW_CACHE_HIT_THRESHOLD)

    if (allBelowThreshold && !hasShownCacheWarning()) {
      setHasShownCacheWarning(true)
      toast.show({
        variant: "warning",
        title: "Low Cache Hit Rate",
        message: `Cache hit rate has been below ${LOW_CACHE_HIT_THRESHOLD}% for the last ${CONSECUTIVE_LOW_COUNT} requests. This may increase costs and latency.`,
        duration: 8000,
      })
    }

    if (!allBelowThreshold && hasShownCacheWarning()) {
      const lastNAboveThreshold = lastNRates.every((rate) => rate >= LOW_CACHE_HIT_THRESHOLD)
      if (lastNAboveThreshold) {
        setHasShownCacheWarning(false)
      }
    }
  })

  const directory = useDirectory()

  const hasProviders = createMemo(() =>
    sync.data.provider.some((x) => x.id !== "opencode" || Object.values(x.models).some((y) => y.cost?.input !== 0)),
  )

  return (
    <Show when={session()}>
      <box
        backgroundColor={theme.backgroundPanel}
        width={42}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
      >
        <scrollbox flexGrow={1}>
          <box flexShrink={0} gap={1} paddingRight={1}>
            <box>
              <text fg={theme.text}>
                <b>{session().title}</b>
              </text>
              <Show when={session().share?.url}>
                <text fg={theme.textMuted}>{session().share!.url}</text>
              </Show>
            </box>
            <box>
              <text fg={theme.text}>
                <b>Context</b>
              </text>
              <Show when={context()} fallback={
                <text fg={theme.textMuted}>No requests yet</text>
              }>
                <ContextProgressBar
                  used={context()!.used}
                  limit={context()!.limit}
                />
              </Show>
              <text fg={theme.textMuted}>
                Requests: {usage().total} (1m {usage().min1} / 1h {usage().hour1} / 24h {usage().day1})
              </text>
            </box>
            <Show when={cacheStats().promptTokens > 0}>
              <box>
                <text fg={theme.text}>
                  <b>Cache</b>
                </text>
                <CacheVisual
                  hitRate={parseFloat(cacheStats().hitRate)}
                  cachedTokens={cacheStats().cachedTokens}
                  promptTokens={cacheStats().promptTokens}
                  recentRates={perMessageCacheRates()}
                />
              </box>
            </Show>
            <Show when={mcpEntries().length > 0}>
              <box>
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseDown={() => mcpEntries().length > 2 && setExpanded("mcp", !expanded.mcp)}
                >
                  <Show when={mcpEntries().length > 2}>
                    <text fg={theme.text}>{expanded.mcp ? "▼" : "▶"}</text>
                  </Show>
                  <text fg={theme.text}>
                    <b>MCP</b>
                  </text>
                </box>
                <Show when={mcpEntries().length <= 2 || expanded.mcp}>
                  <For each={mcpEntries()}>
                    {([key, item]) => (
                      <box flexDirection="row" gap={1}>
                        <text
                          flexShrink={0}
                          style={{
                            fg: (
                              {
                                connected: theme.success,
                                failed: theme.error,
                                disabled: theme.textMuted,
                                needs_auth: theme.warning,
                                needs_client_registration: theme.error,
                              } as Record<string, typeof theme.success>
                            )[item.status],
                          }}
                        >
                          •
                        </text>
                        <text fg={theme.text} wrapMode="word">
                          {key}{" "}
                          <span style={{ fg: theme.textMuted }}>
                            <Switch fallback={item.status}>
                              <Match when={item.status === "connected"}>Connected</Match>
                              <Match when={item.status === "failed" && item}>{(val) => <i>{val().error}</i>}</Match>
                              <Match when={item.status === "disabled"}>Disabled</Match>
                              <Match when={(item.status as string) === "needs_auth"}>Needs auth</Match>
                              <Match when={(item.status as string) === "needs_client_registration"}>
                                Needs client ID
                              </Match>
                            </Switch>
                          </span>
                        </text>
                      </box>
                    )}
                  </For>
                </Show>
              </box>
            </Show>
            <box>
              <box
                flexDirection="row"
                gap={1}
                onMouseDown={() => sync.data.lsp.length > 2 && setExpanded("lsp", !expanded.lsp)}
              >
                <Show when={sync.data.lsp.length > 2}>
                  <text fg={theme.text}>{expanded.lsp ? "▼" : "▶"}</text>
                </Show>
                <text fg={theme.text}>
                  <b>LSP</b>
                </text>
              </box>
              <Show when={sync.data.lsp.length <= 2 || expanded.lsp}>
                <Show when={sync.data.lsp.length === 0}>
                  <text fg={theme.textMuted}>LSPs will activate as files are read</text>
                </Show>
                <For each={sync.data.lsp}>
                  {(item) => (
                    <box flexDirection="row" gap={1}>
                      <text
                        flexShrink={0}
                        style={{
                          fg: {
                            connected: theme.success,
                            error: theme.error,
                          }[item.status],
                        }}
                      >
                        •
                      </text>
                      <text fg={theme.textMuted}>
                        {item.id} {item.root}
                      </text>
                    </box>
                  )}
                </For>
              </Show>
            </box>
            <Show when={todo().length > 0 && todo().some((t) => t.status !== "completed")}>
              <box>
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseDown={() => todo().length > 2 && setExpanded("todo", !expanded.todo)}
                >
                  <Show when={todo().length > 2}>
                    <text fg={theme.text}>{expanded.todo ? "▼" : "▶"}</text>
                  </Show>
                  <text fg={theme.text}>
                    <b>Todo</b>
                  </text>
                </box>
                <Show when={todo().length <= 2 || expanded.todo}>
                  <For each={todo()}>
                    {(todo) => (
                      <text style={{ fg: todo.status === "in_progress" ? theme.success : theme.textMuted }}>
                        [{todo.status === "completed" ? "✓" : " "}] {todo.content}
                      </text>
                    )}
                  </For>
                </Show>
              </box>
            </Show>
            <Show when={diff().length > 0}>
              <box>
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseDown={() => diff().length > 2 && setExpanded("diff", !expanded.diff)}
                >
                  <Show when={diff().length > 2}>
                    <text fg={theme.text}>{expanded.diff ? "▼" : "▶"}</text>
                  </Show>
                  <text fg={theme.text}>
                    <b>Modified Files</b>
                  </text>
                </box>
                <Show when={diff().length <= 2 || expanded.diff}>
                  <For each={diff() || []}>
                    {(item) => {
                      const file = createMemo(() => {
                        const splits = item.file.split(path.sep).filter(Boolean)
                        const last = splits.at(-1)!
                        const rest = splits.slice(0, -1).join(path.sep)
                        if (!rest) return last
                        return Locale.truncateMiddle(rest, 30 - last.length) + "/" + last
                      })
                      return (
                        <box flexDirection="row" gap={1} justifyContent="space-between">
                          <text fg={theme.textMuted} wrapMode="char">
                            {file()}
                          </text>
                          <box flexDirection="row" gap={1} flexShrink={0}>
                            <Show when={item.additions}>
                              <text fg={theme.diffAdded}>+{item.additions}</text>
                            </Show>
                            <Show when={item.deletions}>
                              <text fg={theme.diffRemoved}>-{item.deletions}</text>
                            </Show>
                          </box>
                        </box>
                      )
                    }}
                  </For>
                </Show>
              </box>
            </Show>
          </box>
        </scrollbox>

        <box flexShrink={0} gap={1} paddingTop={1}>
          <Show when={!hasProviders()}>
            <box
              backgroundColor={theme.backgroundElement}
              paddingTop={1}
              paddingBottom={1}
              paddingLeft={2}
              paddingRight={2}
              flexDirection="row"
              gap={1}
            >
              <text flexShrink={0}>⬖</text>
              <box flexGrow={1} gap={1}>
                <text>
                  <b>Getting started</b>
                </text>
                <text fg={theme.textMuted}>OpenCode includes free models so you can start immediately.</text>
                <text fg={theme.textMuted}>
                  Connect from 75+ providers to use other models, including Claude, GPT, Gemini etc
                </text>
                <box flexDirection="row" gap={1} justifyContent="space-between">
                  <text>Connect provider</text>
                  <text fg={theme.textMuted}>/connect</text>
                </box>
              </box>
            </box>
          </Show>
          <text fg={theme.text}>{directory()}</text>
          <text fg={theme.textMuted}>
            <span style={{ fg: theme.success }}>•</span> <b>Open</b>
            <span style={{ fg: theme.text }}>
              <b>Code</b>
            </span>{" "}
            <span>{Installation.VERSION}</span>
          </text>
        </box>
      </box>
    </Show>
  )
}
