import type { Task, TaskEvent, TaskState } from "./types.js";

export class InvalidTransitionError extends Error {
  override readonly name = "InvalidTransitionError";

  constructor(
    readonly state: TaskState,
    readonly event: TaskEvent,
  ) {
    super(`Invalid transition: ${state} --${event}-->`);
  }
}

export const MAX_CHECK_ITERATIONS = 3;
export const MAX_REVIEW_ITERATIONS = 2;

const TERMINAL_STATES: ReadonlySet<TaskState> = new Set(["rejected", "merged", "cancelled"]);

export function transition(task: Task, event: TaskEvent): Task {
  const next = nextFields(task, event);
  if (next === null) {
    throw new InvalidTransitionError(task.state, event);
  }
  return { ...task, ...next };
}

function nextFields(task: Task, event: TaskEvent): Partial<Task> | null {
  if (event === "cancel") {
    return TERMINAL_STATES.has(task.state) ? null : { state: "cancelled" };
  }

  switch (`${task.state}:${event}`) {
    case "proposed:approve":
      return { state: "approved" };
    case "proposed:reject":
      return { state: "rejected" };
    case "approved:plan":
      return { state: "planned" };
    case "planned:start":
      return { state: "in_progress" };
    case "in_progress:run_checks":
      return { state: "checks" };
    case "checks:checks_passed":
      return { state: "in_review" };
    case "checks:checks_failed":
      return task.checkIterations < MAX_CHECK_ITERATIONS
        ? { state: "in_progress", checkIterations: task.checkIterations + 1 }
        : { state: "escalated" };
    case "in_review:request_changes":
      return task.reviewIterations < MAX_REVIEW_ITERATIONS
        ? { state: "in_progress", reviewIterations: task.reviewIterations + 1 }
        : { state: "escalated" };
    case "in_review:approve":
      return { state: task.riskClass === "low" ? "merged" : "awaiting_merge" };
    case "awaiting_merge:merge":
      return { state: "merged" };
    default:
      return null;
  }
}
