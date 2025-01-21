/**
 * open-router-structured-plugin.ts
 *
 * A specialized plugin for streaming structured outputs from OpenRouter
 * using a JSON Schema. Demonstrates how to forward `systemMessage` from
 * SSE params and properly parse SSE lines containing "message.parsed".
 */

import type { ProviderPlugin, SSEDelimiter } from "../provider-plugin";
import type {
    SSEEngineParams,
    SSEMessage,
} from "../streaming-types";

/**
 * This interface represents the JSON structure we might receive when
 * streaming from OpenRouter's Chat Completions endpoint. Adjust to
 * your actual usage.
 */
interface OpenRouterStreamResponse {
    choices?: Array<{
        delta?: {
            content?: string;    // For normal text streaming
        };
        message?: {
            content?: string;    // Sometimes text-based
            parsed?: unknown;    // When in structured mode
            refusal?: string;    // If the model refuses the request
        };
    }>;
}

/**
 * A plugin to handle streaming from OpenRouter with JSON Schema outputs.
 */
export class OpenRouterStructuredPlugin implements ProviderPlugin {
    private apiKey: string;
    public readonly delimiter: SSEDelimiter = "\n\n";

    constructor(apiKey: string) {
        this.apiKey = apiKey;
    }

    /**
     * Prepare the streaming request to OpenRouter. If you want to pass
     * a `systemMessage` from SSEEngineParams, read it here and push it
     * into your `messages` array.
     */
    async prepareRequest(params: SSEEngineParams) {
        // The SSEEngineParams includes systemMessage, userMessage, and any provider-specific options.
        const { userMessage, systemMessage, options } = params;

        const referrer = options?.referrer
        const title = options?.title

        // Build the array of messages. 
        // Notice we do not store a "this.systemMessage"; we read it from params so it's always fresh.
        const messages: Array<{ role: string; content: string }> = [];
        if (systemMessage) {
            messages.push({ role: "system", content: systemMessage });
        }
        messages.push({ role: "user", content: userMessage });

        // If the caller passes a "model" in options, default to GPT-4 or something else.
        const model = options?.model ?? "deepseek/deepseek-chat";

        // Construct the request body:
        // - "stream" must be true for SSE streaming
        // - Merge in user-provided "response_format" if any
        const body: Record<string, any> = {
            model,
            messages,
            stream: true,
            ...options,
        };

        // If using structured outputs, ensure "response_format" is part of the request
        if (options?.response_format) {
            body.response_format = options.response_format;
        }

        // Fire off the fetch
        const endpoint = "https://openrouter.ai/api/v1/chat/completions"; // Or your base

        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                "Content-Type": "application/json",
                ...(referrer && { "HTTP-Referer": referrer }),
                ...(title && { "X-Title": title }),
            },
            body: JSON.stringify(body),
        });

        // If the request fails or there's no body, throw
        if (!response.ok || !response.body) {
            const errorText = await response.text();
            throw new Error(
                `OpenRouter API error: ${response.statusText} - ${errorText}`
            );
        }

        // Return the ReadableStream reader
        return response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    }

    /**
     * Parse each SSE line. Return either:
     *   - "[DONE]" if it signals the end
     *   - a string of text if there's partial data
     *   - null if there's nothing to extract
     */
    parseServerSentEvent(line: string): string | null {
        // SSE lines typically start with "data: "
        if (!line.startsWith("data:")) return null;
        const jsonString = line.replace(/^data:\s*/, "").trim();

        // If the server signals done
        if (jsonString === "[DONE]") {
            return "[DONE]";
        }

        try {
            // Parse the JSON chunk
            const parsed = JSON.parse(jsonString) as OpenRouterStreamResponse;
            const choice = parsed?.choices?.[0];
            if (!choice) return null;

            // 1) Normal text-based streaming
            if (choice.delta?.content) {
                return choice.delta.content;
            }

            // 2) Structured output (message.parsed)
            if (choice.message?.refusal) {
                // The model refused. Return the refusal text if desired
                return choice.message.refusal;
            }
            if (choice.message?.parsed) {
                return JSON.stringify(choice.message.parsed);
            }
            if (choice.message?.content) {
                return choice.message.content;
            }

            // If no recognized content, return null
            return null;
        } catch {
            // If it's not valid JSON or doesn't match our pattern, ignore
            return null;
        }
    }
}