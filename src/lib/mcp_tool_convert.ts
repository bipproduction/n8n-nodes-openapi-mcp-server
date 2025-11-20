// mcp_tool_convert.ts
import _ from "lodash";

/**
 * ============================
 *  Types
 * ============================
 */
interface McpTool {
    name: string;
    description: string;
    inputSchema: any;
    "x-props": {
        method: string;
        path: string;
        operationId?: string;
        tag?: string;
        deprecated?: boolean;
        summary?: string;
        parameters?: any[];
    };
}

/**
 * ============================
 *  Public: convertOpenApiToMcpTools
 * ============================
 * Convert OpenAPI 3.x spec → MCP Tools
 * - filterTag : match against operation tags
 */
export function convertOpenApiToMcpTools(openApiJson: any, filterTag: string): McpTool[] {
    const tools: McpTool[] = [];

    if (!openApiJson || typeof openApiJson !== "object") {
        console.warn("Invalid OpenAPI JSON");
        return tools;
    }

    const paths = openApiJson.paths || {};
    if (Object.keys(paths).length === 0) {
        console.warn("No paths found in OpenAPI spec");
        return tools;
    }

    for (const [path, methods] of Object.entries<any>(paths)) {
        if (!methods || typeof methods !== "object") continue;

        for (const [method, operation] of Object.entries<any>(methods)) {
            const valid = ["get", "post", "put", "delete", "patch", "head", "options"];
            if (!valid.includes(method.toLowerCase())) continue;

            if (!operation || typeof operation !== "object") continue;

            const tags = Array.isArray(operation.tags) ? operation.tags : [];

            // Tag filter
            if (
                filterTag &&
                (!tags.length ||
                    !tags.some((t: string) =>
                        t?.toLowerCase().includes(filterTag.toLowerCase())
                    ))
            ) {
                continue;
            }

            try {
                const tool = createToolFromOperation(path, method, operation, tags);
                if (tool) tools.push(tool);
            } catch (err) {
                console.error(`Error building tool for ${method.toUpperCase()} ${path}`, err);
            }
        }
    }

    return tools;
}

/**
 * ============================
 *  Build Tool from Operation
 * ============================
 */
function createToolFromOperation(
    path: string,
    method: string,
    operation: any,
    tags: string[]
): McpTool | null {
    const rawName = _.snakeCase(operation.operationId || `${method}_${path}`) || "unnamed_tool";
    const name = cleanToolName(rawName);

    if (name === "unnamed_tool") {
        console.warn(`Invalid tool name: ${method} ${path}`);
        return null;
    }

    const description =
        operation.description ||
        operation.summary ||
        `Execute ${method.toUpperCase()} ${path}`;

    // Build executor parameter array
    const parameters: any[] = [];

    if (Array.isArray(operation.parameters)) {
        for (const p of operation.parameters) {
            if (!p || typeof p !== "object") continue;

            parameters.push({
                name: p.name,
                in: p.in,
                required: !!p.required,
                description: p.description,
                schema: p.schema || { type: "string" },
            });
        }
    }

    // Synthetic requestBody param
    if (operation.requestBody?.content) {
        const schema = extractPreferredContentSchema(operation.requestBody.content);

        parameters.push({
            name: "body",
            in: "requestBody",
            required: !!operation.requestBody.required,
            schema: schema || { type: "object" },
            description: operation.requestBody.description || "Request body",
        });
    }

    // Build input schema
    let schema: any = null;

    const lower = method.toLowerCase();
    if (["get", "delete", "head"].includes(lower)) {
        schema = extractParametersSchema(operation.parameters || []);
    } else {
        schema = extractRequestBodySchema(operation) ||
                 extractParametersSchema(operation.parameters || []);
    }

    const inputSchema = createInputSchema(schema);

    return {
        name,
        description,
        "x-props": {
            method: method.toUpperCase(),
            path,
            operationId: operation.operationId,
            tag: tags[0],
            deprecated: operation.deprecated || false,
            summary: operation.summary,
            parameters,
        },
        inputSchema,
    };
}

/**
 * ============================
 *  Extract Preferred Content Schema
 * ============================
 */
function extractPreferredContentSchema(content: any): any {
    if (!content) return null;

    const preferred = [
        "application/json",
        "multipart/form-data",
        "application/x-www-form-urlencoded",
        "text/plain",
    ];

    for (const type of preferred) {
        if (content[type]?.schema) return content[type].schema;
    }

    const first = Object.values<any>(content)[0];
    return first?.schema || null;
}

