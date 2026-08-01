export type ImportedEnvironmentVariable = {
  key: string;
  type: "plain_text" | "secret" | "boolean" | "number";
  value?: string;
  promptOnInstallation: boolean;
  required: boolean;
  description?: string;
};

export type ImportedHeader = {
  fieldName?: string;
  headerName: string;
  promptOnInstallation: boolean;
  required: boolean;
  value?: string;
  description?: string;
  includeBearerPrefix?: boolean;
  sensitive?: boolean;
};

export type McpConfigImportCandidate = {
  name: string;
  label?: string;
  description?: string;
  serverType: "local" | "remote";
  command?: string;
  arguments: string[];
  environment: ImportedEnvironmentVariable[];
  transportType?: "stdio" | "streamable-http";
  serverUrl?: string;
  additionalHeaders: ImportedHeader[];
  warnings: string[];
};

/**
 * Parses the Arguments form field. Existing newline-separated input remains
 * supported, while JSON arrays can be pasted directly from MCP catalogs.
 */
export function parseMcpArgumentsInput(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];

  if (!trimmed.startsWith("[")) {
    return trimmed
      .split("\n")
      .map((argument) => argument.trim())
      .filter(Boolean);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("Arguments must be a valid JSON array or one per line.");
  }

  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => typeof item !== "string")
  ) {
    throw new Error("Arguments JSON must be an array of strings.");
  }

  return parsed;
}

/**
 * Parses copy-pasted MCP client configuration without executing it. Supported
 * wrappers include Claude/Cursor (`mcpServers`), VS Code (`servers`), nested
 * VS Code settings, a map keyed by server name, a direct server object, and an
 * Archestra registry object with a `server` block.
 */
export function parseMcpConfigJson(input: string): McpConfigImportCandidate[] {
  const parsed = parseJson(input);
  const entries = extractServerEntries(parsed);

  return entries.map((entry) => parseServerEntry(entry));
}

type JsonObject = Record<string, unknown>;

type InputDefinition = {
  id: string;
  description?: string;
  defaultValue?: string | number | boolean;
  required: boolean;
  sensitive: boolean;
};

type ServerEntry = {
  name: string;
  label?: string;
  config: JsonObject;
  inputs: Map<string, InputDefinition>;
  userConfig: Map<string, InputDefinition>;
  warnings?: string[];
};

type Placeholder = InputDefinition & {
  reference: string;
};

