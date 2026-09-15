export interface DeepSeekCallParameters {
  readonly baseURL: string;
  readonly apiKey: string;
  readonly model: string;
  readonly messages: ReadonlyArray<{
    readonly role: "system" | "user" | "assistant";
    readonly content: string;
  }>;
  readonly thinking?: "enabled" | "disabled";
  readonly reasoningEffort?: "low" | "medium" | "high";
}

export async function callDeepSeek(
  parameters: DeepSeekCallParameters,
): Promise<string | null> {
  const baseURL = parameters.baseURL.trim().replace(/\/+$/, "");

  if (!baseURL) {
    throw new Error("DeepSeek baseURL must not be empty");
  }

  if (!parameters.apiKey.trim()) {
    throw new Error("DeepSeek apiKey must not be empty");
  }

  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${parameters.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: parameters.model,
      messages: parameters.messages,
      stream: false,
      ...(parameters.thinking
        ? { thinking: { type: parameters.thinking } }
        : {}),
      ...(parameters.reasoningEffort
        ? { reasoning_effort: parameters.reasoningEffort }
        : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(
      `DeepSeek request failed with status ${response.status}`,
    );
  }

  const body: unknown = await response.json();

  if (
    !isRecord(body) ||
    !Array.isArray(body.choices) ||
    !isRecord(body.choices[0]) ||
    !isRecord(body.choices[0].message)
  ) {
    throw new Error("DeepSeek returned an invalid response");
  }

  const result = body.choices[0].message.content;

  if (result !== null && typeof result !== "string") {
    throw new Error("DeepSeek returned invalid message content");
  }

  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
