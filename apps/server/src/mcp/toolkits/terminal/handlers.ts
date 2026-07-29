import {
  TerminalSessionLookupError,
  type TerminalMetadataStreamEvent,
  type TerminalSessionSnapshot,
  type TerminalSummary,
} from "@t3tools/contracts";
import { nextTerminalId } from "@t3tools/shared/terminalLabels";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";

import * as TerminalManager from "../../../terminal/Manager.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  TERMINAL_READ_DEFAULT_LINES,
  TERMINAL_READ_MAX_CHARACTERS,
  TERMINAL_WAIT_DEFAULT_QUIET_MS,
  TERMINAL_WAIT_DEFAULT_TIMEOUT_MS,
  TerminalToolkit,
  type TerminalCloseToolInput,
  type TerminalListToolInput,
  type TerminalOpenToolInput,
  type TerminalReadToolInput,
  type TerminalWaitToolInput,
  type TerminalWriteToolInput,
} from "./tools.ts";

/**
 * Terminal tools always act on the thread the MCP credential was minted for.
 * The thread id comes from the invocation scope and is never accepted as a tool
 * parameter, so an agent cannot name its way into another thread's terminals.
 */
const requireThreadId = Effect.fn("TerminalToolkit.requireThreadId")(function* () {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  return invocation.threadId;
});

/**
 * Reads the live terminal roster. `subscribeMetadata` delivers the full
 * snapshot before it hands back the unsubscribe function, so this is a
 * point-in-time read rather than a lasting subscription.
 */
const readThreadTerminals = Effect.fn("TerminalToolkit.readThreadTerminals")(function* (
  threadId: string,
) {
  const manager = yield* TerminalManager.TerminalManager;
  const captured: { terminals: ReadonlyArray<TerminalSummary> } = { terminals: [] };
  const unsubscribe = yield* manager.subscribeMetadata((event) =>
    Effect.sync(() => {
      if (event.type === "snapshot") {
        captured.terminals = event.terminals;
      }
    }),
  );
  unsubscribe();
  return captured.terminals.filter((terminal) => terminal.threadId === threadId);
});

const findThreadTerminal = Effect.fn("TerminalToolkit.findThreadTerminal")(function* (
  threadId: string,
  terminalId: string,
) {
  const terminals = yield* readThreadTerminals(threadId);
  return terminals.find((terminal) => terminal.terminalId === terminalId) ?? null;
});

/** `TerminalManager.open` returns a snapshot; subprocess activity is only known to the roster. */
const summaryFromSnapshot = (snapshot: TerminalSessionSnapshot): TerminalSummary => ({
  threadId: snapshot.threadId,
  terminalId: snapshot.terminalId,
  cwd: snapshot.cwd,
  worktreePath: snapshot.worktreePath,
  status: snapshot.status,
  pid: snapshot.pid,
  exitCode: snapshot.exitCode,
  exitSignal: snapshot.exitSignal,
  hasRunningSubprocess: false,
  label: snapshot.label,
  updatedAt: snapshot.updatedAt,
});

