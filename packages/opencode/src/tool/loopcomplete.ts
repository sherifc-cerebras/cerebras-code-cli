import z from "zod"
import { Tool } from "./tool"

export const LoopCompleteTool = Tool.define("loopcomplete", {
  description:
    "Signal that the autonomous loop task is complete. Call this tool ONLY when the task is fully finished and verified. Provide a brief summary of what was accomplished.",
  parameters: z.object({
    summary: z.string().describe("Brief summary of what was accomplished across all iterations"),
  }),
  async execute(args) {
    return {
      title: "Loop Complete",
      metadata: {},
      output: args.summary,
    }
  },
})
