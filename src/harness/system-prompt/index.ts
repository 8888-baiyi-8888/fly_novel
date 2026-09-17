import type { ToolSchema } from "@fly-novel/llm"
/** One resolved dynamic context contribution. */
export interface AssembledContext {
  /** The contributing context's unique name. */
  name: string
  /** The resolved text before variable interpolation. */
  text: string
}

/** One section of an assembly: {@link PromptSection} with its text resolved. */
export interface AssembledSection {
  /** The contributing section's unique name. */
  name: string
  /** The resolved (but not yet interpolated) section text. */
  text: string
  /** Whether to interpolate prompt variables. Defaults to true; false preserves literal text. */
  interpolate?: boolean
}

/**
 * Merge-extensible assembled model input. Sections and contexts remain
 * uninterpolated until rendered; tools are already in canonical order.
 */
export interface PromptAssembly {
  sections: AssembledSection[]
  contexts: AssembledContext[]
  tools: ToolSchema[]
  variables: Record<string, string | undefined>
}