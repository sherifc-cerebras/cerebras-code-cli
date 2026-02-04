import { render, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { Clipboard } from "@tui/util/clipboard"
import { TextAttributes } from "@opentui/core"
import { RouteProvider, useRoute } from "@tui/context/route"
import { Switch, Match, createEffect, untrack, ErrorBoundary, createSignal, onMount, batch, Show, on } from "solid-js"
import { Installation } from "@/installation"
import { Global } from "@/global"
import { Flag } from "@/flag/flag"
import { DialogProvider, useDialog } from "@tui/ui/dialog"
import { DialogProvider as DialogProviderList } from "@tui/component/dialog-provider"
import { CerebrasOnboarding } from "@tui/component/cerebras-onboarding"
import { QuickStartOnboarding } from "@tui/component/quickstart-onboarding"
import { SDKProvider, useSDK } from "@tui/context/sdk"
import { SyncProvider, useSync } from "@tui/context/sync"
import { LocalProvider, useLocal } from "@tui/context/local"
import { DialogModel, useConnected } from "@tui/component/dialog-model"
import { DialogMcp } from "@tui/component/dialog-mcp"
import { DialogStatus } from "@tui/component/dialog-status"
import { DialogSettings } from "@tui/component/dialog-settings"
import { DialogThemeList } from "@tui/component/dialog-theme-list"
import { DialogHelp } from "./ui/dialog-help"
import { DialogFeedback, type FeedbackMetadata } from "./component/dialog-feedback"
import { CommandProvider, useCommandDialog } from "@tui/component/dialog-command"
import { DialogAgent } from "@tui/component/dialog-agent"
import { DialogSessionList } from "@tui/component/dialog-session-list"
import { DialogApiKey } from "./component/dialog-api-key"
import { KeybindProvider } from "@tui/context/keybind"
import { ThemeProvider, useTheme } from "@tui/context/theme"
import { Home } from "@tui/routes/home"
import { Session } from "@tui/routes/session"
import { PromptHistoryProvider } from "./component/prompt/history"
import { DialogAlert } from "./ui/dialog-alert"
import { ToastProvider, useToast } from "./ui/toast"
import { ExitProvider, useExit } from "./context/exit"
import { Session as SessionApi } from "@/session"
import { SessionStatus } from "@/session/status"

// Rate limit state
let isInRetryState = false
let rateLimitHandlerRegistered = false
// Track rate limit hits per session for paywall modal
const sessionRateLimitCounts = new Map<string, number>()
import { TuiEvent } from "./event"
import { KVProvider, useKV } from "./context/kv"
import { Provider } from "@/provider/provider"
import { Identifier } from "@/id/id"
import { ArgsProvider, useArgs, type Args } from "./context/args"
import open from "open"
import { PromptRefProvider, usePromptRef } from "./context/prompt"

import { Notification } from "@/notification"
import { FullscreenNotification } from "@tui/component/dialog-notification"
import { NotificationBanner } from "@tui/component/notification-banner"
import { DialogRateLimit } from "@tui/component/dialog-rate-limit"

async function getTerminalBackgroundColor(): Promise<"dark" | "light"> {
  // can't set raw mode if not a TTY
  if (!process.stdin.isTTY) return "dark"

  return new Promise((resolve) => {
    let timeout: NodeJS.Timeout

    const cleanup = () => {
      process.stdin.setRawMode(false)
      process.stdin.removeListener("data", handler)
      clearTimeout(timeout)
    }

    const handler = (data: Buffer) => {
      const str = data.toString()
      const match = str.match(/\x1b]11;([^\x07\x1b]+)/)
      if (match) {
        cleanup()
        const color = match[1]
        // Parse RGB values from color string
        // Formats: rgb:RR/GG/BB or #RRGGBB or rgb(R,G,B)
        let r = 0,
          g = 0,
          b = 0

        if (color.startsWith("rgb:")) {
          const parts = color.substring(4).split("/")
          r = parseInt(parts[0], 16) >> 8 // Convert 16-bit to 8-bit
          g = parseInt(parts[1], 16) >> 8 // Convert 16-bit to 8-bit
          b = parseInt(parts[2], 16) >> 8 // Convert 16-bit to 8-bit
        } else if (color.startsWith("#")) {
          r = parseInt(color.substring(1, 3), 16)
          g = parseInt(color.substring(3, 5), 16)
          b = parseInt(color.substring(5, 7), 16)
        } else if (color.startsWith("rgb(")) {
          const parts = color.substring(4, color.length - 1).split(",")
          r = parseInt(parts[0])
          g = parseInt(parts[1])
          b = parseInt(parts[2])
        }

        // Calculate luminance using relative luminance formula
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255

        // Determine if dark or light based on luminance threshold
        resolve(luminance > 0.5 ? "light" : "dark")
      }
    }

    process.stdin.setRawMode(true)
    process.stdin.on("data", handler)
    process.stdout.write("\x1b]11;?\x07")

    timeout = setTimeout(() => {
      cleanup()
      resolve("dark")
    }, 1000)
  })
}