function parseJson(input: string): JsonObject {
  const trimmed = stripCodeFence(input.trim());
  if (!trimmed) {
    throw new Error("Paste an MCP server JSON configuration.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("The MCP configuration must be valid JSON.");
  }

  if (!isObject(parsed)) {
    throw new Error("The MCP configuration must be a JSON object.");
  }

  return parsed;
}

function stripCodeFence(input: string): string {
  const match = input.match(/^```(?:json|jsonc)?\s*\n([\s\S]*?)\n```$/i);
  return match?.[1]?.trim() ?? input;
}

function extractServerEntries(root: JsonObject): ServerEntry[] {
  const inputs = parseInputDefinitions(root.inputs);
  const userConfig = parseUserConfigDefinitions(root.user_config);

  const officialRegistryEntries = extractOfficialRegistryEntries(root);
  if (officialRegistryEntries.length > 0) return officialRegistryEntries;

  if (isObject(root.server) && isServerConfig(root.server)) {
    return [
      {
        name: getServerName(root, root.server, "Imported MCP server"),
        config: root.server,
        inputs,
        userConfig,
      },
    ];
  }

  const container = findServerContainer(root);
  if (container) {
    return entriesFromNamedContainer(container, inputs, userConfig);
  }

  if (isServerConfig(root)) {
    return [
      {
        name: getServerName(root, root, "Imported MCP server"),
        config: root,
        inputs,
        userConfig,
      },
    ];
  }

  const namedEntries = Object.fromEntries(
    Object.entries(root).filter(([, value]) =>
      isObject(value) ? isServerConfig(value) : false,
    ),
  );
  if (Object.keys(namedEntries).length > 0) {
    return entriesFromNamedContainer(namedEntries, inputs, userConfig);
  }

  throw new Error(
    "No MCP server was found. Expected command, url, mcpServers, or servers.",
  );
}

function extractOfficialRegistryEntries(root: JsonObject): ServerEntry[] {
  const packages = Array.isArray(root.packages) ? root.packages : [];
  const remotes = Array.isArray(root.remotes) ? root.remotes : [];
  if (packages.length === 0 && remotes.length === 0) return [];

  const name =
    getOptionalString(root, "title") ??
    getOptionalString(root, "name") ??
    "Imported MCP server";
  const description = getOptionalString(root, "description");
  const entries: ServerEntry[] = [];

  for (const [index, value] of remotes.entries()) {
    if (!isObject(value)) continue;
    const url = getOptionalString(value, "url");
    if (!url) continue;
    const transportType =
      getOptionalString(value, "type") ??
      getOptionalString(value, "transportType") ??
      "streamable-http";
    const headerConfig = normalizeOfficialVariables(value.headers);

    entries.push({
      name,
      label: `${name} — remote ${transportType}${remotes.length > 1 ? ` ${index + 1}` : ""}`,
      config: {
        type: transportType,
        url,
        description,
        headers: headerConfig.values,
      },
      inputs: headerConfig.definitions,
      userConfig: new Map(),
      warnings: headerConfig.warnings,
    });
  }

  for (const [index, value] of packages.entries()) {
    if (!isObject(value)) continue;
    const normalized = normalizeOfficialPackage({
      root,
      packageConfig: value,
      name,
      description,
      index,
      packageCount: packages.length,
    });
    if (normalized) entries.push(normalized);
  }

  if (entries.length === 0) {
    throw new Error(
      "The official MCP registry entry has no supported remote or package configuration.",
    );
  }

  return entries;
}

function normalizeOfficialPackage(params: {
  root: JsonObject;
  packageConfig: JsonObject;
  name: string;
  description?: string;
  index: number;
  packageCount: number;
}): ServerEntry | null {
  const { root, packageConfig, name, description, index, packageCount } =
    params;
  const registryType = (
    getOptionalString(packageConfig, "registryType") ??
    getOptionalString(root, "registryType") ??
    ""
  ).toLowerCase();
  const identifier = getOptionalString(packageConfig, "identifier");
  if (!registryType || !identifier) return null;

  const version = getOptionalString(packageConfig, "version");
  const runtimeHint = getOptionalString(packageConfig, "runtimeHint");
  const warnings: string[] = [];
  const runtimeArguments = flattenOfficialArguments(
    packageConfig.runtimeArguments,
    warnings,
  );
  const packageArguments = flattenOfficialArguments(
    packageConfig.packageArguments,
    warnings,
  );
  const environment = normalizeOfficialVariables(
    packageConfig.environmentVariables ?? packageConfig.environment_variables,
  );
  warnings.push(...environment.warnings);

  let command: string;
  let args: string[];
  switch (registryType) {
    case "npm":
      command = runtimeHint ?? "npx";
      args = [
        ...runtimeArguments,
        "-y",
        version ? `${identifier}@${version}` : identifier,
        ...packageArguments,
      ];
      break;
    case "pypi":
      command = runtimeHint ?? "uvx";
      args = [
        ...runtimeArguments,
        version ? `${identifier}==${version}` : identifier,
        ...packageArguments,
      ];
      break;
    case "nuget":
      command = runtimeHint ?? "dnx";
      args = [
        ...runtimeArguments,
        version ? `${identifier}@${version}` : identifier,
        ...(packageArguments.length > 0 ? ["--", ...packageArguments] : []),
      ];
      break;
    case "oci":
    case "docker":
      command = runtimeHint ?? "docker";
      args = [
        "run",
        "-i",
        "--rm",
        ...runtimeArguments,
        withContainerVersion(identifier, version),
        ...packageArguments,
      ];
      break;
    case "cargo":
      command = runtimeHint ?? identifier;
      args = packageArguments;
      warnings.push(
        `Cargo package ${identifier} must be installed before this command can run.`,
      );
      break;
    default:
      return null;
  }

  const packageTransport = isObject(packageConfig.transport)
    ? getOptionalString(packageConfig.transport, "type")
    : undefined;
  const transportType = normalizeType(packageTransport);

  return {
    name,
    label: `${name} — ${registryType}: ${identifier}${packageCount > 1 ? ` (${index + 1})` : ""}`,
    config: {
      type: transportType === "streamable-http" ? "streamable-http" : "stdio",
      command,
      args,
      env: environment.values,
      description,
    },
    inputs: environment.definitions,
    userConfig: new Map(),
    warnings,
  };
}

function flattenOfficialArguments(
  value: unknown,
  warnings: string[],
): string[] {
  if (!Array.isArray(value)) return [];

  const result: string[] = [];
  for (const rawArgument of value) {
    if (typeof rawArgument === "string") {
      result.push(rawArgument);
      continue;
    }
    if (!isObject(rawArgument)) continue;

    const type = getOptionalString(rawArgument, "type") ?? "positional";
    const name = getOptionalString(rawArgument, "name");
    const valueHint = getOptionalString(rawArgument, "valueHint");
    const resolvedValue =
      getScalar(rawArgument.value) ?? getScalar(rawArgument.default);

    if (type === "named" && name) result.push(name);
    if (resolvedValue !== undefined) {
      result.push(String(resolvedValue));
      continue;
    }
    if (rawArgument.isRequired === true) {
      const placeholder = valueHint ?? name ?? "required-value";
      result.push(`<${placeholder}>`);
      warnings.push(
        `Required registry argument ${placeholder} has no default; replace its placeholder before saving.`,
      );
    }
  }
  return result;
}

function normalizeOfficialVariables(value: unknown): {
  values: JsonObject;
  definitions: Map<string, InputDefinition>;
  warnings: string[];
} {
  const values: JsonObject = {};
  const definitions = new Map<string, InputDefinition>();
  const warnings: string[] = [];
  if (!Array.isArray(value)) return { values, definitions, warnings };

  for (const rawVariable of value) {
    if (!isObject(rawVariable)) continue;
    const name = getOptionalString(rawVariable, "name");
    if (!name) continue;
    const description = getOptionalString(rawVariable, "description");
    const defaultValue = getScalar(rawVariable.default);
    const required =
      rawVariable.isRequired === true || rawVariable.is_required === true;
    const sensitive =
      rawVariable.isSecret === true ||
      rawVariable.is_secret === true ||
      looksSensitive(name);

    definitions.set(name, {
      id: name,
      description,
      defaultValue,
      required,
      sensitive,
    });

    if (defaultValue !== undefined && !sensitive) {
      values[name] = defaultValue;
    } else {
      values[name] = `\${input:${name}}`;
    }
    if (defaultValue !== undefined && sensitive) {
      warnings.push(
        `The default for sensitive registry field ${name} was not copied.`,
      );
    }
  }

  return { values, definitions, warnings };
}

function withContainerVersion(identifier: string, version?: string): string {
  const lastSegment = identifier.split("/").at(-1) ?? identifier;
  return version && !lastSegment.includes(":")
    ? `${identifier}:${version}`
    : identifier;
}

function findServerContainer(root: JsonObject): JsonObject | null {
  const direct = [root.mcpServers, root.servers];
  for (const candidate of direct) {
    if (isObject(candidate)) return candidate;
  }

  const mcp = isObject(root.mcp) ? root.mcp : null;
  if (mcp) {
    if (isObject(mcp.mcpServers)) return mcp.mcpServers;
    if (isObject(mcp.servers)) return mcp.servers;
  }

  const customizations = isObject(root.customizations)
    ? root.customizations
    : null;
  const vscode =
    customizations && isObject(customizations.vscode)
      ? customizations.vscode
      : null;
  const vscodeMcp = vscode && isObject(vscode.mcp) ? vscode.mcp : null;
  if (vscodeMcp) {
    if (isObject(vscodeMcp.mcpServers)) return vscodeMcp.mcpServers;
    if (isObject(vscodeMcp.servers)) return vscodeMcp.servers;
  }

  return null;
}

function entriesFromNamedContainer(
  container: JsonObject,
  inputs: Map<string, InputDefinition>,
  userConfig: Map<string, InputDefinition>,
): ServerEntry[] {
  const entries = Object.entries(container);
  if (entries.length === 0) {
    throw new Error("The MCP server configuration is empty.");
  }

  return entries.map(([name, config]) => {
    if (!isObject(config) || !isServerConfig(config)) {
      throw new Error(`MCP server "${name}" has no command or URL.`);
    }
    return {
      name: getServerName(config, config, name),
      config,
      inputs,
      userConfig,
    };
  });
}

function parseServerEntry(entry: ServerEntry): McpConfigImportCandidate {
  const { config } = entry;
  const warnings = [...(entry.warnings ?? [])];
  const rawType = getOptionalString(config, "type");
  const normalizedType = normalizeType(rawType);
  const command = getOptionalString(config, "command");
  const serverUrl =
    getOptionalString(config, "url") ??
    getOptionalString(config, "serverUrl") ??
    getOptionalString(config, "server_url");
  const serverType = inferServerType({ normalizedType, command, serverUrl });

  addUnsupportedFieldWarnings(config, warnings);

  if (serverType === "remote") {
    if (!serverUrl) {
      throw new Error(`Remote MCP server "${entry.name}" has no URL.`);
    }
    if (normalizedType === "sse") {
      warnings.push(
        "SSE is imported as a remote URL; Archestra negotiates the remote transport.",
      );
    }
    if (isObject(config.oauth)) {
      warnings.push(
        "Client-specific OAuth settings were not imported; configure authentication in Archestra.",
      );
    }

    return {
      name: entry.name,
      label: entry.label,
      description: getOptionalString(config, "description"),
      serverType,
      arguments: [],
      environment: [],
      serverUrl,
      additionalHeaders: parseHeaders({
        value: config.headers,
        inputs: entry.inputs,
        userConfig: entry.userConfig,
        warnings,
      }),
      warnings,
    };
  }

  if (!command) {
    throw new Error(`Self-hosted MCP server "${entry.name}" has no command.`);
  }

  const argumentsList = parseArgumentsProperty(config.args);
  if (
    argumentsList.some((argument) =>
      /\$\{(?:input:|workspaceFolder|user_config\.)/i.test(argument),
    )
  ) {
    warnings.push(
      "Client-specific variables inside arguments were kept unchanged; review them before saving.",
    );
  }

  return {
    name: entry.name,
    label: entry.label,
    description: getOptionalString(config, "description"),
    serverType,
    command,
    arguments: argumentsList,
    environment: parseEnvironment({
      value: config.env,
      inputs: entry.inputs,
      userConfig: entry.userConfig,
      warnings,
    }),
    transportType:
      normalizedType === "streamable-http" ? "streamable-http" : "stdio",
    additionalHeaders: [],
    warnings,
  };
}

function inferServerType(params: {
  normalizedType?: string;
  command?: string;
  serverUrl?: string;
}): "local" | "remote" {
  const { normalizedType, command, serverUrl } = params;
  if (["http", "sse", "remote"].includes(normalizedType ?? "")) {
    return "remote";
  }
  if (normalizedType === "streamable-http") {
    if (command) return "local";
    if (serverUrl) return "remote";
  }
  if (["stdio", "local"].includes(normalizedType ?? "")) {
    return "local";
  }
  if (serverUrl && !command) return "remote";
  if (command) return "local";

  throw new Error(
    `Unsupported MCP server type "${normalizedType ?? "unknown"}".`,
  );
}

function normalizeType(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase().replace(/[_\s]/g, "-");
  return normalized === "streamablehttp" ? "streamable-http" : normalized;
}

function parseArgumentsProperty(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === "string") return parseMcpArgumentsInput(value);
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("MCP server args must be an array of strings.");
  }
  return value;
}

