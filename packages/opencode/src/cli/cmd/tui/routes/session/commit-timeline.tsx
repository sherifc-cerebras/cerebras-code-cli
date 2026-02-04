import { createMemo, createSignal, For, Show, createEffect } from "solid-js"
import { useTheme } from "../../context/theme"
import { useKeyboard } from "@opentui/solid"
import path from "path"
import type { Snapshot } from "@/snapshot"

export interface CommitTimelineProps {
  sessionID: string
  commits: Snapshot.CommitInfo[]
  onSelectCommit: (commit: Snapshot.CommitInfo) => void
  onClose?: () => void
  selectedIndex?: number
  active: boolean
  activeHash?: string // The commit hash currently restored to
}

export function CommitTimeline(props: CommitTimelineProps) {
  const { theme } = useTheme()
  const [selectedIndex, setSelectedIndex] = createSignal(props.selectedIndex ?? 0)

  // Handle keyboard navigation when active
  useKeyboard((evt) => {
    if (!props.active) return
    
    if (evt.name === "down") {
      evt.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, props.commits.length - 1))
    } else if (evt.name === "up") {
      evt.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (evt.shift && evt.name === "tab") {
      evt.preventDefault()
      const commit = props.commits[selectedIndex()]
      if (commit) {
        props.onSelectCommit(commit)
      }
    } else if (evt.name === "escape") {
      evt.preventDefault()
      props.onClose?.()
    }
  })

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp)
    const now = new Date()
    const isToday = date.toDateString() === now.toDateString()
    
    if (isToday) {
      return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    }
    return date.toLocaleDateString([], { month: "short", day: "numeric" })
  }

  const selectedCommit = createMemo(() => props.commits[selectedIndex()])
  
  const getCommitSummary = (commit: Snapshot.CommitInfo) => {
    if (commit.files.length === 0) return "No changes"
    if (commit.files.length === 1) return path.basename(commit.files[0])
    return `${commit.files.length} files`
  }

  return (
    <box
      flexDirection="column"
      width={45}
      height="100%"
      borderStyle="single"
      borderColor={theme.borderSubtle}
      border={["left"]}
    >
      <box paddingLeft={1} paddingRight={1} flexShrink={0}>
        <text fg={theme.text}>
          <span style={{ fg: theme.accent }}>Commits</span>
          <span style={{ fg: theme.textMuted }}> ({props.commits.length})</span>
        </text>
      </box>
      
      <scrollbox flexGrow={1} flexBasis={0}>
        <box flexDirection="column" paddingLeft={1} paddingRight={1}>
          <Show when={props.commits.length === 0}>
            <box paddingTop={1}>
              <text fg={theme.textMuted}>No commits yet</text>
            </box>
          </Show>
          
          <For each={props.commits}>
            {(commit, index) => {
              const isSelected = () => selectedIndex() === index()
              const isActive = () => props.activeHash === commit.hash
              const filesSummary = getCommitSummary(commit)
              
              return (
                <box
                  flexDirection="column"
                  backgroundColor={isSelected() ? theme.backgroundElement : undefined}
                  marginTop={index() === 0 ? 0 : 1}
                  onMouseUp={() => {
                    setSelectedIndex(index())
                    props.onSelectCommit(commit)
                  }}
                >
                  <box flexDirection="row" gap={1}>
                    <text fg={isActive() ? theme.success : isSelected() ? theme.accent : theme.textMuted}>
                      {isActive() ? "●" : isSelected() ? "▶" : " "}
                    </text>
                    <text fg={isSelected() ? theme.text : theme.textMuted}>
                      {commit.message}
                      {isActive() ? " (current)" : ""}
                    </text>
                  </box>
                  <box flexDirection="row" gap={1} paddingLeft={2}>
                    <text fg={theme.textMuted}>{filesSummary}</text>
                    <text fg={theme.textMuted}>•</text>
                    <text fg={theme.textMuted}>{formatTime(commit.timestamp)}</text>
                  </box>
                </box>
              )
            }}
          </For>
        </box>
      </scrollbox>
      
      {/* Selected commit files */}
      <Show when={selectedCommit()}>
        <box
          flexDirection="column"
          borderStyle="single"
          border={["top"]}
          borderColor={theme.borderSubtle}
          paddingLeft={1}
          paddingRight={1}
          maxHeight={10}
          flexShrink={0}
        >
          <text fg={theme.accent}>Files changed:</text>
          <Show when={selectedCommit()!.files.length === 0}>
            <text fg={theme.textMuted}>No files</text>
          </Show>
          <For each={selectedCommit()!.files.slice(0, 6)}>
            {(file) => (
              <text fg={theme.textMuted}>{path.basename(file)}</text>
            )}
          </For>
          <Show when={selectedCommit()!.files.length > 6}>
            <text fg={theme.textMuted}>+{selectedCommit()!.files.length - 6} more</text>
          </Show>
        </box>
      </Show>
      
      <box paddingLeft={1} paddingRight={1} flexShrink={0}>
        <text fg={theme.textMuted}>↑↓ nav • ⇧⇥ restore • esc close</text>
      </box>
    </box>
  )
}
