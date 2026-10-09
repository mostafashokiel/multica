import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { workflowValidationOptions } from "@multica/core/workflows";
import type { WorkflowIssue } from "@multica/core/types";

/** How long the text must sit still before the server is asked about it. */
export const VALIDATION_DEBOUNCE_MS = 300;

export interface Validation {
  /** The server's problems with the text it last judged; empty until it has judged one. */
  issues: WorkflowIssue[];
  /** The text a save would store, once the server has judged one. */
  canonical: string | undefined;
  /** The verdict on screen is not (yet) about the text on screen. */
  checking: boolean;
  /** The server has given a verdict at least once. */
  known: boolean;
  /** The server could not be asked (offline, error): there is no verdict, not a clean one. */
  failed: boolean;
}

/**
 * The server's verdict on a definition's text, asked 300 ms after the text stops changing.
 * Validation lives in the server alone (one implementation), so the editor never decides
 * what is valid; until an answer arrives it shows the last one and says it is checking.
 */
export function useDefinitionValidation(wsId: string, text: string): Validation {
  const [settled, setSettled] = useState(text);
  useEffect(() => {
    if (settled === text) return;
    const timer = setTimeout(() => setSettled(text), VALIDATION_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, settled]);

  const query = useQuery(workflowValidationOptions(wsId, settled));
  const data = query.data;
  return {
    issues: data?.issues ?? [],
    canonical: data?.canonical,
    checking: settled !== text || query.isFetching,
    known: data !== undefined,
    // No answer, or one that says nothing parsed and names no problem (the client's stand-in for
    // an answer it could not read): there is no verdict, which is not the same as "valid".
    failed: query.isError || (data !== undefined && !data.parsed && data.issues.length === 0),
  };
}
