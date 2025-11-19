import _ from "lodash";

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
    };
}

/**
 * Convert OpenAPI 3.x JSON spec into MCP-compatible tool definitions.
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

    for (const [path, methods] of Object.entries(paths)) {
        if (!path || typeof path !== "string") continue;

        if (!methods || typeof methods !== "object") continue;

        for (const [method, operation] of Object.entries<any>(methods)) {
            const validMethods = ["get", "post", "put", "delete", "patch", "head", "options"];
            if (!validMethods.includes(method.toLowerCase())) continue;

            if (!operation || typeof operation !== "object") continue;

            const tags: string[] = Array.isArray(operation.tags) ? operation.tags : [];

            if (!tags.length || !tags.some(t => 
                typeof t === "string" && t.toLowerCase().includes(filterTag)
            )) continue;

            try {
                const tool = createToolFromOperation(path, method, operation, tags);
                if (tool) {
                    tools.push(tool);
                }
            } catch (error) {
                console.error(`Error creating tool for ${method.toUpperCase()} ${path}:`, error);
                continue;
            }
        }
    }

    return tools;
}

/**
 * Buat MCP tool dari operation OpenAPI
 */
function createToolFromOperation(
    path: string,
    method: string,
    operation: any,
    tags: string[]
): McpTool | null {
    try {
        const rawName = _.snakeCase(`${method}_${operation.operationId}` || `${method}_${path}`) || "unnamed_tool";
        const name = cleanToolName(rawName);

        if (!name || name === "unnamed_tool") {
            console.warn(`Invalid tool name for ${method} ${path}`);
            return null;
        }

        const description =
            operation.description ||
            operation.summary ||
            `Execute ${method.toUpperCase()} ${path}`;

        // ✅ Extract schema berdasarkan method
        let schema;
        if (method.toLowerCase() === "get") {
            // ✅ Untuk GET, ambil dari parameters (query/path)
            schema = extractParametersSchema(operation.parameters || []);
        } else {
            // ✅ Untuk POST/PUT/etc, ambil dari requestBody
            schema = extractRequestBodySchema(operation);
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
            },
            inputSchema,
        };
    } catch (error) {
        console.error(`Failed to create tool from operation:`, error);
        return null;
    }
}

/**
 * Extract schema dari parameters (untuk GET requests)
 */
function extractParametersSchema(parameters: any[]): any {
    if (!Array.isArray(parameters) || parameters.length === 0) {
        return null;
    }

    const properties: any = {};
    const required: string[] = [];

    for (const param of parameters) {
        if (!param || typeof param !== "object") continue;

        // ✅ Support path, query, dan header parameters
        if (["path", "query", "header"].includes(param.in)) {
            const paramName = param.name;
            if (!paramName || typeof paramName !== "string") continue;

            properties[paramName] = {
                type: param.schema?.type || "string",
                description: param.description || `${param.in} parameter: ${paramName}`,
            };

            // ✅ Copy field tambahan dari schema
            if (param.schema) {
                const allowedFields = ["examples", "example", "default", "enum", "pattern", "minLength", "maxLength", "minimum", "maximum", "format"];
                for (const field of allowedFields) {
                    if (param.schema[field] !== undefined) {
                        properties[paramName][field] = param.schema[field];
                    }
                }
            }

            if (param.required === true) {
                required.push(paramName);
            }
        }
    }

    if (Object.keys(properties).length === 0) {
        return null;
    }

    return {
        type: "object",
        properties,
        required,
    };
}

/**
 * Extract schema dari requestBody (untuk POST/PUT/etc requests)
 */
function extractRequestBodySchema(operation: any): any {
    if (!operation.requestBody?.content) {
        return null;
    }

    const content = operation.requestBody.content;

    const contentTypes = [
        "application/json",
        "multipart/form-data",
        "application/x-www-form-urlencoded",
        "text/plain",
    ];

    for (const contentType of contentTypes) {
        if (content[contentType]?.schema) {
            return content[contentType].schema;
        }
    }

    for (const [_, value] of Object.entries<any>(content)) {
        if (value?.schema) {
            return value.schema;
        }
    }

    return null;
}

/**
 * Buat input schema yang valid untuk MCP
 */
