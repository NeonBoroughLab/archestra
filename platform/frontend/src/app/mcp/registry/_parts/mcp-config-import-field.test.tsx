import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { McpConfigImportField } from "./mcp-config-import-field";

describe("McpConfigImportField", () => {
  it("parses and applies a valid configuration", () => {
    const onImport = vi.fn();
    render(<McpConfigImportField canImportLocal onImport={onImport} />);

    fireEvent.change(screen.getByLabelText("Configuration JSON"), {
      target: {
        value: JSON.stringify({
          servers: {
            context7: {
              type: "http",
              url: "https://mcp.context7.com/mcp",
            },
          },
        }),
      },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Import configuration" }),
    );

    expect(onImport).toHaveBeenCalledOnce();
    expect(onImport).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "context7",
        serverType: "remote",
        serverUrl: "https://mcp.context7.com/mcp",
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Imported context7. Review the fields below.",
    );
  });

  it("blocks a self-hosted import when the orchestrator is unavailable", () => {
    const onImport = vi.fn();
    render(<McpConfigImportField canImportLocal={false} onImport={onImport} />);

    fireEvent.change(screen.getByLabelText("Configuration JSON"), {
      target: {
        value:
          '{"name":"filesystem","command":"npx","args":["server-filesystem"]}',
      },
    });

    expect(
      screen.getByRole("button", { name: "Import configuration" }),
    ).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Self-hosted MCP servers require the Kubernetes orchestrator.",
    );
    expect(onImport).not.toHaveBeenCalled();
  });
});
