import { resolve } from "node:path";
import { readFactoryPhaseRunIdentity } from "./factory-phase-run.ts";
import type { FactoryRunMeta } from "./factory-run-context.ts";
import type { FactoryWorkItem } from "./factory-schemas.ts";
import type { FactoryStoreMeta } from "./factory-store.ts";

/** Authenticate terminal triage metadata without consulting a live workspace. */
export function assertFactoryTriageRunMetaIdentity(
  value: FactoryRunMeta,
  input: {
    runDir: string;
    workItem: FactoryWorkItem;
    factoryStore: FactoryStoreMeta;
  },
): void {
  if (value.status !== "completed" && value.status !== "failed")
    throw new Error(`Factory action metadata has no terminal provider status for ${value.runId}`);
  const identity = readFactoryPhaseRunIdentity(input.runDir);
  if (identity.phase !== "triage")
    throw new Error(`Factory phase is not triage: ${identity.phaseRunId}`);
  const valueStore = value.factoryStore;
  const profile = identity.actions.triageWorkItem;
  if (
    value.runId !== identity.phaseRunId ||
    resolve(value.runDir) !== resolve(input.runDir) ||
    value.workItem.id !== input.workItem.id ||
    value.workItem.source !== input.workItem.source ||
    value.workItem.title !== input.workItem.title ||
    !valueStore ||
    resolve(valueStore.factoryStateRoot) !== resolve(input.factoryStore.factoryStateRoot) ||
    valueStore.projectId !== input.factoryStore.projectId ||
    resolve(valueStore.projectRoot) !== resolve(input.factoryStore.projectRoot) ||
    valueStore.repo.id !== input.factoryStore.repo.id ||
    valueStore.repo.name !== input.factoryStore.repo.name ||
    valueStore.repo.idSource !== input.factoryStore.repo.idSource ||
    identity.projectId !== input.factoryStore.projectId ||
    identity.factoryStateRoot !== resolve(input.factoryStore.factoryStateRoot) ||
    value.agent.name !== profile.provider ||
    value.agent.model !== profile.model ||
    (profile.provider === "codex" &&
      (value.agent.sandboxMode !== profile.sandbox ||
        value.agent.approvalPolicy !== profile.approvalPolicy ||
        value.agent.modelReasoningEffort !== profile.reasoningEffort)) ||
    (profile.provider === "cursor" &&
      (value.agent.sandboxMode !== undefined ||
        value.agent.approvalPolicy !== undefined ||
        value.agent.modelReasoningEffort !== undefined))
  )
    throw new Error(`Completed Factory run metadata conflicts with ${identity.phaseRunId}`);
}
