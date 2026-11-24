import { readProcessStartedAt } from "./hot-restart.js";
import { readLeaseReleaseDeferral } from "./environment-lease-release-deferral.js";
import { runUsedConversationAdapter } from "./conversation-continuation.js";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { hasNativeLocalProcessStop } from "./native-local-process-stop.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { isCancelledNativeStartup } from "./cancelled-native-startup.js";
import { executionStartedEventPredicate } from "./pre-dispatch-execution-evidence.js";
import { hasRequiredWorkspaceRecovery } from "./workspace-restore-recovery-state.js";

type Run = typeof heartbeatRuns.$inferSelect;

/** The executor's own record that this run ended before its adapter ran.
 * "preparing" means cancellation caught the run before the controller
 * committed "dispatching", but a bare stage is not a receipt: only the
 * startup-cancellation record the executor writes on that path is. Cancellation
 * cleanup rewrites the stage to "settled" whether or not the run dispatched, so
 * a settled run needs its own marker: the adapter-entry marker, a recovery
 * record that says no provider work started, or a stale continuation cancelled
 * before selection. A recognised pre-dispatch wait is upstream's
 * `isCancelledNativeStartup` to prove, not this one. */
function recordedPreDispatchOutcome(run: Run) {
  const result = run.resultJson ?? {};
  const settlement = result.legacyDispatchSettlement as Record<string, unknown> | undefined;
  const recovery = result.executionRecovery as Record<string, unknown> | undefined;
  const startup = result.startupCancellation as Record<string, unknown> | undefined;
  if (run.executionStage === "preparing") return startup != null;
  if (run.executionStage !== "settled") return false;
  return settlement?.adapterEntered === false || recovery?.providerWorkStarted === false ||
    startup?.errorCode === "continuation_task_ownership_changed";
}

/** A legacy controller commits "dispatching" in the lease renewal that admits
 * the adapter, and that renewal only matches a running row. A cancelled run
 * that recorded a pre-dispatch outcome, holds no retained execution evidence
 * and left no environment lease therefore never reached its adapter and never
 * can. Without this, every adapter other than paperclip_runner that was stopped
 * during setup blocked its agent's pause forever. The retained-evidence list
 * mirrors `isCancelledNativeStartup`: a resolved runtime mode, a native or
 * remote workspace handle, or an unsettled saved-file obligation all contradict
 * "never dispatched". The caller has already required the controller lease to
 * be expired. */
async function isCancelledBeforeLegacyDispatch(db: Db, run: Run) {
  if (run.status !== "cancelled" || run.runtimeMode !== "legacy" || run.runtimeModeResolvedAt ||
      run.processPid || run.processGroupId || run.processStartedAt || run.sessionIdAfter ||
      run.nativeIssueId || run.nativeSessionId) return false;
  if (run.runnerProfileJson?.nativeExecutionInput != null || run.runnerProfileJson?.nativeWorkspaceSync != null ||
      run.runnerProfileJson?.remoteWorkspace != null) return false;
  if (run.resultJson?.workspaceRestoreFailure != null || hasRequiredWorkspaceRecovery(run.resultJson)) return false;
  if (!recordedPreDispatchOutcome(run)) return false;
  const [execution] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id), executionStartedEventPredicate(),
  )).limit(1);
  if (execution) return false;
  // A finalization row requires nativeIssueId, already excluded above.
  const [lease] = await db.select({ id: environmentLeases.id }).from(environmentLeases)
    .where(eq(environmentLeases.heartbeatRunId, run.id)).limit(1);
  return !lease;
}

/** Cancellation changes admission. Process and lease evidence controls cleanup. */
export async function agentExecutionsHaveStopped(db: Db, agentIds: string[]) {
  return (await agentExecutionStopBlocker(db, agentIds)) === null;
}

