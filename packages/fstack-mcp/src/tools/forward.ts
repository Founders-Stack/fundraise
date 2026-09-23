import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ApiError, FS_API_URL } from "../client.js";

/** Runs an API call and wraps the JSON (or a structured error) as an MCP tool result. */
export async function forward(call: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const data = await call();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (err) {
    const message =
      err instanceof ApiError
        ? JSON.stringify({ error: "api_error", status: err.status, body: err.body })
        : JSON.stringify({ error: "network_error", apiUrl: FS_API_URL, message: String(err) });
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}