export function tui(input: { url: string; args: Args; onExit?: () => Promise<void> }) {
  // promise to prevent immediate exit
  return new Promise<void>(async (resolve) => {
    const mode = await getTerminalBackgroundColor()
    const onExit = async () => {
      await input.onExit?.()
      resolve()
    }

    render(
      () => {
        return (
          <ErrorBoundary fallback={(error, reset) => <ErrorComponent error={error} reset={reset} onExit={onExit} />}>
            <ArgsProvider {...input.args}>
              <ExitProvider onExit={onExit}>
                <KVProvider>
                  <ToastProvider>
                    <RouteProvider>
                      <SDKProvider url={input.url}>
                        <SyncProvider>
                          <ThemeProvider mode={mode}>
                            <LocalProvider>
                              <KeybindProvider>
                                <DialogProvider>
                                  <CommandProvider>
                                    <PromptHistoryProvider>
                                      <PromptRefProvider>
                                        <App />
                                      </PromptRefProvider>
                                    </PromptHistoryProvider>
                                  </CommandProvider>
                                </DialogProvider>
                              </KeybindProvider>
                            </LocalProvider>
                          </ThemeProvider>
                        </SyncProvider>
                      </SDKProvider>
                    </RouteProvider>
                  </ToastProvider>
                </KVProvider>
              </ExitProvider>
            </ArgsProvider>
          </ErrorBoundary>
        )
      },
      {
        targetFps: 60,
        gatherStats: false,
        exitOnCtrlC: false,
        useKittyKeyboard: true,
      },
    )
  })
}

