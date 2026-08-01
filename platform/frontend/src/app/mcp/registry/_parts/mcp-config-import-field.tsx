"use client";

import { AlertTriangle, CheckCircle2, ClipboardPaste } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  type McpConfigImportCandidate,
  parseMcpConfigJson,
} from "./mcp-config-import";

type McpConfigImportFieldProps = {
  canImportLocal: boolean;
  onImport: (candidate: McpConfigImportCandidate) => void;
};

export function McpConfigImportField({
  canImportLocal,
  onImport,
}: McpConfigImportFieldProps) {
  const [rawConfig, setRawConfig] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [importedName, setImportedName] = useState<string | null>(null);

  const parseResult = useMemo(() => {
    if (!rawConfig.trim()) {
      return { candidates: [], error: null };
    }
    try {
      return { candidates: parseMcpConfigJson(rawConfig), error: null };
    } catch (error) {
      return {
        candidates: [],
        error:
          error instanceof Error
            ? error.message
            : "Unable to parse the MCP configuration.",
      };
    }
  }, [rawConfig]);

  const selectedCandidate =
    parseResult.candidates[selectedIndex] ?? parseResult.candidates[0];
  const localImportDisabled =
    selectedCandidate?.serverType === "local" && !canImportLocal;

  const handleImport = () => {
    if (!selectedCandidate || localImportDisabled) return;
    onImport(selectedCandidate);
    setImportedName(selectedCandidate.name);
  };

  return (
    <div className="space-y-3 rounded-lg border border-dashed p-4">
      <div className="space-y-1">
        <div className="flex items-center gap-2 font-medium text-sm">
          <ClipboardPaste className="h-4 w-4" />
          <span>Import MCP configuration</span>
        </div>
        <p className="text-muted-foreground text-sm">
          Paste a JSON configuration from an MCP catalog or client. Review the
          populated fields before saving.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="mcp-config-import">Configuration JSON</Label>
        <Textarea
          id="mcp-config-import"
          className="min-h-28 font-mono text-xs"
          placeholder={
            '{"mcpServers":{"example":{"command":"npx","args":["-y","@example/mcp"]}}}'
          }
          value={rawConfig}
          onChange={(event) => {
            setRawConfig(event.target.value);
            setSelectedIndex(0);
            setImportedName(null);
          }}
          spellCheck={false}
        />
      </div>

      {parseResult.candidates.length > 1 ? (
        <div className="space-y-2">
          <Label htmlFor="mcp-config-server">Server to import</Label>
          <Select
            value={String(selectedIndex)}
            onValueChange={(value) => {
              setSelectedIndex(Number(value));
              setImportedName(null);
            }}
          >
            <SelectTrigger id="mcp-config-server">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {parseResult.candidates.map((candidate, index) => (
                <SelectItem
                  key={
                    candidate.label ??
                    `${candidate.name}-${candidate.serverType}-${candidate.command ?? candidate.serverUrl ?? "server"}`
                  }
                  value={String(index)}
                >
                  {candidate.label ?? candidate.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {parseResult.error ? (
        <div
          role="alert"
          className="flex items-start gap-2 text-destructive text-sm"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{parseResult.error}</span>
        </div>
      ) : null}

      {localImportDisabled ? (
        <div
          role="alert"
          className="flex items-start gap-2 text-amber-700 text-sm dark:text-amber-400"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Self-hosted MCP servers require the Kubernetes orchestrator.
          </span>
        </div>
      ) : null}

      {selectedCandidate?.warnings.length ? (
        <div className="space-y-1 text-amber-700 text-sm dark:text-amber-400">
          {selectedCandidate.warnings.map((warning) => (
            <div key={warning} className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{warning}</span>
            </div>
          ))}
        </div>
      ) : null}

      {importedName ? (
        <output className="flex items-center gap-2 text-emerald-700 text-sm dark:text-emerald-400">
          <CheckCircle2 className="h-4 w-4" />
          <span>Imported {importedName}. Review the fields below.</span>
        </output>
      ) : null}

      <Button
        type="button"
        variant="secondary"
        disabled={!selectedCandidate || localImportDisabled}
        onClick={handleImport}
      >
        <ClipboardPaste className="h-4 w-4" />
        <span>
          {parseResult.candidates.length > 1
            ? "Import selected server"
            : "Import configuration"}
        </span>
      </Button>
    </div>
  );
}
