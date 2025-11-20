// OpenapiMcpServer.ts
import {
    INodeType,
    INodeTypeDescription,
    IWebhookFunctions,
    IWebhookResponseData,
    ILoadOptionsFunctions,
    INodePropertyOptions,
} from 'n8n-workflow';
import { getMcpTools } from "../lib/mcp_tool_convert";

// ======================================================
// Cache tools per URL (with TTL & safe structure)
// ======================================================
type CachedTools = { timestamp: number; tools: any[] };
const TOOLS_CACHE_TTL_MS = 5 * 60_000; // 5 minutes
const toolsCache = new Map<string, CachedTools>();

// ======================================================
// Load OpenAPI → MCP Tools
// (preserves original function name loadTools)
// NOTE: filterTag now supports string | string[] (multi-select)
// ======================================================
async function loadTools(openapiUrl: string, filterTag: string | string[] = "", forceRefresh = false): Promise<any[]> {
    const normalizedFilterKey = Array.isArray(filterTag) ? filterTag.join("|") : (filterTag ?? "");
    const cacheKey = `${openapiUrl}::${normalizedFilterKey}`;

    try {
        const cached = toolsCache.get(cacheKey);
        if (!forceRefresh && cached && (Date.now() - cached.timestamp) < TOOLS_CACHE_TTL_MS) {
            return cached.tools;
        }

        console.log(`[MCP] 🔄 Refreshing tools from ${openapiUrl} with filter '${normalizedFilterKey}' ...`);
        // Pass through filterTag in original shape (string | string[]) to getMcpTools.
        const fetched = await getMcpTools(openapiUrl, filterTag as any);

        console.log(`[MCP] ✅ Loaded ${fetched.length} tools`);
        if (fetched.length > 0) {
            console.log(`[MCP] Tools: ${fetched.map((t: any) => t.name).join(", ")}`);
        }

        toolsCache.set(cacheKey, { timestamp: Date.now(), tools: fetched });
        return fetched;
    } catch (err) {
        console.error(`[MCP] Failed to load tools from ${openapiUrl}:`, err);
        const stale = toolsCache.get(cacheKey);
        if (stale) {
            console.warn(`[MCP] Returning stale cached tools for ${cacheKey}`);
            return stale.tools;
        }
        throw err;
    }
}

// ======================================================
// JSON-RPC Types
// ======================================================
type JSONRPCRequest = {
    jsonrpc: "2.0";
    id: string | number;
    method: string;
    params?: any;
    credentials?: any;
};

type JSONRPCResponse = {
    jsonrpc: "2.0";
    id: string | number;
    result?: any;
    error?: { code: number; message: string; data?: any };
};