function App() {
  const route = useRoute()
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  renderer.disableStdoutInterception()
  const dialog = useDialog()
  const local = useLocal()
  const kv = useKV()
  const command = useCommandDialog()
  const sdk = useSDK()
  const { event } = sdk
  const toast = useToast()
  const { theme, mode, setMode } = useTheme()
  const sync = useSync()
  const exit = useExit()
  const promptRef = usePromptRef()
  const [bannerNotification, setBannerNotification] = createSignal<import("@/notification").Notification | null>(null)
  const [fullscreenNotification, setFullscreenNotification] = createSignal<
    import("@/notification").Notification | null
  >(null)
  const [showOnboarding, setShowOnboarding] = createSignal(false)
  const [showQuickStart, setShowQuickStart] = createSignal(false)

  createEffect(() => {
    console.log(JSON.stringify(route.data))
  })

  // Update terminal window title based on current route and session
  createEffect(() => {
    if (route.data.type === "home") {
      renderer.setTerminalTitle("opencode")
      return
    }

    if (route.data.type === "session") {
      const session = sync.session.get(route.data.sessionID)
      if (!session || SessionApi.isDefaultTitle(session.title)) {
        renderer.setTerminalTitle("opencode")
        return
      }

      // Truncate title to 40 chars max
      const title = session.title.length > 40 ? session.title.slice(0, 37) + "..." : session.title
      renderer.setTerminalTitle(`oc | ${title}`)
    }
  })

  const args = useArgs()
  onMount(() => {
    batch(() => {
      if (args.agent) local.agent.set(args.agent)
      if (args.model) {
        const { providerID, modelID } = Provider.parseModel(args.model)
        if (!providerID || !modelID)
          return toast.show({
            variant: "warning",
            message: `Invalid model format: ${args.model}`,
            duration: 3000,
          })
        local.model.set({ providerID, modelID }, { recent: true })
      }
      if (args.sessionID) {
        route.navigate({
          type: "session",
          sessionID: args.sessionID,
        })
      }
    })
  })

  // Check for notifications (but not for first-time users who will see onboarding)
  let notificationChecked = false
  createEffect(() => {
    if (notificationChecked) return
    if (!kv.ready) return

    // Skip notifications for first-time users - they'll see onboarding instead
    const hasSeenOnboarding = kv.get("hasSeenCerebrasOnboarding", false)
    if (!hasSeenOnboarding) return

    notificationChecked = true
    Notification.check().then((notif) => {
      if (!notif) return

      if (notif.display === "fullscreen") {
        setFullscreenNotification(notif)
      } else if (notif.display === "banner") {
        setBannerNotification(notif)
      } else {
        // Toast notification
        toast.show({
          variant: notif.type === "critical" ? "error" : notif.type === "warning" ? "warning" : "info",
          title: notif.title,
          message: notif.message,
          duration: 8000,
        })
        Notification.markSeen(notif.id)
      }
    })
  })

  let continued = false
  createEffect(() => {
    if (continued || sync.status !== "complete" || !args.continue) return
    const match = sync.data.session.at(0)?.id
    if (match) {
      continued = true
      route.navigate({ type: "session", sessionID: match })
    }
  })

  // Show Cerebras onboarding for first-time users
  let onboardingTriggered = false
  createEffect(() => {
    if (onboardingTriggered) return
    if (sync.status !== "complete") return
    if (!kv.ready) return

    const cerebrasConnected = sync.data.provider.some((p) => p.id === "cerebras")
    const hasSeenOnboarding = kv.get("hasSeenCerebrasOnboarding", false)

    if (!cerebrasConnected && !hasSeenOnboarding) {
      onboardingTriggered = true
      setShowOnboarding(true)
    }
  })

  // Show quick start after Cerebras onboarding (or if already set up)
  let quickStartTriggered = false
  createEffect(() => {
    if (quickStartTriggered) return
    if (showOnboarding()) return // Wait for Cerebras onboarding to finish
    if (sync.status !== "complete") return
    if (!kv.ready) return

    const hasSeenQuickStart = kv.get("hasSeenQuickStart", false)
    const cerebrasConnected = sync.data.provider.some((p) => p.id === "cerebras")

    // Show quick start for users who just completed Cerebras setup or already have it
    if (cerebrasConnected && !hasSeenQuickStart) {
      quickStartTriggered = true
      setShowQuickStart(true)
    }
  })

  // Handle quick start prompt selection - submit to new session
  const handleQuickStartSelect = async (prompt: string) => {
    setShowQuickStart(false)

    // Create a new session and submit the prompt
    const selectedModel = local.model.current()
    if (!selectedModel) return

    const sessionID = await sdk.client.session.create({}).then((x) => x.data!.id)
    const messageID = Identifier.ascending("message")

    // Submit the prompt
    sdk.client.session.prompt({
      sessionID,
      ...selectedModel,
      messageID,
      agent: local.agent.current().name,
      model: selectedModel,
      parts: [
        {
          id: Identifier.ascending("part"),
          type: "text",
          text: prompt,
        },
      ],
    })

    // Navigate to the session
    setTimeout(() => {
      route.navigate({ type: "session", sessionID })
    }, 50)
  }

  const connected = useConnected()
  command.register(() => [
    {
      title: "Switch session",
      value: "session.list",
      keybind: "session_list",
      category: "Session",
      suggested: sync.data.session.length > 0,
      onSelect: () => {
        dialog.replace(() => <DialogSessionList />)
      },
    },
    {
      title: "New session",
      suggested: route.data.type === "session",
      value: "session.new",
      keybind: "session_new",
      category: "Session",
      onSelect: () => {
        const current = promptRef.current
        // Don't require focus - if there's any text, preserve it
        const currentPrompt = current?.current?.input ? current.current : undefined
        route.navigate({
          type: "home",
          initialPrompt: currentPrompt,
        })
        dialog.clear()
      },
    },
    {
      title: "Switch model",
      value: "model.list",
      keybind: "model_list",
      suggested: true,
      category: "Agent",
      onSelect: () => {
        dialog.replace(() => <DialogModel />)
      },
    },
    {
      title: "Model cycle",
      disabled: true,
      value: "model.cycle_recent",
      keybind: "model_cycle_recent",
      category: "Agent",
      onSelect: () => {
        local.model.cycle(1)
      },
    },
    {
      title: "Model cycle reverse",
      disabled: true,
      value: "model.cycle_recent_reverse",
      keybind: "model_cycle_recent_reverse",
      category: "Agent",
      onSelect: () => {
        local.model.cycle(-1)
      },
    },
    {
      title: "Switch agent",
      value: "agent.list",
      keybind: "agent_list",
      category: "Agent",
      onSelect: () => {
        dialog.replace(() => <DialogAgent />)
      },
    },
    {
      title: "Toggle MCPs",
      value: "mcp.list",
      category: "Agent",
      onSelect: () => {
        dialog.replace(() => <DialogMcp />)
      },
    },
    {
      title: "Agent cycle",
      value: "agent.cycle",
      keybind: "agent_cycle",
      category: "Agent",
      onSelect: () => {
        local.agent.move(1)
      },
    },
    {
      title: "Agent cycle reverse",
      value: "agent.cycle.reverse",
      keybind: "agent_cycle_reverse",
      category: "Agent",
      onSelect: () => {
        local.agent.move(-1)
      },
    },
    {
      title: "Connect provider",
      value: "provider.connect",
      suggested: !connected(),
      onSelect: () => {
        dialog.replace(() => <DialogProviderList />)
      },
      category: "Provider",
    },
    {
      title: "Manage API keys",
      value: "api_key.manage",
      suggested: connected(),
      onSelect: () => {
        dialog.replace(() => <DialogApiKey />)
      },
      category: "Provider",
    },
    {
      title: "View status",
      keybind: "status_view",
      value: "opencode.status",
      onSelect: () => {
        dialog.replace(() => <DialogStatus />)
      },
      category: "System",
    },
    {
      title: "Settings",
      value: "opencode.settings",
      onSelect: () => {
        dialog.replace(() => <DialogSettings />)
      },
      category: "System",
    },
    {
      title: "Switch to Build mode",
      value: "mode.build",
      category: "Mode",
      onSelect: () => {
        local.agent.set("build")
        const cfg = sync.data.config as any
        if (cfg?.build_model) {
          const [providerID, modelID] = cfg.build_model.split("/")
          if (providerID && modelID) {
            local.model.set({ providerID, modelID }, { recent: true })
          }
        }
      },
    },
    {
      title: "Switch to Plan mode",
      value: "mode.plan",
      category: "Mode",
      onSelect: () => {
        local.agent.set("plan")
        const cfg = sync.data.config as any
        if (cfg?.plan_model) {
          const [providerID, modelID] = cfg.plan_model.split("/")
          if (providerID && modelID) {
            local.model.set({ providerID, modelID }, { recent: true })
          }
        }
      },
    },
    {
      title: "Switch to Docs mode",
      value: "mode.docs",
      category: "Mode",
      onSelect: () => {
        local.agent.set("docs")
        const cfg = sync.data.config as any
        if (cfg?.docs_model) {
          const [providerID, modelID] = cfg.docs_model.split("/")
          if (providerID && modelID) {
            local.model.set({ providerID, modelID }, { recent: true })
          }
        }
      },
    },
    {
      title: "Switch theme",
      value: "theme.switch",
      onSelect: () => {
        dialog.replace(() => <DialogThemeList />)
      },
      category: "System",
    },
    {
      title: "Toggle appearance",
      value: "theme.switch_mode",
      onSelect: (dialog) => {
        setMode(mode() === "dark" ? "light" : "dark")
        dialog.clear()
      },
      category: "System",
    },
    {
      title: "Help",
      value: "help.show",
      onSelect: () => {
        dialog.replace(() => <DialogHelp />)
      },
      category: "System",
    },
    {
      title: "Send feedback",
      value: "feedback.send",
      onSelect: () => {
        dialog.replace(() => <DialogFeedback onClose={() => dialog.clear()} />)
      },
      category: "System",
    },
    {
      title: "Open docs",
      value: "docs.open",
      onSelect: () => {
        open("https://opencode.ai/docs").catch(() => {})
        dialog.clear()
      },
      category: "System",
    },
    {
      title: "Exit the app",
      value: "app.exit",
      onSelect: () => exit(),
      category: "System",
    },
    {
      title: "Toggle debug panel",
      category: "System",
      value: "app.debug",
      onSelect: (dialog) => {
        renderer.toggleDebugOverlay()
        dialog.clear()
      },
    },
    {
      title: "Toggle console",
      category: "System",
      value: "app.fps",
      onSelect: (dialog) => {
        renderer.console.toggle()
        dialog.clear()
      },
    },
    {
      title: "Suspend terminal",
      value: "terminal.suspend",
      keybind: "terminal_suspend",
      category: "System",
      onSelect: () => {
        process.once("SIGCONT", () => {
          renderer.resume()
        })

        renderer.suspend()
        // pid=0 means send the signal to all processes in the process group
        process.kill(0, "SIGTSTP")
      },
    },
  ])

  event.on(TuiEvent.CommandExecute.type, (evt) => {
    command.trigger(evt.properties.command)
  })

  event.on(TuiEvent.ToastShow.type, (evt) => {
    toast.show({
      title: evt.properties.title,
      message: evt.properties.message,
      variant: evt.properties.variant,
      duration: evt.properties.duration,
    })
  })

  event.on(SessionApi.Event.Deleted.type, (evt) => {
    if (route.data.type === "session" && route.data.sessionID === evt.properties.info.id) {
      dialog.clear()
      route.navigate({ type: "home" })
      toast.show({
        variant: "info",
        message: "The current session was deleted",
      })
    }
  })

  event.on(SessionApi.Event.Error.type, (evt) => {
    const error = evt.properties.error
    const message = (() => {
      if (!error) return "An error occured"

      if (typeof error === "object") {
        const data = error.data
        if ("message" in data && typeof data.message === "string") {
          return data.message
        }
      }
      return String(error)
    })()

    // Don't show error toast for retryable errors (rate limits) - we show a custom PayGo modal instead
    const isRetryable =
      error &&
      typeof error === "object" &&
      "data" in error &&
      error.data &&
      typeof error.data === "object" &&
      "isRetryable" in error.data &&
      error.data.isRetryable === true

    if (isRetryable) {
      // Track rate limit hits per session
      const sessionID = evt.properties.sessionID
      if (sessionID) {
        const currentCount = sessionRateLimitCounts.get(sessionID) || 0
        const newCount = currentCount + 1
        sessionRateLimitCounts.set(sessionID, newCount)

        // Show paywall modal on second rate limit hit (unless dismissed forever)
        if (newCount === 2 && !kv.get("rate_limit_modal_dismissed", false)) {
          DialogRateLimit.showAuto(dialog, () => {
            kv.set("rate_limit_modal_dismissed", true)
          })
        }
      }
      return
    }

    toast.show({
      variant: "error",
      message,
      duration: 5000,
    })

    // For non-retryable errors, prompt user to report
    // Gather metadata for feedback form
    const currentModel = local.model.current()

    // Extract error information
    let errorName: string | undefined
    let errorMessage: string | undefined
    let errorData: unknown

    if (error && typeof error === "object") {
      errorName = error.name
      if (error.data && typeof error.data === "object") {
        errorMessage =
          "message" in error.data && typeof error.data.message === "string" ? error.data.message : undefined
        // Include full error data but ensure it's serializable
        errorData = {
          ...error.data,
          // Ensure statusCode, isRetryable, etc. are included
          statusCode: "statusCode" in error.data ? error.data.statusCode : undefined,
          isRetryable: "isRetryable" in error.data ? error.data.isRetryable : undefined,
          responseHeaders: "responseHeaders" in error.data ? error.data.responseHeaders : undefined,
          responseBody: "responseBody" in error.data ? error.data.responseBody : undefined,
        }
      }
    }

    const metadata: FeedbackMetadata = {
      error: errorName
        ? {
            name: errorName,
            message: errorMessage,
            data: errorData,
          }
        : undefined,
      sessionID: evt.properties.sessionID,
      providerID: currentModel?.providerID,
      modelID: currentModel?.modelID,
    }

    setTimeout(() => {
      dialog.replace(() => <DialogFeedback onClose={() => dialog.clear()} metadata={metadata} />)
    }, 500)
  })

  event.on(Installation.Event.UpdateAvailable.type, (evt) => {
    toast.show({
      variant: "info",
      title: "Update Available",
      message: `OpenCode v${evt.properties.version} is available. Run 'opencode upgrade' to update manually.`,
      duration: 10000,
    })
  })

  // Rate limit handling - track retry state, suggest PayGo with exponential backoff (persisted across sessions)
  if (!rateLimitHandlerRegistered) {
    rateLimitHandlerRegistered = true

    event.on(SessionStatus.Event.Status.type, (evt) => {
      const { status } = evt.properties
      const wasInRetry = isInRetryState
      isInRetryState = status.type === "retry"

      // Show toast when first entering retry
      if (isInRetryState && !wasInRetry) {
        // Get persisted values from KV store (defaults: count=0, nextAt=1)
        const rateLimitCount = kv.get("rateLimitCount", 0) + 1
        const nextPayGoSuggestionAt = kv.get("nextPayGoSuggestionAt", 1)

        // Update the count
        kv.set("rateLimitCount", rateLimitCount)

        if (rateLimitCount >= 10 && !kv.get("rate_limit_modal_dismissed", false)) {
          DialogRateLimit.showAuto(dialog, () => {
            kv.set("rate_limit_modal_dismissed", true)
          })
        }
      }
    })
  }

  // Listen for Ctrl+G during rate limit to open game, Ctrl+U for upgrade
  useKeyboard((evt) => {
    if (isInRetryState) {
      if (evt.name === "g" && evt.ctrl) {
        // Diet Coke game
        open("https://diet-coke.netlify.app/")
      } else if (evt.name === "u" && evt.ctrl) {
        // Open PayGo upgrade page
        open("https://cloud.cerebras.ai?utm-source=cli-paygo")
      }
    }
  })

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      backgroundColor={theme.background}
      onMouseUp={async () => {
        if (Flag.OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT) {
          renderer.clearSelection()
          return
        }
        const text = renderer.getSelection()?.getSelectedText()
        if (text && text.length > 0) {
          const base64 = Buffer.from(text).toString("base64")
          const osc52 = `\x1b]52;c;${base64}\x07`
          const finalOsc52 = process.env["TMUX"] ? `\x1bPtmux;\x1b${osc52}\x1b\\` : osc52
          /* @ts-expect-error */
          renderer.writeOut(finalOsc52)
          await Clipboard.copy(text)
            .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
            .catch(toast.error)
          renderer.clearSelection()
        }
      }}
    >
      <Show when={!showOnboarding()} fallback={<CerebrasOnboarding onComplete={() => setShowOnboarding(false)} />}>
        <Show
          when={!showQuickStart()}
          fallback={<QuickStartOnboarding onSelect={handleQuickStartSelect} onSkip={() => setShowQuickStart(false)} />}
        >
          <Show
            when={!fullscreenNotification()}
            fallback={
              <FullscreenNotification
                notification={fullscreenNotification()!}
                onClose={() => {
                  Notification.markSeen(fullscreenNotification()!.id)
                  setFullscreenNotification(null)
                }}
              />
            }
          >
            <Show when={bannerNotification()}>
              {(notif) => (
                <NotificationBanner
                  notification={notif()}
                  onDismiss={() => {
                    Notification.markSeen(notif().id)
                    setBannerNotification(null)
                  }}
                />
              )}
            </Show>
            <Switch>
              <Match when={route.data.type === "home"}>
                <Home />
              </Match>
              <Match when={route.data.type === "session"}>
                <Session />
              </Match>
            </Switch>
          </Show>
        </Show>
      </Show>
    </box>
  )
}