export async function agentExecutionStopBlocker(db: Db, agentIds: string[]): Promise<string | null> {
  if (!agentIds.length) return null;
  const runs = await db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.agentId, agentIds));
  const runIds = db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(inArray(heartbeatRuns.agentId, agentIds));
  const leases = await db.select().from(environmentLeases).where(or(
    inArray(environmentLeases.heartbeatRunId, runIds),
    inArray(sql`${environmentLeases.metadata}->>'agentId'`, agentIds),
  ));
  const deferred = leases.find(lease => lease.status === "active" && readLeaseReleaseDeferral(lease.metadata));
  if (deferred) return `environment_lease_release_deferred:${readLeaseReleaseDeferral(deferred.metadata)!.reason}`;
  if (leases.some(lease => (!lease.releasedAt && !(lease.status === "retained" && lease.cleanupStatus === "success")) || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed")) return "environment_lease_unreleased";
  const coordinators = await db.select().from(nativeRunFinalizations)
    .where(inArray(nativeRunFinalizations.runId, runIds));
  const now = new Date();
  const abandoned = coordinators.filter(row => row.leaseOwner);
  if (abandoned.some(row => !row.leaseExpiresAt || row.leaseExpiresAt > now || row.resultId ||
      runs.find(run => run.id === row.runId)?.status !== "cancelled")) return "native_finalization_owned";
  const absent = (pid: number) => {
    try { process.kill(pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  };
  for (const coordinator of abandoned) {
    if (!coordinator.controllerPid || absent(coordinator.controllerPid)) continue;
    const observed = await readProcessStartedAt(coordinator.controllerPid).catch(() => null);
    if (!observed || !coordinator.controllerProcessStartedAt ||
        new Date(observed).getTime() === coordinator.controllerProcessStartedAt.getTime()) return "native_controller_alive";
  }
  for (const run of runs) {
    if (!["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(run.status)) return "run_not_terminal";
    if (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date()) return "run_controller_lease_held";
    const runLeases = leases.filter(lease => lease.heartbeatRunId === run.id);
    if (runLeases.some(lease => lease.provider && lease.provider !== "local")) {
      if (run.status === "cancelled" && !runLeases.every(hasRemoteTerminationReceipt)) return "remote_stop_unconfirmed";
      continue;
    }
    let processAlive = Boolean(run.processPid && !absent(run.processPid));
    let groupAlive = Boolean(run.processGroupId && !absent(-run.processGroupId));
    if (processAlive && run.processStartedAt) {
      const observed = await readProcessStartedAt(run.processPid!).catch(() => null);
      if (observed && new Date(observed).getTime() !== run.processStartedAt.getTime()) {
        processAlive = false;
        if (run.processGroupId === run.processPid) groupAlive = false;
      }
    }
    if (processAlive || groupAlive) return "run_process_alive";
    if (run.status !== "cancelled" || !run.startedAt) continue;
    if (run.runtimeMode === "native" && !run.processPid && !run.processGroupId &&
        !await hasNativeLocalProcessStop(db, run.companyId, run.id) &&
        !await isCancelledNativeStartup(db, run, coordinators.find(row => row.runId === run.id))) return "native_stop_unproven";
    if (run.runtimeMode === "legacy" && !run.processPid && !run.processGroupId &&
        (run.resultJson?.executionCancellation as Record<string, unknown> | undefined)?.state !== "acknowledged" &&
        !(run.executionStage === "settled" && !await runUsedConversationAdapter(db, run)) &&
        !await isCancelledBeforeLegacyDispatch(db, run) &&
        !await isCancelledNativeStartup(db, run, coordinators.find(row => row.runId === run.id))) return "legacy_stop_unproven";
  }
  // Release an expired owner only after its cancelled execution has stop proof.
  for (const coordinator of abandoned) {
    const [cleared] = await db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
      .where(and(eq(nativeRunFinalizations.runId, coordinator.runId),
        eq(nativeRunFinalizations.leaseOwner, coordinator.leaseOwner!),
        sql`date_trunc('milliseconds', ${nativeRunFinalizations.leaseExpiresAt}) = ${coordinator.leaseExpiresAt!.toISOString()}::timestamptz`,
        eq(nativeRunFinalizations.controllerGeneration, coordinator.controllerGeneration),
        eq(nativeRunFinalizations.phase, coordinator.phase), isNull(nativeRunFinalizations.resultId)))
      .returning({ runId: nativeRunFinalizations.runId });
    if (!cleared) return "native_finalization_release_raced";
  }
  return null;
}
