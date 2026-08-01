import { describe, expect, it } from "vitest";
import {
  parseMcpArgumentsInput,
  parseMcpConfigJson,
} from "./mcp-config-import";

describe("parseMcpArgumentsInput", () => {
  it("keeps newline-separated arguments compatible", () => {
    expect(
      parseMcpArgumentsInput(" -y \n @example/server \n\n --verbose "),
    ).toEqual(["-y", "@example/server", "--verbose"]);
  });

  it("accepts a JSON array copied from a catalog", () => {
    expect(
      parseMcpArgumentsInput('["-y", "@example/server", "--flag=value"]'),
    ).toEqual(["-y", "@example/server", "--flag=value"]);
  });

  it("rejects malformed or non-string JSON arguments", () => {
    expect(() => parseMcpArgumentsInput('["-y",')).toThrow(
      "Arguments must be a valid JSON array or one per line.",
    );
    expect(() => parseMcpArgumentsInput('["--port", 3000]')).toThrow(
      "Arguments JSON must be an array of strings.",
    );
  });
});

describe("parseMcpConfigJson", () => {
  it("imports a Claude-style local server and typed environment values", () => {
    const [candidate] = parseMcpConfigJson(`{
      "mcpServers": {
        "sonarqube": {
          "command": "docker",
          "args": ["run", "--rm", "mcp/sonarqube"],
          "env": {
            "SONARQUBE_TOKEN": "<token>",
            "SONARQUBE_ORG": "<org>",
            "DEBUG": true,
            "PORT": 3000
          }
        }
      }
    }`);

    expect(candidate).toMatchObject({
      name: "sonarqube",
      serverType: "local",
      command: "docker",
      arguments: ["run", "--rm", "mcp/sonarqube"],
      transportType: "stdio",
    });
    expect(candidate?.environment).toEqual([
      {
        key: "SONARQUBE_TOKEN",
        type: "secret",
        promptOnInstallation: true,
        required: true,
      },
      {
        key: "SONARQUBE_ORG",
        type: "plain_text",
        promptOnInstallation: true,
        required: true,
      },
      {
        key: "DEBUG",
        type: "boolean",
        value: "true",
        promptOnInstallation: false,
        required: false,
      },
      {
        key: "PORT",
        type: "number",
        value: "3000",
        promptOnInstallation: false,
        required: false,
      },
    ]);
  });

  it("imports VS Code inputs and remote HTTP headers", () => {
    const [candidate] = parseMcpConfigJson(
      JSON.stringify({
        servers: {
          github: {
            type: "http",
            url: "https://api.githubcopilot.com/mcp/",
            headers: {
              Authorization: `Bearer \${input:github_mcp_pat}`,
              "X-Tenant": "engineering",
            },
          },
        },
        inputs: [
          {
            type: "promptString",
            id: "github_mcp_pat",
            description: "GitHub Personal Access Token",
            password: true,
          },
        ],
      }),
    );

    expect(candidate).toMatchObject({
      name: "github",
      serverType: "remote",
      serverUrl: "https://api.githubcopilot.com/mcp/",
    });
    expect(candidate?.additionalHeaders).toEqual([
      {
        fieldName: "github_mcp_pat",
        headerName: "Authorization",
        promptOnInstallation: true,
        required: true,
        description: "GitHub Personal Access Token",
        includeBearerPrefix: true,
        sensitive: true,
      },
      {
        headerName: "X-Tenant",
        promptOnInstallation: false,
        required: false,
        value: "engineering",
        sensitive: false,
      },
    ]);
  });

  it("does not copy literal credentials from environment variables or headers", () => {
    const [local] = parseMcpConfigJson(
      '{"name":"private","command":"node","env":{"API_KEY":"real-secret"}}',
    );
    const [remote] = parseMcpConfigJson(
      '{"name":"remote","type":"http","url":"https://example.com/mcp","headers":{"Authorization":"Bearer real-secret"}}',
    );

    expect(local?.environment[0]).toEqual({
      key: "API_KEY",
      type: "secret",
      promptOnInstallation: true,
      required: true,
    });
    expect(local?.warnings[0]).toContain("was not copied");
    expect(remote?.additionalHeaders[0]).not.toHaveProperty("value");
    expect(remote?.warnings[0]).toContain("was not copied");
  });

  it("imports direct and wrapper-less named configurations", () => {
    const [direct] = parseMcpConfigJson(
      '{"name":"fetch","command":"uvx","args":["mcp-server-fetch"]}',
    );
    const candidates = parseMcpConfigJson(`{
      "filesystem": {"command": "npx", "args": ["-y", "server-filesystem"]},
      "context7": {"type": "sse", "url": "https://example.com/sse"}
    }`);

    expect(direct).toMatchObject({ name: "fetch", command: "uvx" });
    expect(candidates.map(({ name }) => name)).toEqual([
      "filesystem",
      "context7",
    ]);
    expect(candidates[1]).toMatchObject({
      serverType: "remote",
      serverUrl: "https://example.com/sse",
    });
    expect(candidates[1]?.warnings[0]).toContain("SSE");
  });

  it("imports an Archestra registry server block and user_config placeholder", () => {
    const [candidate] = parseMcpConfigJson(
      JSON.stringify({
        author: { name: "github" },
        user_config: {
          access_token: {
            title: "Access Token",
            description: "A GitHub personal access token",
            required: true,
            sensitive: true,
          },
        },
        server: {
          type: "local",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_TOKEN: `\${user_config.access_token}` },
        },
      }),
    );

    expect(candidate).toMatchObject({
      name: "github",
      serverType: "local",
      command: "npx",
    });
    expect(candidate?.environment[0]).toEqual({
      key: "GITHUB_TOKEN",
      type: "secret",
      promptOnInstallation: true,
      required: true,
      description: "A GitHub personal access token",
    });
  });

  it("recognizes nested VS Code dev-container configuration and fenced JSON", () => {
    const config = JSON.stringify({
      customizations: {
        vscode: {
          mcp: {
            servers: {
              playwright: {
                type: "stdio",
                command: "npx",
                args: ["-y", "@playwright/mcp"],
              },
            },
          },
        },
      },
    });
    const [candidate] = parseMcpConfigJson(`\`\`\`json\n${config}\n\`\`\``);

    expect(candidate).toMatchObject({
      name: "playwright",
      serverType: "local",
      command: "npx",
      transportType: "stdio",
    });
  });

  it("maps a commanded streamable HTTP server to self-hosted transport", () => {
    const [candidate] = parseMcpConfigJson(
      '{"name":"local-http","type":"streamable_http","command":"node","args":["server.js"]}',
    );

    expect(candidate).toMatchObject({
      serverType: "local",
      transportType: "streamable-http",
    });
  });

  it("normalizes official MCP Registry remotes and package launch metadata", () => {
    const candidates = parseMcpConfigJson(
      JSON.stringify({
        $schema:
          "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
        name: "io.example/hybrid",
        title: "Hybrid MCP",
        description: "Available remotely and as packages",
        remotes: [
          {
            type: "streamable-http",
            url: "https://mcp.example.com/mcp",
            headers: [
              {
                name: "X-API-Key",
                description: "API key",
                isRequired: true,
                isSecret: true,
              },
              { name: "X-Region", default: "us-east-1" },
            ],
          },
        ],
        packages: [
          {
            registryType: "npm",
            identifier: "@example/hybrid-mcp",
            version: "1.5.0",
            transport: { type: "stdio" },
            packageArguments: [
              { type: "named", name: "--mode", default: "local" },
            ],
            environmentVariables: [
              {
                name: "API_TOKEN",
                description: "Package API token",
                isRequired: true,
                isSecret: true,
              },
              { name: "LOG_LEVEL", default: "info" },
            ],
          },
          {
            registryType: "pypi",
            identifier: "hybrid-mcp",
            version: "1.5.0",
            runtimeHint: "uvx",
            transport: { type: "stdio" },
            packageArguments: [
              {
                type: "positional",
                valueHint: "workspace",
                isRequired: true,
              },
            ],
          },
        ],
      }),
    );

    expect(candidates).toHaveLength(3);
    expect(candidates[0]).toMatchObject({
      name: "Hybrid MCP",
      label: "Hybrid MCP — remote streamable-http",
      serverType: "remote",
      serverUrl: "https://mcp.example.com/mcp",
      additionalHeaders: [
        expect.objectContaining({
          headerName: "X-API-Key",
          promptOnInstallation: true,
          sensitive: true,
        }),
        expect.objectContaining({
          headerName: "X-Region",
          value: "us-east-1",
          promptOnInstallation: false,
        }),
      ],
    });
    expect(candidates[1]).toMatchObject({
      serverType: "local",
      command: "npx",
      arguments: ["-y", "@example/hybrid-mcp@1.5.0", "--mode", "local"],
      environment: [
        expect.objectContaining({
          key: "API_TOKEN",
          type: "secret",
          promptOnInstallation: true,
        }),
        expect.objectContaining({
          key: "LOG_LEVEL",
          value: "info",
          promptOnInstallation: false,
        }),
      ],
    });
    expect(candidates[2]).toMatchObject({
      command: "uvx",
      arguments: ["hybrid-mcp==1.5.0", "<workspace>"],
    });
    expect(candidates[2]?.warnings[0]).toContain(
      "Required registry argument workspace has no default",
    );
  });

  it("reports malformed, empty, and unsupported configurations", () => {
    expect(() => parseMcpConfigJson("{oops}")).toThrow(
      "The MCP configuration must be valid JSON.",
    );
    expect(() => parseMcpConfigJson('{"servers":{}}')).toThrow(
      "The MCP server configuration is empty.",
    );
    expect(() => parseMcpConfigJson('{"type":"websocket"}')).toThrow(
      'Unsupported MCP server type "websocket".',
    );
    expect(() =>
      parseMcpConfigJson(
        '{"name":"bundle","packages":[{"registryType":"mcpb","identifier":"https://example.com/server.mcpb"}]}',
      ),
    ).toThrow(
      "The official MCP registry entry has no supported remote or package configuration.",
    );
  });
});