// ======================================================
// EXECUTE TOOL — SUPPORT PATH, QUERY, HEADER, BODY, COOKIE
// (preserves function name executeTool)
// ======================================================
async function executeTool(
    tool: any,
    args: Record<string, any> = {},
    baseUrl: string,
    token?: string
) {
    const x = tool["x-props"] || {};
    const method = (x.method || "GET").toUpperCase();
    let path = x.path || `/${tool.name}`;

    if (!baseUrl) {
        throw new Error("Missing baseUrl in credentials");
    }

    const query: Record<string, any> = {};
    const headers: Record<string, any> = {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };

    const cookies: string[] = [];
    let bodyPayload: any = undefined;

    if (Array.isArray(x.parameters)) {
        for (const p of x.parameters) {
            const name = p.name;
            const value = args?.[name];
            if (value === undefined) continue;

            try {
                switch (p.in) {
                    case "path":
                        if (path.includes(`{${name}}`)) {
                            path = path.replace(new RegExp(`{${name}}`, "g"), encodeURIComponent(String(value)));
                        } else {
                            query[name] = value;
                        }
                        break;
                    case "query":
                        query[name] = value;
                        break;
                    case "header":
                        headers[name] = value;
                        break;
                    case "cookie":
                        cookies.push(`${name}=${value}`);
                        break;
                    case "body":
                    case "requestBody":
                        bodyPayload = value;
                        break;
                    default:
                        bodyPayload = bodyPayload ?? {};
                        bodyPayload[name] = value;
                        break;
                }
            } catch (err) {
                console.warn(`[MCP] Skipping parameter ${name} due to error:`, err);
            }
        }
    } else {
        bodyPayload = args;
    }

    if (cookies.length > 0) {
        headers["Cookie"] = cookies.join("; ");
    }

    const normalizedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    let url = `${normalizedBase}${normalizedPath}`;

    const qsParts: string[] = [];
    for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) {
            for (const item of v) {
                qsParts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(item))}`);
            }
        } else if (typeof v === "object") {
            qsParts.push(`${encodeURIComponent(k)}=${encodeURIComponent(JSON.stringify(v))}`);
        } else {
            qsParts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
        }
    }
    if (qsParts.length) url += `?${qsParts.join("&")}`;

    const opts: RequestInit & { headers: Record<string, any> } = { method, headers };

    const contentType = headers["Content-Type"]?.toLowerCase() ?? "";
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && bodyPayload !== undefined) {
        if (bodyPayload && bodyPayload.__formdata === true && Array.isArray(bodyPayload.entries)) {
            const form = new FormData();
            for (const [k, v] of bodyPayload.entries) {
                form.append(k, v);
            }
            delete opts.headers["Content-Type"];
            opts.body = (form as any) as BodyInit;
        } else if (contentType.includes("application/x-www-form-urlencoded")) {
            opts.body = new URLSearchParams(bodyPayload).toString();
        } else {
            opts.body = JSON.stringify(bodyPayload);
        }
    }

    console.log(`[MCP] → Calling ${method} ${url}`);

    const res = await fetch(url, opts);
    const resContentType = (res.headers.get("content-type") || "").toLowerCase();

    const data = resContentType.includes("application/json")
        ? await res.json()
        : await res.text();

    return {
        success: res.ok,
        status: res.status,
        method,
        url,
        path,
        data,
        headers: res.headers,
    };
}

// ======================================================
// JSON-RPC Handler
// (preserves function name handleMCPRequest)
// ======================================================
async function handleMCPRequest(
    request: JSONRPCRequest,
    tools: any[]
): Promise<JSONRPCResponse> {
    const { id, method, params, credentials } = request;

    const makeError = (code: number, message: string, data?: any) => ({
        jsonrpc: "2.0",
        id,
        error: { code, message, data },
    });

    switch (method) {
        case "initialize":
            return {
                jsonrpc: "2.0",
                id,
                result: {
                    protocolVersion: "2024-11-05",
                    capabilities: { tools: {} },
                    serverInfo: { name: "n8n-mcp-server", version: "1.0.0" },
                },
            };

        case "tools/list":
            return {
                jsonrpc: "2.0",
                id,
                result: {
                    tools: tools.map((t) => {
                        const inputSchema =
                            typeof t.inputSchema === "object" && t.inputSchema?.type === "object"
                                ? t.inputSchema
                                : {
                                    type: "object",
                                    properties: {},
                                    required: [],
                                };

                        return {
                            name: t.name,
                            description: t.description || "No description provided",
                            inputSchema,
                            "x-props": t["x-props"],
                        };
                    }),
                },
            };

        case "tools/call": {
            const toolName = params?.name;
            const tool = tools.find((t) => t.name === toolName);

            if (!tool) {
                return makeError(-32601, `Tool '${toolName}' not found`) as JSONRPCResponse;
            }

            function convertToMcpContent(data: any) {
                if (typeof data === "string") {
                    return {
                        type: "text",
                        text: data,
                    };
                }
                if (data?.__mcp_type === "image" && data.base64) {
                    return {
                        type: "image",
                        data: data.base64,
                        mimeType: data.mimeType || "image/png",
                    };
                }
                if (data?.__mcp_type === "audio" && data.base64) {
                    return {
                        type: "audio",
                        data: data.base64,
                        mimeType: data.mimeType || "audio/mpeg",
                    };
                }

                return {
                    type: "text",
                    text: (() => {
                        try {
                            return JSON.stringify(data, null, 2);
                        } catch {
                            return String(data);
                        }
                    })(),
                };
            }

            try {
                const baseUrl = credentials?.baseUrl;
                const token = credentials?.token;

                const result = await executeTool(
                    tool,
                    params?.arguments || {},
                    baseUrl,
                    token
                );

                const raw = result.data?.data ?? result.data;

                return {
                    jsonrpc: "2.0",
                    id,
                    result: {
                        content: [convertToMcpContent(raw)],
                    },
                };
            } catch (err: any) {
                const debug = { message: err?.message, stack: err?.stack?.split("\n").slice(0, 5) };

                return makeError(-32603, err?.message || "Internal error", debug) as JSONRPCResponse;
            }
        }

        case "ping":
            return { jsonrpc: "2.0", id, result: {} };

        default:
            return makeError(-32601, `Method '${method}' not found`) as JSONRPCResponse;
    }
}

// ======================================================
// MCP TRIGGER NODE
// (preserves class name OpenapiMcpServer)
// ======================================================
export class OpenapiMcpServer implements INodeType {
    description: INodeTypeDescription = {
        displayName: 'OpenAPI MCP Server',
        name: 'openapiMcpServer',
        group: ['trigger'],
        version: 1,
        description: 'Runs an MCP Server inside n8n',
        icon: 'file:icon.svg',
        defaults: { name: 'OpenAPI MCP Server' },
        credentials: [
            { name: "openapiMcpServerCredentials", required: true },
        ],
        inputs: [],
        outputs: ['main'],
        webhooks: [
            {
                name: 'default',
                httpMethod: 'POST',
                responseMode: 'onReceived',
                path: '={{$parameter["path"]}}',
            },
        ],
        properties: [
            {
                displayName: "Path",
                name: "path",
                type: "string",
                default: "mcp",
            },
            {
                displayName: "OpenAPI URL",
                name: "openapiUrl",
                type: "string",
                default: "",
                placeholder: "https://example.com/openapi.json",
            },

            // ======================================================
            // ⬇⬇⬇ UPDATED: Default Filter sekarang multi-select (multiOptions)
            // ======================================================
            {
                displayName: 'Default Filter',
                name: 'defaultFilter',
                type: 'multiOptions', // <-- multi-select
                typeOptions: {
                    loadOptionsMethod: 'loadAvailableTags',
                    refreshOnOpen: true,
                },
                default: [], // empty means no tag filtering (or 'All' in loader)
                description: 'Filter berdasarkan tag dari OpenAPI (multi-select supported)',
            },
            // ======================================================

            {
                displayName: 'Available Tools (auto-refresh)',
                name: 'toolList',
                type: 'options',
                typeOptions: {
                    loadOptionsMethod: 'refreshToolList',
                    refreshOnOpen: true,
                },
                default: 'all',
                description: 'Daftar tools yang berhasil dimuat dari OpenAPI (tergantung Default Filter)',
            },
        ],
    };

    // ==================================================
    // LoadOptions
    // ==================================================
    methods = {
        loadOptions: {
            // ========================================================
            // ⬇⬇⬇ NEW: dropdown tag loader (unchanged)
            // ========================================================
            async loadAvailableTags(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
                const openapiUrl = this.getNodeParameter("openapiUrl", 0) as string;

                if (!openapiUrl) {
                    return [{ name: "❌ No OpenAPI URL provided", value: "all" }];
                }

                try {
                    const res = await fetch(openapiUrl);
                    const json = await res.json();

                    const tags: string[] =
                        json?.tags?.map((t: any) => t.name) ??
                        Object.values(json.paths || {})
                            .flatMap((p: any) =>
                                Object.values(p).flatMap((m: any) => m.tags || [])
                            );

                    const unique = Array.from(new Set(tags));

                    // include an "All" option; users can still select none (empty array) which we'll treat as "all"
                    return [
                        { name: "All", value: "all" },
                        ...unique.map((t) => ({
                            name: t,
                            value: t,
                        })),
                    ];
                } catch (err) {
                    console.error("Failed loading tags:", err);
                    return [{ name: "All", value: "all" }];
                }
            },
            // ========================================================

            // ========================================================
            // ⬇⬇⬇ UPDATED: refreshToolList now reads multi-select defaultFilter (string | string[])
            // ========================================================
            async refreshToolList(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
                const openapiUrl = this.getNodeParameter("openapiUrl", 0) as string;
                const filterTag = this.getNodeParameter("defaultFilter", 0) as string | string[]; // may be array

                if (!openapiUrl) {
                    return [{ name: "❌ No OpenAPI URL provided", value: "" }];
                }

                // Pass the filterTag in its native shape to loadTools
                const tools = await loadTools(openapiUrl, filterTag as any, true);

                return [
                    { name: "All Tools", value: "all" },
                    ...tools.map((t) => ({
                        name: t.name,
                        value: t.name,
                        description: t.description,
                    })),
                ];
            },
            // ========================================================
        },
    };

    // ==================================================
    // Webhook Handler
    // ==================================================
    async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
        const openapiUrl = this.getNodeParameter("openapiUrl", 0) as string;
        const filterTag = this.getNodeParameter("defaultFilter", 0) as string | string[]; // multi-select support

        const tools = await loadTools(openapiUrl, filterTag as any, false);

        const creds = await this.getCredentials("openapiMcpServerCredentials") as {
            baseUrl: string;
            token: string;
        };

        if (!creds || !creds.baseUrl) {
            throw new Error("Missing openapiMcpServerCredentials or baseUrl");
        }

        const body = this.getBodyData();

        if (Array.isArray(body)) {
            const promises = body.map((r) =>
                handleMCPRequest({ ...r, credentials: creds }, tools)
            );
            const settled = await Promise.allSettled(promises);

            const responses = settled.map((s) => {
                if (s.status === "fulfilled") return s.value;
                return {
                    jsonrpc: "2.0",
                    id: "error",
                    error: {
                        code: -32000,
                        message: "Unhandled handler error",
                        data: s.reason?.message ?? String(s.reason),
                    },
                } as JSONRPCResponse;
            });

            return {
                webhookResponse: responses,
            };
        }

        const single = await handleMCPRequest(
            { ...(body as JSONRPCRequest), credentials: creds },
            tools
        );

        return {
            webhookResponse: single,
        };
    }
}
