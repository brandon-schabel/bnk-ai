import { OPENROUTER_BASE_URL } from "../constants/provider-defauls";
import type { ProviderPlugin } from "../provider-plugin";
import type { SSEEngineParams } from "../streaming-types";

type OpenRouterStreamResponse = {
    choices: {
        delta?: { content?: string };
        content?: string;
    }[];
};

export class OpenRouterPlugin implements ProviderPlugin {
    private apiKey: string;
    private systemMessage?: string;

    constructor(apiKey: string, systemMessage?: string) {
        this.apiKey = apiKey;
        this.systemMessage = systemMessage;
    }

    async prepareRequest(params: SSEEngineParams) {
        const { userMessage, options } = params;

        // Build messages array
        const messages = [];
        if (this.systemMessage) {
            messages.push({ role: "system", content: this.systemMessage });
        }
        messages.push({ role: "user", content: userMessage });

        const model = options?.model || "deepseek/deepseek-chat";

        const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model,
                messages,
                stream: true,
                ...options,
            }),
        });

        if (!response.ok || !response.body) {
            const errorText = await response.text();
            throw new Error(`OpenRouter API error: ${response.statusText} - ${errorText}`);
        }

        return response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
    }

    parseServerSentEvent(line: string): string | null {
        if (!line.startsWith("data:")) return null;
        const jsonString = line.replace(/^data:\s*/, "").trim();

        if (jsonString === "[DONE]") return "[DONE]";

        try {
            const parsed = JSON.parse(jsonString) as OpenRouterStreamResponse;
            const content = parsed.choices?.[0]?.delta?.content || "";
            return content || null;
        } catch {
            return null;
        }
    }
}