function parseEnvironment(params: {
  value: unknown;
  inputs: Map<string, InputDefinition>;
  userConfig: Map<string, InputDefinition>;
  warnings: string[];
}): ImportedEnvironmentVariable[] {
  const { value, inputs, userConfig, warnings } = params;
  if (value == null) return [];
  if (!isObject(value)) {
    throw new Error("MCP server env must be a JSON object.");
  }

  return Object.entries(value).map(([key, rawValue]) => {
    if (
      rawValue !== null &&
      typeof rawValue !== "string" &&
      typeof rawValue !== "number" &&
      typeof rawValue !== "boolean"
    ) {
      throw new Error(`Environment variable "${key}" must be a scalar value.`);
    }

    const placeholder =
      typeof rawValue === "string"
        ? resolvePlaceholder(rawValue, inputs, userConfig, key)
        : null;
    const sensitive = placeholder?.sensitive ?? looksSensitive(key);

    if (placeholder) {
      return {
        key,
        type: sensitive ? "secret" : "plain_text",
        value:
          !sensitive && placeholder.defaultValue !== undefined
            ? String(placeholder.defaultValue)
            : undefined,
        promptOnInstallation: true,
        required: placeholder.required,
        description: placeholder.description,
      };
    }

    if (sensitive && typeof rawValue === "string" && rawValue.length > 0) {
      warnings.push(
        `The literal value for sensitive environment variable ${key} was not copied; enter it securely during installation.`,
      );
      return {
        key,
        type: "secret",
        promptOnInstallation: true,
        required: true,
      };
    }

    return {
      key,
      type:
        typeof rawValue === "boolean"
          ? "boolean"
          : typeof rawValue === "number"
            ? "number"
            : "plain_text",
      value: rawValue === null ? "" : String(rawValue),
      promptOnInstallation: false,
      required: false,
    };
  });
}

