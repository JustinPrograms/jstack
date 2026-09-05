import { bobAdapter } from "./bob/index.js";
import { claudeAdapter } from "./claude/index.js";
import { codexAdapter } from "./codex/index.js";
import {
  INSTALL_SCOPES,
  PLATFORM_TARGETS,
  TARGET_SELECTIONS,
  type InstallScope,
  type PlatformAdapter,
  type PlatformTarget,
  type TargetSelection,
} from "./types.js";

const ADAPTERS: Readonly<Record<PlatformTarget, PlatformAdapter>> = {
  claude: claudeAdapter,
  bob: bobAdapter,
  codex: codexAdapter,
};

export function parsePlatformTarget(value: string): TargetSelection {
  if (!TARGET_SELECTIONS.includes(value as TargetSelection)) {
    throw new TypeError(`Target must be one of: ${TARGET_SELECTIONS.join(", ")}`);
  }
  return value as TargetSelection;
}

export function parseInstallScope(value: string): InstallScope {
  if (!INSTALL_SCOPES.includes(value as InstallScope)) {
    throw new TypeError(`Scope must be one of: ${INSTALL_SCOPES.join(", ")}`);
  }
  return value as InstallScope;
}

export function expandPlatformTarget(selection: TargetSelection): readonly PlatformTarget[] {
  return selection === "all" ? [...PLATFORM_TARGETS] : [selection];
}

export const expandPlatformTargets = expandPlatformTarget;

export function getPlatformAdapter(target: PlatformTarget): PlatformAdapter {
  return ADAPTERS[target];
}

export function getPlatformAdapters(selection: TargetSelection): readonly PlatformAdapter[] {
  return expandPlatformTarget(selection).map((target) => getPlatformAdapter(target));
}

export { INSTALL_SCOPES, PLATFORM_TARGETS, TARGET_SELECTIONS } from "./types.js";
export type {
  AdapterPaths,
  DoctorReminder,
  DoctorReminderLevel,
  InstallScope,
  PlatformAdapter,
  PlatformProposal,
  PlatformTarget,
  ProposalKind,
  TargetSelection,
} from "./types.js";
