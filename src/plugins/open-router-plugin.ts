import { OPENROUTER_BASE_URL } from "../constants/provider-defauls";
import type { ProviderPlugin, SSEDelimiter } from "../provider-plugin";
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
    public readonly delimiter: SSEDelimiter = '\n\n';

    constructor(apiKey: string, systemMessage?: string) {
        this.apiKey = apiKey;
        this.systemMessage = systemMessage;
    }

    async prepareRequest(params: SSEEngineParams) {
        const { userMessage, options, debug, referrer, title } = params;

        if (debug) {
            console.debug("[OpenRouterPlugin] prepareRequest called with userMessage:", userMessage);
        }

        // Build messages array
        const messages = [];
        if (this.systemMessage) {
            messages.push({ role: "system", content: this.systemMessage });
        }
        messages.push({ role: "user", content: userMessage });

        const model = options?.model || "deepseek/deepseek-chat";

        if (debug) {
            console.debug("[OpenRouterPlugin] Using model:", model);
            console.debug("[OpenRouterPlugin] Fetch body:", {
                model,
                messages,
                stream: true,
                ...options,
            });
        }

        const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                "Content-Type": "application/json",
                ...(referrer && { "HTTP-Referer": referrer }),
                ...(title && { "X-Title": title }),
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
            if (debug) {
                console.debug("[OpenRouterPlugin] Non-OK response:", response.status, errorText);
            }
            throw new Error(`OpenRouter API error: ${response.statusText} - ${errorText}`);
        }

        if (debug) {
            console.debug("[OpenRouterPlugin] Successfully received readable stream from OpenRouter.");
        }

        // Return the reader
        return response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    }

    parseServerSentEvent(line: string): string | null {
        // If you want to see each line in debug mode:
        // The only complication: we don't have direct access to `debug` here
        // unless we store it, but let's demonstrate a possible approach:
        // (In a real codebase, you might store `debug` on the class instance
        // or pass it in parseServerSentEvent() each time.)
        // For clarity, we won't do it here. If needed, set up a pattern
        // to store `debug` in the plugin instance or pass it in from the engine.

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