function parseHeaders(params: {
  value: unknown;
  inputs: Map<string, InputDefinition>;
  userConfig: Map<string, InputDefinition>;
  warnings: string[];
}): ImportedHeader[] {
  const { value, inputs, userConfig, warnings } = params;
  if (value == null) return [];
  if (!isObject(value)) {
    throw new Error("MCP server headers must be a JSON object.");
  }

  return Object.entries(value).map(([headerName, rawValue], index) => {
    if (
      typeof rawValue !== "string" &&
      typeof rawValue !== "number" &&
      typeof rawValue !== "boolean"
    ) {
      throw new Error(`Header "${headerName}" must be a scalar value.`);
    }

    const stringValue = String(rawValue);
    const bearerMatch = stringValue.match(/^Bearer\s+(.+)$/i);
    const placeholderValue = bearerMatch?.[1] ?? stringValue;
    const placeholder = resolvePlaceholder(
      placeholderValue,
      inputs,
      userConfig,
      headerName,
    );
    const sensitive = placeholder?.sensitive ?? looksSensitive(headerName);

    if (placeholder || sensitive) {
      if (!placeholder && stringValue.length > 0) {
        warnings.push(
          `The literal value for sensitive header ${headerName} was not copied; enter it securely during installation.`,
        );
      }
      return {
        fieldName: placeholder
          ? toFieldName(placeholder.reference, index)
          : undefined,
        headerName,
        promptOnInstallation: true,
        required: placeholder?.required ?? true,
        description: placeholder?.description,
        includeBearerPrefix: Boolean(bearerMatch),
        sensitive: true,
      };
    }

    return {
      headerName,
      promptOnInstallation: false,
      required: false,
      value: stringValue,
      sensitive: false,
    };
  });
}