/* eslint-disable no-control-regex -- stripping PTY escape sequences means matching them */
const OSC_SEQUENCE = /\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g;
const CSI_SEQUENCE = /[\u001B\u009B]\[[0-?]*[ -/]*[@-~]/g;
const SINGLE_ESCAPE = /\u001B[@-Z\\-_]/g;
const RESIDUAL_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
/* eslint-enable no-control-regex */

/**
 * Turns raw PTY scrollback into something a model can read: drops escape
 * sequences and keeps only the final text of lines the shell rewrote in place,
 * which is how spinners and progress bars would otherwise arrive.
 */
export function stripTerminalControlSequences(history: string): string {
  const withoutEscapes = history
    .replace(OSC_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(SINGLE_ESCAPE, "")
    .replace(RESIDUAL_CONTROL, "");
  return withoutEscapes
    .split("\n")
    .map((line) => line.split("\r").findLast((segment) => segment.length > 0) ?? "")
    .join("\n");
}

/** Applies the line bound first, then the absolute character ceiling, keeping the newest output. */
export function boundTerminalOutput(
  history: string,
  maxLines: number,
): { readonly output: string; readonly lines: number; readonly truncated: boolean } {
  const allLines = history.split("\n");
  const keptLines = allLines.slice(-maxLines);
  const boundedByLines = keptLines.join("\n");
  const output =
    boundedByLines.length > TERMINAL_READ_MAX_CHARACTERS
      ? boundedByLines.slice(-TERMINAL_READ_MAX_CHARACTERS)
      : boundedByLines;
  return {
    output,
    lines: output.length === 0 ? 0 : output.split("\n").length,
    truncated: keptLines.length < allLines.length || output.length < boundedByLines.length,
  };
}

/** Point-in-time snapshot of one terminal, including its scrollback. */
const readTerminalSnapshot = Effect.fn("TerminalToolkit.readTerminalSnapshot")(function* (
  threadId: string,
  terminalId: string,
) {
  const manager = yield* TerminalManager.TerminalManager;
  const captured: { snapshot: TerminalSessionSnapshot | null } = { snapshot: null };
  const unsubscribe = yield* manager.attachStream({ threadId, terminalId }, (event) =>
    Effect.sync(() => {
      if (event.type === "snapshot") {
        captured.snapshot = event.snapshot;
      }
    }),
  );
  unsubscribe();
  const snapshot = captured.snapshot;
  if (!snapshot) {
    return yield* new TerminalSessionLookupError({ threadId, terminalId });
  }
  return snapshot;
});

const applyMetadataEvent = (
  event: TerminalMetadataStreamEvent,
  threadId: string,
  terminalId: string,
): TerminalSummary | null => {
  switch (event.type) {
    case "snapshot":
      return (
        event.terminals.find(
          (terminal) => terminal.threadId === threadId && terminal.terminalId === terminalId,
        ) ?? null
      );
    case "upsert":
      return event.terminal;
    case "remove":
      return null;
  }
};

interface TerminalIdleOutcome {
  readonly idle: boolean;
  readonly timedOut: boolean;
  readonly terminal: TerminalSummary | null;
}

/**
 * Waits until the terminal has reported no running subprocess for `quietMs`.
 * The quiet window is driven purely by metadata events, so a command whose
 * subprocess the manager has not polled yet still resets it, and a terminal
 * that was closed while waiting counts as idle.
 */
const waitForTerminalIdle = Effect.fn("TerminalToolkit.waitForTerminalIdle")(function* (
  threadId: string,
  terminalId: string,
  timeoutMs: number,
  quietMs: number,
): Effect.fn.Return<
  TerminalIdleOutcome,
  TerminalSessionLookupError,
  TerminalManager.TerminalManager
> {
  const manager = yield* TerminalManager.TerminalManager;
  const events = yield* Queue.unbounded<TerminalMetadataStreamEvent>();
  const unsubscribe = yield* manager.subscribeMetadata((event) => {
    const matches =
      event.type === "snapshot" ||
      (event.type === "upsert"
        ? event.terminal.threadId === threadId && event.terminal.terminalId === terminalId
        : event.threadId === threadId && event.terminalId === terminalId);
    return matches ? Effect.asVoid(Queue.offer(events, event)) : Effect.void;
  });

  const latest: { terminal: TerminalSummary | null } = { terminal: null };
  const settle: Effect.Effect<"idle" | "missing"> = Effect.gen(function* () {
    // `subscribeMetadata` always delivers a full snapshot first.
    latest.terminal = applyMetadataEvent(yield* Queue.take(events), threadId, terminalId);
    if (!latest.terminal) return "missing";
    for (;;) {
      if (latest.terminal?.hasRunningSubprocess !== true) {
        const next = yield* Queue.take(events).pipe(Effect.timeoutOption(quietMs));
        if (Option.isNone(next)) return "idle";
        latest.terminal = applyMetadataEvent(next.value, threadId, terminalId);
        continue;
      }
      latest.terminal = applyMetadataEvent(yield* Queue.take(events), threadId, terminalId);
    }
  });

  const settled = yield* settle.pipe(
    Effect.timeoutOption(timeoutMs),
    Effect.ensuring(Effect.sync(unsubscribe)),
  );
  if (Option.isNone(settled)) {
    return { idle: false, timedOut: true, terminal: latest.terminal };
  }
  if (settled.value === "missing") {
    return yield* new TerminalSessionLookupError({ threadId, terminalId });
  }
  return { idle: true, timedOut: false, terminal: latest.terminal };
});

export const terminalToolkitHandlers = {
  terminal_open: Effect.fn("TerminalToolkit.terminal_open")(function* (
    input: TerminalOpenToolInput,
  ) {
    const threadId = yield* requireThreadId();
    const manager = yield* TerminalManager.TerminalManager;
    const existing = yield* readThreadTerminals(threadId);
    const terminalId =
      input.terminalId ?? nextTerminalId(existing.map((terminal) => terminal.terminalId));
    const snapshot = yield* manager.open({
      threadId,
      terminalId,
      cwd: input.cwd,
      ...(input.worktreePath === undefined ? {} : { worktreePath: input.worktreePath }),
      ...(input.cols === undefined ? {} : { cols: input.cols }),
      ...(input.rows === undefined ? {} : { rows: input.rows }),
    });
    const terminal = yield* findThreadTerminal(threadId, terminalId);
    return { terminalId, terminal: terminal ?? summaryFromSnapshot(snapshot) };
  }),

  terminal_write: Effect.fn("TerminalToolkit.terminal_write")(function* (
    input: TerminalWriteToolInput,
  ) {
    const threadId = yield* requireThreadId();
    const manager = yield* TerminalManager.TerminalManager;
    const endsWithNewline = input.data.endsWith("\n") || input.data.endsWith("\r");
    const submit = input.submit ?? true;
    const data = submit && !endsWithNewline ? `${input.data}\r` : input.data;
    yield* manager.write({ threadId, terminalId: input.terminalId, data });
    return { terminalId: input.terminalId, submitted: submit || endsWithNewline };
  }),

  terminal_read: Effect.fn("TerminalToolkit.terminal_read")(function* (
    input: TerminalReadToolInput,
  ) {
    const threadId = yield* requireThreadId();
    const snapshot = yield* readTerminalSnapshot(threadId, input.terminalId);
    const terminal = yield* findThreadTerminal(threadId, input.terminalId);
    const history =
      input.stripAnsi === false
        ? snapshot.history
        : stripTerminalControlSequences(snapshot.history);
    return {
      terminalId: input.terminalId,
      status: snapshot.status,
      hasRunningSubprocess: terminal?.hasRunningSubprocess ?? false,
      ...boundTerminalOutput(history, input.lines ?? TERMINAL_READ_DEFAULT_LINES),
    };
  }),

  terminal_list: Effect.fn("TerminalToolkit.terminal_list")(function* (
    input: TerminalListToolInput,
  ) {
    const threadId = yield* requireThreadId();
    const terminals = yield* readThreadTerminals(threadId);
    return {
      terminals:
        input.terminalId === undefined
          ? terminals
          : terminals.filter((terminal) => terminal.terminalId === input.terminalId),
    };
  }),

  terminal_wait: Effect.fn("TerminalToolkit.terminal_wait")(function* (
    input: TerminalWaitToolInput,
  ) {
    const threadId = yield* requireThreadId();
    const outcome = yield* waitForTerminalIdle(
      threadId,
      input.terminalId,
      input.timeoutMs ?? TERMINAL_WAIT_DEFAULT_TIMEOUT_MS,
      input.quietMs ?? TERMINAL_WAIT_DEFAULT_QUIET_MS,
    );
    return { terminalId: input.terminalId, ...outcome };
  }),

  terminal_close: Effect.fn("TerminalToolkit.terminal_close")(function* (
    input: TerminalCloseToolInput,
  ) {
    const threadId = yield* requireThreadId();
    const manager = yield* TerminalManager.TerminalManager;
    const terminal = yield* findThreadTerminal(threadId, input.terminalId);
    if (!terminal) {
      return { terminalId: input.terminalId, closed: false };
    }
    yield* manager.close({
      threadId,
      terminalId: input.terminalId,
      ...(input.deleteHistory === undefined ? {} : { deleteHistory: input.deleteHistory }),
    });
    return { terminalId: input.terminalId, closed: true };
  }),
} satisfies Parameters<typeof TerminalToolkit.toLayer>[0];

export const TerminalToolkitHandlersLive = TerminalToolkit.toLayer(terminalToolkitHandlers);
