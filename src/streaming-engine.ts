import type { DebugOptions, SSEEngineParams, SSEEngineHandlers, SSEMessage } from "./streaming-types";

/**
 * Helper to determine if a specific debug category is enabled.
 * If `debug` is `true` (boolean), we enable everything.
 * If `debug` is an object, check `debug.all` or the specific category.
 */
function isDebugEnabled(debug: boolean | DebugOptions | undefined, category: keyof DebugOptions): boolean {
    if (!debug) return false;
    if (typeof debug === "boolean") return debug; // if `true`, all debug is on
    return !!(debug.all || debug[category]);
}

/**
 * New helper to detect JSON errors from the model or API side.
 * Calls `onError` if we find a JSON payload like: { "error": { "message": "..."} }
 */
function handlePossibleErrorJSON(
    rawText: string,
    onError: SSEEngineHandlers["onError"],
    controller: ReadableStreamDefaultController<Uint8Array>
): boolean {
    const trimmedText = rawText.trim().replace(/^data:\s*/, "");
    if (!trimmedText.startsWith("{")) {
        return false; // Not JSON or not an error object
    }
    try {
        const parsed = JSON.parse(trimmedText);
        if (parsed.error && parsed.error.message) {
            const errorMsg = parsed.error.message;
            onError?.(new Error(errorMsg), {
                role: "assistant",
                content: ""
            });
            controller.error(new Error(errorMsg));
            return true;
        }
    } catch {
        // Not valid JSON or parse error, so ignore
    }
    return false;
}

export async function createSSEStream(params: SSEEngineParams): Promise<ReadableStream<Uint8Array>> {
    const { plugin, systemMessage, userMessage, handlers, options, debug } = params;

    if (isDebugEnabled(debug, "plugin")) {
        console.debug("[createSSEStream] Starting SSE stream with plugin:", plugin.constructor.name);
        console.debug("[createSSEStream] System message:", systemMessage);
        console.debug("[createSSEStream] User message:", userMessage);
        console.debug("[createSSEStream] Options:", options);
    }

    let streamOrReader: ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array>;

    try {
        // Prepare request via plugin
        streamOrReader = await plugin.prepareRequest({
            userMessage,
            systemMessage,
            options,
            handlers,
            plugin,
            debug
        });
        if (isDebugEnabled(debug, "plugin")) {
            console.debug("[createSSEStream] Request prepared successfully.");
        }
    } catch (error) {
        handlers.onError?.(error, { role: "assistant", content: "" });
        if (isDebugEnabled(debug, "plugin")) {
            console.debug("[createSSEStream] Plugin threw an error before streaming:", error);
        }
        return new ReadableStream<Uint8Array>({
            start(controller) {
                controller.close();
            },
        });
    }

    // Fire off optional handlers for system and user messages
    if (systemMessage && handlers.onSystemMessage) {
        handlers.onSystemMessage({ role: "system", content: systemMessage });
    }
    if (handlers.onUserMessage) {
        handlers.onUserMessage({ role: "user", content: userMessage });
    }

    const reader =
        streamOrReader instanceof ReadableStream
            ? streamOrReader.getReader()
            : streamOrReader;

    let fullResponse = "";
    let buffer = "";

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    return new ReadableStream<Uint8Array>({
        async start(controller) {
            if (isDebugEnabled(debug, "sse")) {
                console.debug("[createSSEStream] Beginning SSE read loop.");
            }
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        if (isDebugEnabled(debug, "sse")) {
                            console.debug("[createSSEStream] Reader returned done, ending loop.");
                        }
                        break;
                    }

                    const chunk = decoder.decode(value, { stream: true });
                    buffer += chunk;

                    // Split the buffer on the plugin's delimiter or default "\n\n"
                    const events = buffer.split(plugin.delimiter ?? "\n\n");
                    buffer = events.pop() ?? ""; // keep leftover chunk

                    if (isDebugEnabled(debug, "sse")) {
                        console.debug("[createSSEStream] Received chunk:", chunk);
                        console.debug("[createSSEStream] Split into events:", events);
                    }

                    for (const event of events) {
                        const trimmed = event.trim();
                        if (!trimmed) continue;

                        // Detect possible error JSON
                        if (handlePossibleErrorJSON(trimmed, handlers.onError, controller)) {
                            return; // stop streaming after an error
                        }

                        // Normal SSE lines
                        const lines = trimmed.split("\n").map((ln) => ln.trim());
                        const sseLines = lines.filter((ln) => ln && !ln.startsWith(":"));

                        let eventText = "";
                        for (const sseLine of sseLines) {
                            const parsed = plugin.parseServerSentEvent(sseLine);

                            // If we get a special [DONE] token from plugin
                            if (parsed === "[DONE]") {
                                handlers.onDone?.({
                                    role: "assistant",
                                    content: fullResponse
                                });
                                if (isDebugEnabled(debug, "sse")) {
                                    console.debug("[createSSEStream] Received [DONE], closing stream.");
                                }
                                controller.close();
                                return;
                            }
                            if (parsed) {
                                eventText += parsed;
                            }
                        }

                        if (eventText) {
                            fullResponse += eventText;
                            controller.enqueue(encoder.encode(eventText));

                            // Fire onPartial if you want chunk-based updates
                            handlers.onPartial?.({
                                role: "assistant",
                                content: eventText
                            });

                            if (isDebugEnabled(debug, "sse")) {
                                console.debug("[createSSEStream] Emitted partial text:", eventText);
                            }
                        }
                    }
                }

                // Handle any leftover buffer after loop
                const leftover = buffer.trim();
                if (leftover) {
                    if (isDebugEnabled(debug, "sse")) {
                        console.debug("[createSSEStream] Handling leftover buffer:", leftover);
                    }

                    // Check if leftover is an error JSON
                    if (handlePossibleErrorJSON(leftover, handlers.onError, controller)) {
                        return;
                    }

                    const lines = leftover.split("\n").map((ln) => ln.trim());
                    let leftoverText = "";
                    for (const line of lines) {
                        if (line.startsWith(":")) continue;
                        const parsed = plugin.parseServerSentEvent(line);

                        if (parsed === "[DONE]") {
                            handlers.onDone?.({
                                role: "assistant",
                                content: fullResponse
                            });
                            if (isDebugEnabled(debug, "sse")) {
                                console.debug("[createSSEStream] Received [DONE] in leftover, closing stream.");
                            }
                            controller.close();
                            return;
                        }
                        if (parsed) {
                            leftoverText += parsed;
                        }
                    }

                    if (leftoverText) {
                        fullResponse += leftoverText;
                        controller.enqueue(encoder.encode(leftoverText));
                        handlers.onPartial?.({
                            role: "assistant",
                            content: leftoverText
                        });
                        if (isDebugEnabled(debug, "sse")) {
                            console.debug("[createSSEStream] Emitted leftover partial text:", leftoverText);
                        }
                    }
                }

                // Completed normally (no error & no [DONE])
                handlers.onDone?.({
                    role: "assistant",
                    content: fullResponse
                });
                if (isDebugEnabled(debug, "sse")) {
                    console.debug("[createSSEStream] Finished reading, closing controller.");
                }
                controller.close();
            } catch (error) {
                // If we catch any read/parsing error, pass partialSoFar
                controller.error(error);
                handlers.onError?.(error, {
                    role: "assistant",
                    content: fullResponse
                });
                if (isDebugEnabled(debug, "sse")) {
                    console.debug("[createSSEStream] Caught error in read loop:", error);
                }
            }
        },
    });
}