import { describe, expect, it } from "vitest";
import type { SecretStore } from "turno-core/secrets";
import { chatCompletionsModel, resolveModel, samplingModel } from "../src/act-model.js";
import { Redactor } from "../src/redact.js";

/** The model adapters, with a fake fetch and an in-memory secret store: no network, no real key. */

const KEY = "test-model-key-0123456789";

function memoryStore(items: Record<string, string>): SecretStore & { reads: string[] } {
  const reads: string[] = [];
  return {
    kind: "keychain",
    label: "memory",
    reads,
    async get(service) {
      reads.push(service);
      return items[service];
    },
    async has(service) {
      return service in items;
    },
    async set() {
      throw new Error("read only");
    },
    async remove() {
      return false;
    },
  };
}

function fakeFetch(answer: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return answer(String(url), init ?? {});
  }) as typeof fetch;
  return { fetch: f, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("chatCompletionsModel", () => {
  it("posts a chat completions request with the key as a bearer token, and reads the reply and usage", async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({
        choices: [{ message: { content: '{"done": true}' } }],
        usage: { prompt_tokens: 120, completion_tokens: 8 },
      }),
    );
    const model = chatCompletionsModel({ endpoint: "https://models.example.com/v1/", model: "m-1", key: KEY, fetch });
    expect(model.label).toBe("chat-completions m-1 at models.example.com");
    const reply = await model.complete({ system: "sys", messages: [{ role: "user", text: "hi" }], maxTokens: 50 });
    expect(reply).toEqual({ text: '{"done": true}', usage: { input: 120, output: 8 } });
    expect(calls[0]!.url).toBe("https://models.example.com/v1/chat/completions");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      model: "m-1",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      max_tokens: 50,
      temperature: 0,
    });
  });

  it("sends no authorization header without a key (a local model server)", async () => {
    const { fetch, calls } = fakeFetch(() => json({ choices: [{ message: { content: "ok" } }] }));
    await chatCompletionsModel({ endpoint: "http://127.0.0.1:9/v1", model: "m", fetch }).complete({
      system: "s",
      messages: [],
      maxTokens: 1,
    });
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("says what went wrong in a line", async () => {
    const failing = fakeFetch(() => new Response("quota exceeded", { status: 429 }));
    await expect(
      chatCompletionsModel({ endpoint: "https://m.example.com", model: "m", fetch: failing.fetch }).complete({
        system: "s",
        messages: [],
        maxTokens: 1,
      }),
    ).rejects.toThrow("m.example.com answered 429: quota exceeded");
    const empty = fakeFetch(() => json({ choices: [] }));
    await expect(
      chatCompletionsModel({ endpoint: "https://m.example.com", model: "m", fetch: empty.fetch }).complete({
        system: "s",
        messages: [],
        maxTokens: 1,
      }),
    ).rejects.toThrow("answered without a message");
  });
});

describe("samplingModel", () => {
  it("asks the client through MCP sampling with the system prompt and the budget", async () => {
    const seen: unknown[] = [];
    const model = samplingModel(async (request) => {
      seen.push(request);
      return { text: "reply", model: "client-model" };
    });
    expect(await model.complete({ system: "sys", messages: [{ role: "user", text: "q" }], maxTokens: 9 })).toEqual({
      text: "reply",
    });
    expect(seen).toEqual([
      { systemPrompt: "sys", messages: [{ role: "user", content: { type: "text", text: "q" } }], maxTokens: 9 },
    ]);
  });
});

describe("resolveModel", () => {
  const settings = {
    provider: "chat-completions" as const,
    endpoint: "https://models.example.com/v1",
    model: "m",
    key: "keychain:act-model",
  };
  const sample = async () => ({ text: "x" });

  it("prefers MCP sampling when the client offers it, unless sampling is false", async () => {
    const store = memoryStore({ "act-model": KEY });
    const env = {};
    const redactor = new Redactor();
    expect((await resolveModel({ settings, sample, store, env, redactor, id: "a" })).label).toMatch(/MCP sampling/);
    expect(store.reads).toEqual([]);
    const provider = await resolveModel({
      settings: { ...settings, sampling: false },
      sample,
      store,
      env,
      redactor,
      id: "a",
    });
    expect(provider.label).toBe("chat-completions m at models.example.com");
    expect(store.reads).toEqual(["act-model"]);
  });

  it("reads the key from the secret store and hides it from every later text", async () => {
    const redactor = new Redactor();
    const { fetch } = fakeFetch(() => new Response(`invalid key ${KEY}`, { status: 401 }));
    const model = await resolveModel({
      settings,
      store: memoryStore({ "act-model": KEY }),
      env: {},
      redactor,
      fetch,
      id: "a",
    });
    const error = await model.complete({ system: "s", messages: [], maxTokens: 1 }).catch((e: Error) => e.message);
    expect(redactor.text(String(error))).not.toContain(KEY);
    expect(redactor.text(String(error))).toContain("[vault: act model key]");
  });

  it("says what to set when nothing can answer", async () => {
    const base = { env: {}, redactor: new Redactor(), id: "work" };
    await expect(resolveModel({ ...base, settings: {} })).rejects.toThrow(
      /does not offer MCP sampling and identity "work" names no provider: set one with turno identity set browser:work --act-provider/,
    );
    await expect(resolveModel({ ...base, settings, store: memoryStore({}) })).rejects.toThrow(
      'the secret store has no item "act-model" for act.key (store it with: turno secret set act-model)',
    );
  });
});