/**
 * ============================
 *  Extract Parameter Schema (GET/DELETE)
 * ============================
 */
function extractParametersSchema(parameters: any[]): any | null {
    if (!parameters.length) return null;

    const properties: any = {};
    const required: string[] = [];

    for (const param of parameters) {
        if (!["path", "query", "header"].includes(param.in)) continue;

        const name = param.name;
        if (!name) continue;

        const schema = param.schema || { type: "string" };

        properties[name] = {
            type: schema.type || "string",
            description: param.description || `${param.in} parameter: ${name}`,
            ...extractSchemaDetails(schema),
        };

        if (param.required) required.push(name);
    }

    if (!Object.keys(properties).length) return null;

    return { type: "object", properties, required };
}

/**
 * ============================
 *  Extract RequestBody Schema
 * ============================
 */
function extractRequestBodySchema(operation: any): any | null {
    return extractPreferredContentSchema(operation?.requestBody?.content);
}

/**
 * ============================
 *  Create MCP Input Schema
 * ============================
 */
function createInputSchema(schema: any): any {
    if (!schema || typeof schema !== "object") {
        return { type: "object", properties: {}, additionalProperties: false };
    }

    const properties: any = {};
    const required: string[] = Array.isArray(schema.required) ? [...schema.required] : [];

    if (schema.properties) {
        for (const [key, prop] of Object.entries<any>(schema.properties)) {
            const cleaned = cleanProperty(prop);
            if (cleaned) properties[key] = cleaned;
        }
    }

    if (schema.type === "array" && schema.items) {
        properties.items = cleanProperty(schema.items) || { type: "string" };
    }

    return {
        type: "object",
        properties,
        required,
        additionalProperties: false,
    };
}

/**
 * ============================
 *  Clean Individual Schema Property
 * ============================
 */
function cleanProperty(prop: any): any | null {
    if (!prop || typeof prop !== "object") return { type: "string" };

    const out: any = { type: prop.type || "string" };

    Object.assign(out, extractSchemaDetails(prop));

    if (prop.properties) {
        out.properties = {};
        for (const [k, v] of Object.entries<any>(prop.properties)) {
            const cleaned = cleanProperty(v);
            if (cleaned) out.properties[k] = cleaned;
        }

        if (Array.isArray(prop.required)) {
            out.required = prop.required.filter((r: any) => typeof r === "string");
        }
    }

    if (prop.items) {
        out.items = cleanProperty(prop.items);
    }

    if (Array.isArray(prop.oneOf)) out.oneOf = prop.oneOf.map(cleanProperty);
    if (Array.isArray(prop.anyOf)) out.anyOf = prop.anyOf.map(cleanProperty);
    if (Array.isArray(prop.allOf)) out.allOf = prop.allOf.map(cleanProperty);

    return out;
}

/**
 * ============================
 *  Extract Allowed Schema Fields
 * ============================
 */
function extractSchemaDetails(schema: any) {
    const allowed = [
        "description",
        "examples",
        "example",
        "default",
        "enum",
        "pattern",
        "minLength",
        "maxLength",
        "minimum",
        "maximum",
        "format",
        "multipleOf",
        "exclusiveMinimum",
        "exclusiveMaximum",
    ];

    const out: any = {};
    for (const f of allowed) {
        if (schema[f] !== undefined) out[f] = schema[f];
    }
    return out;
}

/**
 * ============================
 *  Clean tool name safely
 * ============================
 */
function cleanToolName(value: string): string {
    if (!value) return "unnamed_tool";

    return value
        .replace(/[{}]/g, "")
        .replace(/[^a-zA-Z0-9_]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_|_$/g, "")
        .toLowerCase() || "unnamed_tool";
}

/**
 * ============================
 *  Public: getMcpTools
 * ============================
 */
export async function getMcpTools(url: string, filterTag: string): Promise<McpTool[]> {
    try {
        console.log(`Fetching OpenAPI spec: ${url}`);

        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const json = await res.json();
        const tools = convertOpenApiToMcpTools(json, filterTag);

        console.log(`Generated ${tools.length} MCP tools`);
        return tools;
    } catch (err) {
        console.error("Error fetching MCP Tools:", err);
        throw err;
    }
}