function resolvePlaceholder(
  value: string,
  inputs: Map<string, InputDefinition>,
  userConfig: Map<string, InputDefinition>,
  fallbackName: string,
): Placeholder | null {
  const inputMatch = value.match(/^\$\{input:([^}]+)\}$/);
  if (inputMatch?.[1]) {
    return placeholderFromDefinition(
      inputMatch[1],
      inputs.get(inputMatch[1]),
      fallbackName,
    );
  }

  const userConfigMatch = value.match(/^\$\{user_config\.([^}]+)\}$/);
  if (userConfigMatch?.[1]) {
    return placeholderFromDefinition(
      userConfigMatch[1],
      userConfig.get(userConfigMatch[1]),
      fallbackName,
    );
  }

  const genericMatch =
    value.match(/^<([^>]+)>$/) ??
    value.match(/^\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_.-]*)\}$/) ??
    value.match(/^((?:YOUR|REPLACE|INSERT)[A-Za-z0-9_-]*)$/i);
  if (!genericMatch?.[1]) return null;

  return placeholderFromDefinition(genericMatch[1], undefined, fallbackName);
}

function placeholderFromDefinition(
  reference: string,
  definition: InputDefinition | undefined,
  fallbackName: string,
): Placeholder {
  return {
    id: definition?.id ?? reference,
    reference,
    description: definition?.description,
    defaultValue: definition?.defaultValue,
    required: definition?.required ?? true,
    sensitive:
      definition?.sensitive ??
      (looksSensitive(reference) || looksSensitive(fallbackName)),
  };
}

