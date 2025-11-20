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
// - preserves function name loadTools (do not rename)
// - adds TTL, forceRefresh handling, and robust error handling
// ======================================================
async function loadTools(openapiUrl: string, filterTag: string, forceRefresh = false): Promise<any[]> {
    const cacheKey = `${openapiUrl}::${filterTag || ""}`;

    try {
        const cached = toolsCache.get(cacheKey);
        if (!forceRefresh && cached && (Date.now() - cached.timestamp) < TOOLS_CACHE_TTL_MS) {
            return cached.tools;
        }

        console.log(`[MCP] 🔄 Refreshing tools from ${openapiUrl} ...`);
        const fetched = await getMcpTools(openapiUrl, filterTag);

        console.log(`[MCP] ✅ Loaded ${fetched.length} tools`);
        if (fetched.length > 0) {
            console.log(`[MCP] Tools: ${fetched.map((t: any) => t.name).join(", ")}`);
        }

        toolsCache.set(cacheKey, { timestamp: Date.now(), tools: fetched });
        return fetched;
    } catch (err) {
        console.error(`[MCP] Failed to load tools from ${openapiUrl}:`, err);
        // On failure, if cache exists return stale to avoid complete outage
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
// - preserves function name executeTool
// - fixes cookie accumulation, query-array handling, path param safety,
//   requestBody handling based on x.parameters + synthetic body param
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
        // default content-type; may be overridden by header params or request
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };

    // Support multiple cookies: accumulate into array, then join
    const cookies: string[] = [];

    let bodyPayload: any = undefined;

    // x.parameters may have been produced by converter.
    // Expected shape: [{ name, in, schema?, required? }]
    if (Array.isArray(x.parameters)) {
        for (const p of x.parameters) {
            const name = p.name;
            // allow alias e.g. body parameter named "__body" or "body"
            const value = args?.[name];

            // If param not provided, skip (unless required, leave to tool to validate later)
            if (value === undefined) continue;

            try {
                switch (p.in) {
                    case "path":
                        // Safely replace only if placeholder exists
                        if (path.includes(`{${name}}`)) {
                            path = path.replace(new RegExp(`{${name}}`, "g"), encodeURIComponent(String(value)));
                        } else {
                            // If path doesn't contain placeholder, append as query fallback
                            query[name] = value;
                        }
                        break;

                    case "query":
                        // handle array correctly: produce repeated keys for URLSearchParams
                        // Store as-is and handle later when building QS
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
                        // prefer explicit body param; overwrite if multiple present
                        bodyPayload = value;
                        break;

                    default:
                        // unknown param location — put into body as fallback
                        bodyPayload = bodyPayload ?? {};
                        bodyPayload[name] = value;
                        break;
                }
            } catch (err) {
                console.warn(`[MCP] Skipping parameter ${name} due to error:`, err);
            }
        }
    } else {
        // fallback → semua args dianggap body
        bodyPayload = args;
    }

    if (cookies.length > 0) {
        headers["Cookie"] = cookies.join("; ");
    }

    // ======================================================
    // Build Final URL
    // ======================================================
    // Ensure baseUrl doesn't end with duplicate slashes
    const normalizedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    let url = `${normalizedBase}${normalizedPath}`;

    // Build query string with repeated keys if array provided
    const qsParts: string[] = [];
    for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) {
            for (const item of v) {
                qsParts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(item))}`);
            }
        } else if (typeof v === "object") {
            // JSON-encode objects as value
            qsParts.push(`${encodeURIComponent(k)}=${encodeURIComponent(JSON.stringify(v))}`);
        } else {
            qsParts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
        }
    }
    if (qsParts.length) url += `?${qsParts.join("&")}`;

    // ======================================================
    // Build Request Options
    // ======================================================
    const opts: RequestInit & { headers: Record<string, any> } = { method, headers };
    // If content-type is form data, adjust accordingly (converter could mark)
    const contentType = headers["Content-Type"]?.toLowerCase() ?? "";

    if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && bodyPayload !== undefined) {
        // If requestBody is already a FormData-like or flagged in x (converter support),
        // caller could pass a special object { __formdata: true, entries: [...] } — support minimal
        if (bodyPayload && bodyPayload.__formdata === true && Array.isArray(bodyPayload.entries)) {
            const form = new FormData();
            for (const [k, v] of bodyPayload.entries) {
                form.append(k, v);
            }
            // Let fetch set Content-Type with boundary
            delete opts.headers["Content-Type"];
            opts.body = (form as any) as BodyInit;
        } else if (contentType.includes("application/x-www-form-urlencoded")) {
            opts.body = new URLSearchParams(bodyPayload).toString();
        } else {
            // default JSON
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
        headers: res.headers, // keep for diagnostics
    };
}

// ======================================================
// JSON-RPC Handler
// - preserves handleMCPRequest name
// - improved error reporting, robust content conversion, batch safety
// ======================================================
async function handleMCPRequest(
    request: JSONRPCRequest,
    tools: any[]
): Promise<JSONRPCResponse> {
    const { id, method, params, credentials } = request;

    // helper to create consistent error responses with optional debug data
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

            // Converter MCP content yang valid
            function convertToMcpContent(data: any) {
                // String → text
                if (typeof data === "string") {
                    return {
                        type: "text",
                        text: data,
                    };
                }

                // Image (dengan __mcp_type)
                if (data?.__mcp_type === "image" && data.base64) {
                    return {
                        type: "image",
                        data: data.base64,
                        mimeType: data.mimeType || "image/png",
                    };
                }

                // Audio
                if (data?.__mcp_type === "audio" && data.base64) {
                    return {
                        type: "audio",
                        data: data.base64,
                        mimeType: data.mimeType || "audio/mpeg",
                    };
                }

                // Semua lainnya → text (untuk mencegah error Zod union)
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
                // return error with message and minimal debug info (avoid leaking secrets)
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
// - preserves class name OpenapiMcpServer
// - avoids forcing refresh on every webhook call (uses cache by default)
// - safer batch handling (Promise.allSettled) to return array of results
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
            {
                displayName: "Default Filter",
                name: "defaultFilter",
                type: "string",
                default: "",
                placeholder: "mcp | tag",
            },
            {
                displayName: 'Available Tools (auto-refresh)',
                name: 'toolList',
                type: 'options',
                typeOptions: {
                    loadOptionsMethod: 'refreshToolList',
                    refreshOnOpen: true,
                },
                default: 'all',
                description: 'Daftar tools yang berhasil dimuat dari OpenAPI',
            },
        ],
    };

    // ==================================================
    // LoadOptions
    // ==================================================
    methods = {
        loadOptions: {
            async refreshToolList(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
                const openapiUrl = this.getNodeParameter("openapiUrl", 0) as string;
                const filterTag = this.getNodeParameter("defaultFilter", 0) as string;

                if (!openapiUrl) {
                    return [{ name: "❌ No OpenAPI URL provided", value: "" }];
                }

                // force refresh when user opens selector explicitly
                const tools = await loadTools(openapiUrl, filterTag, true);

                return [
                    { name: "All Tools", value: "all" },
                    ...tools.map((t) => ({
                        name: t.name,
                        value: t.name,
                        description: t.description,
                    })),
                ];
            },
        },
    };

    // ==================================================
    // Webhook Handler
    // ==================================================
    async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
        const openapiUrl = this.getNodeParameter("openapiUrl", 0) as string;
        const filterTag = this.getNodeParameter("defaultFilter", 0) as string;

        // Use cached tools by default — non-blocking and faster
        const tools = await loadTools(openapiUrl, filterTag, false);

        const creds = await this.getCredentials("openapiMcpServerCredentials") as {
            baseUrl: string;
            token: string;
        };

        if (!creds || !creds.baseUrl) {
            throw new Error("Missing openapiMcpServerCredentials or baseUrl");
        }

        const body = this.getBodyData();

        // Batch handling: use Promise.allSettled and return array of results
        if (Array.isArray(body)) {
            const promises = body.map((r) =>
                handleMCPRequest({ ...r, credentials: creds }, tools)
            );
            const settled = await Promise.allSettled(promises);

            // Normalize to either results or errors in MCP shape
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
