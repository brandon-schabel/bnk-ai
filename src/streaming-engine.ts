import type { SSEEngineParams } from "./streaming-types";

export async function createSSEStream(
    params: SSEEngineParams
): Promise<ReadableStream<Uint8Array>> {
    const { plugin, systemMessage, userMessage, handlers, options, debug } = params;

    if (debug) {
        console.debug("[createSSEStream] Starting SSE stream with plugin:", plugin.constructor.name);
        console.debug("[createSSEStream] System message:", systemMessage);
        console.debug("[createSSEStream] User message:", userMessage);
        console.debug("[createSSEStream] Options:", options);
    }

    let streamOrReader: ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array>;

    // 1) Prepare the request via the plugin
    try {
        streamOrReader = await plugin.prepareRequest({
            userMessage,
            systemMessage,
            options,
            handlers,
            plugin,
            debug, // Pass debug flag to plugin
        });
        if (debug) {
            console.debug("[createSSEStream] Request prepared successfully.");
        }
    } catch (error) {
        // If plugin fails immediately, call onError
        if (handlers.onError) {
            handlers.onError(error, {
                role: "assistant",
                content: "",
            });
        }
        if (debug) {
            console.debug("[createSSEStream] Plugin threw an error before streaming:", error);
        }
        // Return an empty closed stream
        return new ReadableStream<Uint8Array>({
            start(controller) {
                controller.close();
            },
        });
    }

    // 2) Fire system/user message handlers
    if (systemMessage && handlers.onSystemMessage) {
        handlers.onSystemMessage({ role: "system", content: systemMessage });
    }
    if (handlers.onUserMessage) {
        handlers.onUserMessage({ role: "user", content: userMessage });
    }

    // 3) Normalize the reader
    const reader =
        streamOrReader instanceof ReadableStream
            ? streamOrReader.getReader()
            : streamOrReader;

    // We'll accumulate all partial text in a string so that onDone can see the full text
    let fullResponse = "";
    let buffer = "";

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    return new ReadableStream<Uint8Array>({
        async start(controller) {
            if (debug) {
                console.debug("[createSSEStream] Beginning to read from SSE stream/reader.");
            }
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        if (debug) {
                            console.debug("[createSSEStream] Reader returned done, ending loop.");
                        }
                        break;
                    }

                    const chunk = decoder.decode(value, { stream: true });
                    buffer += chunk;

                    // Use the plugin's delimiter to split events, e.g. "\n\n"
                    const events = buffer.split(plugin.delimiter ?? "\n\n");
                    // Keep the last incomplete piece in buffer
                    buffer = events.pop() ?? "";

                    if (debug) {
                        console.debug("[createSSEStream] Received chunk:", chunk);
                        console.debug("[createSSEStream] Split into events:", events);
                    }

                    for (const event of events) {
                        const trimmed = event.trim();
                        if (!trimmed) continue;

                        // Each "event" may contain multiple lines
                        const lines = trimmed.split("\n").map((ln) => ln.trim());
                        // Filter out comment lines or empty lines
                        const sseLines = lines.filter((ln) => ln && !ln.startsWith(":"));

                        let eventText = "";
                        for (const sseLine of sseLines) {
                            const parsed = plugin.parseServerSentEvent(sseLine);
                            if (parsed === "[DONE]") {
                                // If we see the done marker, final callback
                                if (handlers.onDone) {
                                    handlers.onDone({
                                        role: "assistant",
                                        content: fullResponse,
                                    });
                                }
                                if (debug) {
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
                            if (debug) {
                                console.debug("[createSSEStream] Emitted partial text:", eventText);
                            }
                        }
                    }
                }

                // If buffer has leftover partial event, handle it
                const leftover = buffer.trim();
                if (leftover) {
                    if (debug) {
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
                            if (debug) {
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
                        if (debug) {
                            console.debug("[createSSEStream] Emitted leftover partial text:", leftoverText);
                        }
                    }
                }

                // Finally, call onDone if not done yet
                if (handlers.onDone) {
                    handlers.onDone({
                        role: "assistant",
                        content: fullResponse,
                    });
                }
                if (debug) {
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
                if (debug) {
                    console.debug("[createSSEStream] Caught error in read loop:", error);
                }
            }
        },
    });
}