function parseInputDefinitions(value: unknown): Map<string, InputDefinition> {
  const definitions = new Map<string, InputDefinition>();
  if (!Array.isArray(value)) return definitions;

  for (const candidate of value) {
    if (!isObject(candidate) || typeof candidate.id !== "string") continue;
    definitions.set(candidate.id, {
      id: candidate.id,
      description: getOptionalString(candidate, "description"),
      defaultValue: getScalar(candidate.default),
      required: true,
      sensitive: candidate.password === true || looksSensitive(candidate.id),
    });
  }
  return definitions;
}

function parseUserConfigDefinitions(
  value: unknown,
): Map<string, InputDefinition> {
  const definitions = new Map<string, InputDefinition>();
  if (!isObject(value)) return definitions;

  for (const [id, rawDefinition] of Object.entries(value)) {
    if (!isObject(rawDefinition)) continue;
    definitions.set(id, {
      id,
      description:
        getOptionalString(rawDefinition, "description") ??
        getOptionalString(rawDefinition, "title"),
      defaultValue: getScalar(rawDefinition.default),
      required: rawDefinition.required !== false,
      sensitive: rawDefinition.sensitive === true || looksSensitive(id),
    });
  }
  return definitions;
}

function addUnsupportedFieldWarnings(
  config: JsonObject,
  warnings: string[],
): void {
  const unsupported = ["cwd", "envFile", "sandboxEnabled", "dev"].filter(
    (key) => config[key] !== undefined,
  );
  if (unsupported.length > 0) {
    warnings.push(
      `These client-specific fields were not imported: ${unsupported.join(", ")}.`,
    );
  }
}

function isServerConfig(value: JsonObject): boolean {
  return ["command", "url", "serverUrl", "server_url", "type"].some(
    (key) => value[key] !== undefined,
  );
}

function getServerName(
  root: JsonObject,
  config: JsonObject,
  fallback: string,
): string {
  return (
    getOptionalString(config, "name") ??
    getOptionalString(root, "name") ??
    (isObject(root.author)
      ? getOptionalString(root.author, "name")
      : undefined) ??
    fallback
  );
}

function getOptionalString(value: JsonObject, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim()
    ? candidate.trim()
    : undefined;
}

function getScalar(value: unknown): string | number | boolean | undefined {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return undefined;
}

function looksSensitive(value: string): boolean {
  return /(?:token|secret|password|passwd|api[-_]?key|credential|authorization|auth[-_]?key)/i.test(
    value,
  );
}

function toFieldName(reference: string, index: number): string {
  const normalized = reference
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || `header_value_${index + 1}`;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
