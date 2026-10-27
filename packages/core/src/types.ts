export type RiskClass = "low" | "medium" | "high";

export type TaskState =
  | "proposed"
  | "approved"
  | "rejected"
  | "planned"
  | "in_progress"
  | "checks"
  | "in_review"
  | "awaiting_merge"
  | "merged"
  | "escalated"
  | "cancelled";

export type TaskEvent =
  | "approve"
  | "reject"
  | "plan"
  | "start"
  | "run_checks"
  | "checks_passed"
  | "checks_failed"
  | "request_changes"
  | "merge"
  | "cancel";

export interface Task {
  readonly id: string;
  readonly projectPath: string;
  readonly title: string;
  readonly specPath: string;
  readonly riskClass: RiskClass;
  readonly state: TaskState;
  /** Number of failed checks sent back to in_progress. */
  readonly checkIterations: number;
  /** Number of review change requests sent back to in_progress. */
  readonly reviewIterations: number;
}

export type Verdict =
  | { readonly source: "checks"; readonly outcome: "pass" | "fail" }
  | { readonly source: "review"; readonly outcome: "approve" | "changes" };

export interface Run {
  readonly id: string;
  readonly taskId: string;
  /** ISO 8601 timestamp. */
  readonly startedAt: string;
  /** ISO 8601 timestamp, null while the run is ongoing. */
  readonly finishedAt: string | null;
  readonly verdict: Verdict | null;
}
