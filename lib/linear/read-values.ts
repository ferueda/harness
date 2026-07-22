import { LinearError } from "./error.ts";
import type { RawIssue, RawWorkflowState } from "./sdk-types.ts";
import type { LinearIssueRevision, LinearWorkflowState } from "./types.ts";

export function normalizeIssueRevision(value: RawIssue): LinearIssueRevision {
  return {
    id: requiredString(value.id, "issue revision id"),
    identifier: requiredString(value.identifier, "issue revision identifier"),
    updatedAt: isoDate(value.updatedAt, "issue revision updatedAt"),
  };
}

export function normalizeState(value: RawWorkflowState): LinearWorkflowState {
  return {
    id: requiredString(value.id, "workflow state id"),
    name: requiredString(value.name, "workflow state name"),
    type: requiredString(value.type, "workflow state type"),
  };
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") throw invalidResponse(`Linear response has invalid ${label}.`);
  return value;
}

export function nonEmptyInput(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new LinearError("invalid-input", `Linear ${label} must be a non-empty string.`);
  }
  return value.trim();
}

export function nullableString(value: unknown, label: string): string | null {
  if (value == null) return null;
  return requiredString(value, label);
}

export function isoDate(value: unknown, label: string): string {
  if (!(value instanceof Date) && typeof value !== "string") {
    throw invalidResponse(`Linear response has invalid ${label}.`);
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw invalidResponse(`Linear response has invalid ${label}.`);
  return date.toISOString();
}

export function comparePair(
  leftPrimary: string,
  leftTie: string,
  rightPrimary: string,
  rightTie: string,
): number {
  return compareText(leftPrimary, rightPrimary) || compareText(leftTie, rightTie);
}

export function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function invalidResponse(message: string): LinearError {
  return new LinearError("invalid-response", message);
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}
