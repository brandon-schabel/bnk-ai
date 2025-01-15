import type { ProviderPlugin, SSEDelimiter } from "../provider-plugin";
import type { SSEEngineParams } from "../streaming-types";
import { OLLAMA_BASE_URL } from "../constants/provider-defauls";


type BaseResponse = {
    model: string;
    createdAt: string;
    response: string;
    done: boolean;
}

// TODO: add support to handle retrieving these values
type FinalResponse = BaseResponse & {
    done: true;
    done_reason: string;
    context: number[];
    total_duration: number;
    load_duration: number;
    prompt_eval_count: number;
    prompt_eval_duration: number;
    eval_count: number;
    eval_duration: number;
}

export class OllamaPlugin implements ProviderPlugin {
    private baseUrl: string;
    public readonly delimiter: SSEDelimiter = '\n';

    constructor(baseUrl: string = OLLAMA_BASE_URL) {
        this.baseUrl = baseUrl;
    }

    async prepareRequest(params: SSEEngineParams) {
        const { userMessage, options } = params;

        // Build request body for /api/generate
        const body = {
            model: options?.model || "llama3:latest",
            prompt: userMessage,
            stream: true,
            ...options, // pass along other config such as temperature, etc.
        };

        const response = await fetch(`${this.baseUrl}/api/generate`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
        });

        if (!response.ok || !response.body) {
            throw new Error(`Ollama API error: ${response.statusText}`);
        }

        return response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    }

    parseServerSentEvent(line: string): string | null {
        try {
            const data = JSON.parse(line.trim()) as BaseResponse | FinalResponse

            // If Ollama indicates the stream is finished
            if (data.done) {
                return "[DONE]";
            }

            if (typeof data.response === 'string') {
                return data.response;
            }

            return null;
        } catch (error) {
            console.error("[OllamaPlugin] error", error);
            // If partial or invalid JSON, just ignore
            return null;
        }
    }
}