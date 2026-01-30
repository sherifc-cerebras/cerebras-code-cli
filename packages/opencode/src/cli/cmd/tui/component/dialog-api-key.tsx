import { createMemo } from "solid-js"
import { useSync } from "@tui/context/sync"
import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"

export function DialogApiKey() {
  const sync = useSync()
  const dialog = useDialog()

  const options = createMemo(() => {
    const connectedProviderIDs = sync.data.provider_next.connected
    return sync.data.provider
      .filter((provider) => connectedProviderIDs.includes(provider.id))
      .map((provider) => ({
        title: provider.name,
        value: provider.id,
        onSelect: () => {
          dialog.replace(() => <ActionDialog providerID={provider.id} providerName={provider.name} />)
        },
      }))
  })

  if (options().length === 0) {
    return (
      <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
        <text>No providers configured with API keys</text>
      </box>
    )
  }

  return <DialogSelect title="Select provider" options={options()} />
}

function ActionDialog(props: { providerID: string; providerName: string }) {
  const dialog = useDialog()
  const { theme } = useTheme()

  const options = [
    {
      title: "Enter new API key",
      value: "enter",
      onSelect: () => {
        dialog.replace(() => <ApiKeyInputDialog providerID={props.providerID} providerName={props.providerName} />)
      },
    },
    {
      title: "Return",
      value: "return",
      onSelect: () => {
        dialog.replace(() => <DialogApiKey />)
      },
    },
  ]

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD}>{props.providerName}</text>
        <text fg={theme.textMuted}>esc</text>
      </box>
      <DialogSelect title="Select action" options={options} />
    </box>
  )
}

function ApiKeyInputDialog(props: { providerID: string; providerName: string }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()
  const { theme } = useTheme()

  return (
    <DialogPrompt
      title={`Update ${props.providerName} API key`}
      placeholder="Enter new API key"
      onConfirm={async (value) => {
        if (!value || value.trim() === "") {
          toast.show({
            variant: "error",
            message: "API key cannot be empty",
            duration: 3000,
          })
          return
        }

        try {
          sdk.client.auth.set({
            providerID: props.providerID,
            auth: {
              type: "api",
              key: value.trim(),
            },
          })
          await sdk.client.instance.dispose()
          await sync.bootstrap()
          toast.show({
            variant: "success",
            message: `${props.providerName} API key updated`,
            duration: 3000,
          })
          dialog.clear()
        } catch (error) {
          toast.show({
            variant: "error",
            message: `Failed to update API key: ${error instanceof Error ? error.message : "Unknown error"}`,
            duration: 5000,
          })
        }
      }}
      onCancel={() => {
        dialog.replace(() => <ActionDialog providerID={props.providerID} providerName={props.providerName} />)
      }}
    />
  )
}
