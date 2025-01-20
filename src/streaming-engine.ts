import type { DebugOptions, SSEEngineParams } from "./streaming-types";

/**
 * Helper to determine if a specific debug category is enabled.
 * If `debug` is `true` (boolean), we enable everything.
 * If `debug` is an object, check `debug.all` or the specific category.
 */
function isDebugEnabled(debug: boolean | DebugOptions | undefined, category: keyof DebugOptions): boolean {
    if (!debug) return false;
    if (typeof debug === "boolean") return debug; // if `true`, all debug is on
    return !!debug.all || !!debug[category];
}


export async function createSSEStream(
    params: SSEEngineParams
): Promise<ReadableStream<Uint8Array>> {
    const { plugin, systemMessage, userMessage, handlers, options, debug } = params;

    // Instead of just `if(debug)`, we use the helper with a category
    if (isDebugEnabled(debug, "plugin")) {
        console.debug("[createSSEStream] Starting SSE stream with plugin:", plugin.constructor.name);
        console.debug("[createSSEStream] System message:", systemMessage);
        console.debug("[createSSEStream] User message:", userMessage);
        console.debug("[createSSEStream] Options:", options);
    }

    let streamOrReader: ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array>;

    try {
        streamOrReader = await plugin.prepareRequest({
            userMessage,
            systemMessage,
            options,
            handlers,
            plugin,
            debug, // pass the whole debug config on
        });
        if (isDebugEnabled(debug, "plugin")) {
            console.debug("[createSSEStream] Request prepared successfully.");
        }
    } catch (error) {
        if (handlers.onError) {
            handlers.onError(error, {
                role: "assistant",
                content: "",
            });
        }
        if (isDebugEnabled(debug, "plugin")) {
            console.debug("[createSSEStream] Plugin threw an error before streaming:", error);
        }
        return new ReadableStream<Uint8Array>({
            start(controller) {
                controller.close();
            },
        });
    }

    if (systemMessage && handlers.onSystemMessage) {
        handlers.onSystemMessage({ role: "system", content: systemMessage });
    }
    if (handlers.onUserMessage) {
        handlers.onUserMessage({ role: "user", content: userMessage });
    }

    const reader = streamOrReader instanceof ReadableStream
        ? streamOrReader.getReader()
        : streamOrReader;

    let fullResponse = "";
    let buffer = "";

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    return new ReadableStream<Uint8Array>({
        async start(controller) {
            if (isDebugEnabled(debug, "sse")) {
                console.debug("[createSSEStream] Beginning to read from SSE stream/reader.");
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

                    const events = buffer.split(plugin.delimiter ?? "\n\n");
                    buffer = events.pop() ?? "";

                    if (isDebugEnabled(debug, "sse")) {
                        console.debug("[createSSEStream] Received chunk:", chunk);
                        console.debug("[createSSEStream] Split into events:", events);
                    }

                    for (const event of events) {
                        const trimmed = event.trim();
                        if (!trimmed) continue;

                        const lines = trimmed.split("\n").map((ln) => ln.trim());
                        const sseLines = lines.filter((ln) => ln && !ln.startsWith(":"));

                        let eventText = "";
                        for (const sseLine of sseLines) {
                            const parsed = plugin.parseServerSentEvent(sseLine);
                            if (parsed === "[DONE]") {
                                if (handlers.onDone) {
                                    handlers.onDone({
                                        role: "assistant",
                                        content: fullResponse,
                                    });
                                }
                                if (isDebugEnabled(debug, "sse")) {
                                    console.debug("[createSSEStream] Received [DONE] event, closing stream.");
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

                            if (handlers.onPartial) {
                                handlers.onPartial({
                                    role: "assistant",
                                    content: eventText,
                                });
                            }
                            if (isDebugEnabled(debug, "sse")) {
                                console.debug("[createSSEStream] Emitted partial text:", eventText);
                            }
                        }
                    }
                }

                const leftover = buffer.trim();
                if (leftover) {
                    if (isDebugEnabled(debug, "sse")) {
                        console.debug("[createSSEStream] Handling leftover buffer:", leftover);
                    }
                    const lines = leftover.split("\n").map((l) => l.trim());
                    let leftoverText = "";

                    for (const line of lines) {
                        if (line.startsWith(":")) continue;
                        const parsed = plugin.parseServerSentEvent(line);
                        if (parsed === "[DONE]") {
                            if (handlers.onDone) {
                                handlers.onDone({
                                    role: "assistant",
                                    content: fullResponse,
                                });
                            }
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
                        if (handlers.onPartial) {
                            handlers.onPartial({
                                role: "assistant",
                                content: leftoverText,
                            });
                        }
                        if (isDebugEnabled(debug, "sse")) {
                            console.debug("[createSSEStream] Emitted leftover partial text:", leftoverText);
                        }
                    }
                }

                if (handlers.onDone) {
                    handlers.onDone({
                        role: "assistant",
                        content: fullResponse,
                    });
                }
                if (isDebugEnabled(debug, "sse")) {
                    console.debug("[createSSEStream] Streaming complete, closing controller.");
                }
                controller.close();
            } catch (error) {
                controller.error(error);
                if (handlers.onError) {
                    handlers.onError(error, {
                        role: "assistant",
                        content: fullResponse,
                    });
                }
                if (isDebugEnabled(debug, "sse")) {
                    console.debug("[createSSEStream] Caught error in read loop:", error);
                }
            }
        },
    });
}