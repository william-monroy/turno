/** Minimal JSON-RPC shapes for relaying; validation stays with the endpoints. */
export type Id = string | number;

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface Message {
  jsonrpc: "2.0";
  id?: Id | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: RpcError;
}

export type Outcome = { result: Record<string, unknown> } | { error: RpcError };

export const isRequest = (m: Message): boolean => typeof m.method === "string" && m.id !== undefined && m.id !== null;
export const isNotification = (m: Message): boolean => typeof m.method === "string" && (m.id === undefined || m.id === null);
export const isResponse = (m: Message): boolean => m.method === undefined && m.id !== undefined && ("result" in m || "error" in m);

export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  Internal: -32603,
  /** Server-defined: the upstream could not be started or is unavailable. */
  Unavailable: -32002,
  /** Server-defined: an exclusive server is held by another session. */
  Busy: -32003,
  /** Server-defined: a server-to-client request could not be tied to one client session. */
  Ambiguous: -32004,
  /** Same code the SDK uses for a request that ran out of time. */
  RequestTimeout: -32001,
  /** The request was cancelled (by the client, or because the client went away). */
  RequestCancelled: -32800,
} as const;

export function toResponse(id: Id, outcome: Outcome): Message {
  return "error" in outcome ? { jsonrpc: "2.0", id, error: outcome.error } : { jsonrpc: "2.0", id, result: outcome.result };
}

export function rpcError(code: number, message: string, data?: unknown): Outcome {
  return { error: data === undefined ? { code, message } : { code, message, data } };
}