function ErrorComponent(props: { error: Error; reset: () => void; onExit: () => Promise<void> }) {
  const term = useTerminalDimensions()
  useKeyboard((evt) => {
    if (evt.ctrl && evt.name === "c") {
      props.onExit()
    }
  })
  const [copied, setCopied] = createSignal(false)

  const issueURL = new URL("https://github.com/sst/opencode/issues/new?template=bug-report.yml")

  if (props.error.message) {
    issueURL.searchParams.set("title", `opentui: fatal: ${props.error.message}`)
  }

  if (props.error.stack) {
    issueURL.searchParams.set(
      "description",
      "```\n" + props.error.stack.substring(0, 6000 - issueURL.toString().length) + "...\n```",
    )
  }

  issueURL.searchParams.set("opencode-version", Installation.VERSION)

  const copyIssueURL = () => {
    Clipboard.copy(issueURL.toString()).then(() => {
      setCopied(true)
    })
  }

  return (
    <box flexDirection="column" gap={1}>
      <box flexDirection="row" gap={1} alignItems="center">
        <text attributes={TextAttributes.BOLD}>Please report an issue.</text>
        <box onMouseUp={copyIssueURL} backgroundColor="#565f89" padding={1}>
          <text attributes={TextAttributes.BOLD}>Copy issue URL (exception info pre-filled)</text>
        </box>
        {copied() && <text>Successfully copied</text>}
      </box>
      <box flexDirection="row" gap={2} alignItems="center">
        <text>A fatal error occurred!</text>
        <box onMouseUp={props.reset} backgroundColor="#565f89" padding={1}>
          <text>Reset TUI</text>
        </box>
        <box onMouseUp={props.onExit} backgroundColor="#565f89" padding={1}>
          <text>Exit</text>
        </box>
      </box>
      <scrollbox height={Math.floor(term().height * 0.7)}>
        <text>{props.error.stack}</text>
      </scrollbox>
      <text>{props.error.message}</text>
    </box>
  )
}
