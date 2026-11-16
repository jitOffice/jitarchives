import type { UserView } from '../common/roles';

export interface ToolPagination {
  page: number;
  pageSize: number;
  totalPages: number;
  hasMore: boolean;
}

export interface AgentToolResult<T = any> {
  callId?: string;
  durationMs?: number;
  toolName: string;
  status: 'success' | 'error' | 'skipped';
  data: T | null;
  total: number;
  pagination: ToolPagination | null;
  error: { code: string; message: string } | null;
}

export interface ToolParams {
  keyword?: string;
  title?: string;
  archiveNo?: string;
  categoryId?: number;
  status?: string;
  archiveId?: number;
  /** For backward-compatible /api/knowledge evidence/status calls; never model-supplied. */
  attachmentId?: number;
  archiveIds?: number[];
  fileIds?: number[];
  summary?: boolean;
  includeStructure?: boolean;
  attachmentFileName?: string;
  extension?: string;
  page?: number;
  pageSize?: number;
  scope?: 'mine' | 'review';
  requestId?: number;
  actorName?: string;
  actions?: string[];
  from?: string;
  to?: string;
  timeRange?: string;
  terms?: string[];
  comparison?: boolean;
  query?: string;
  referenceFileIds?: number[];
}

export interface ToolProperty {
  type: 'string' | 'integer' | 'array' | 'boolean';
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  enum?: readonly string[];
  pattern?: string;
  items?: ToolProperty;
  maxItems?: number;
}

export interface ToolSchema {
  type: 'object';
  additionalProperties: false;
  properties: Record<string, ToolProperty>;
  required: string[];
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  readOnly: true;
  /** Whether this read-only tool may be selected by the natural-language planner. */
  plannerVisible?: boolean;
  parameters: ToolSchema;
  execute: (params: ToolParams, operator: UserView) => unknown | Promise<unknown>;
}

/** Generalized upstream-scope injection: any completed step's real authorized ids narrow a downstream step. */
export interface ScopeInjection {
  /** Upstream call id whose real (fully paginated) result supplies the scope. */
  step: string;
  /** Which authorized id to draw: parent archives, or attachment files (also carrying their parent archives). */
  kind: 'archive' | 'file' | 'auto';
}

/** Plans are constructed by the server. Model output never supplies dependency bindings or identity. */
export interface AgentToolCall {
  id: string;
  toolName: string;
  params: ToolParams;
  dependsOn?: string[];
  archiveFrom?: string;
  /** Server-owned preference for a singular archive's attachment list. */
  preferExactArchiveTitle?: string;
  /** Server-owned generalized scope feed from an upstream step's real result (replaces per-tool archiveFrom assumptions). */
  scopeFrom?: ScopeInjection;
}

export interface AgentToolExecution {
  status: 'success' | 'partial' | 'error';
  results: AgentToolResult[];
}