function createInputSchema(schema: any): any {
    const defaultSchema = {
        type: "object",
        properties: {},
        additionalProperties: false,
    };

    if (!schema || typeof schema !== "object") {
        return defaultSchema;
    }

    try {
        const properties: any = {};
        const required: string[] = [];
        const originalRequired = Array.isArray(schema.required) ? schema.required : [];

        if (schema.properties && typeof schema.properties === "object") {
            for (const [key, prop] of Object.entries<any>(schema.properties)) {
                if (!key || typeof key !== "string") continue;

                try {
                    const cleanProp = cleanProperty(prop);
                    if (cleanProp) {
                        properties[key] = cleanProp;

                        // ✅ PERBAIKAN: Check optional flag dengan benar
                        const isOptional = prop?.optional === true || prop?.optional === "true";
                        const isInRequired = originalRequired.includes(key);
                        
                        // ✅ Hanya masukkan ke required jika memang required DAN bukan optional
                        if (isInRequired && !isOptional) {
                            required.push(key);
                        }
                    }
                } catch (error) {
                    console.error(`Error cleaning property ${key}:`, error);
                    continue;
                }
            }
        }

        return {
            type: "object",
            properties,
            required,
            additionalProperties: false,
        };
    } catch (error) {
        console.error("Error creating input schema:", error);
        return defaultSchema;
    }
}

/**
 * Bersihkan property dari field custom
 */
function cleanProperty(prop: any): any | null {
    if (!prop || typeof prop !== "object") {
        return { type: "string" };
    }

    try {
        const cleaned: any = {
            type: prop.type || "string",
        };

        const allowedFields = [
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

        for (const field of allowedFields) {
            if (prop[field] !== undefined && prop[field] !== null) {
                cleaned[field] = prop[field];
            }
        }

        if (prop.properties && typeof prop.properties === "object") {
            cleaned.properties = {};
            for (const [key, value] of Object.entries(prop.properties)) {
                const cleanedNested = cleanProperty(value);
                if (cleanedNested) {
                    cleaned.properties[key] = cleanedNested;
                }
            }
            
            if (Array.isArray(prop.required)) {
                cleaned.required = prop.required.filter((r: any) => typeof r === "string");
            }
        }

        if (prop.items) {
            cleaned.items = cleanProperty(prop.items);
        }

        if (Array.isArray(prop.oneOf)) {
            cleaned.oneOf = prop.oneOf.map(cleanProperty).filter(Boolean);
        }
        if (Array.isArray(prop.anyOf)) {
            cleaned.anyOf = prop.anyOf.map(cleanProperty).filter(Boolean);
        }
        if (Array.isArray(prop.allOf)) {
            cleaned.allOf = prop.allOf.map(cleanProperty).filter(Boolean);
        }

        return cleaned;
    } catch (error) {
        console.error("Error cleaning property:", error);
        return null;
    }
}

/**
 * Bersihkan nama tool
 */
function cleanToolName(name: string): string {
    if (!name || typeof name !== "string") {
        return "unnamed_tool";
    }

    try {
        return name
            .replace(/[{}]/g, "")
            .replace(/[^a-zA-Z0-9_]/g, "_")
            .replace(/_+/g, "_")
            .replace(/^_|_$/g, "")
            .replace(/^(get|post|put|delete|patch|api)_/i, "")
            .replace(/^(get_|post_|put_|delete_|patch_|api_)+/gi, "")
            .replace(/(^_|_$)/g, "")
            || "unnamed_tool";
    } catch (error) {
        console.error("Error cleaning tool name:", error);
        return "unnamed_tool";
    }
}

/**
 * Ambil OpenAPI JSON dari endpoint dan konversi ke tools MCP
 */
export async function getMcpTools(url: string, filterTag: string): Promise<McpTool[]> {
    try {
        
        console.log(`Fetching OpenAPI spec from: ${url}`);

        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const openApiJson = await response.json();
        const tools = convertOpenApiToMcpTools(openApiJson, filterTag);
        
        console.log(`✅ Successfully generated ${tools.length} MCP tools`);
        
        return tools;
    } catch (error) {
        console.error("Error fetching MCP tools:", error);
        throw error;
    }
}

