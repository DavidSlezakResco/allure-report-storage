import type { Report, RetentionPolicy, StaticFileStore } from "../model.js";
import type { ReportRepository, Repositories } from "../repositories/api.js";
import { createErrorLog } from "./error.js";
import { normalizeMainBranch } from "./http.js";

const MAX_DATE_TIME = 8_640_000_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const hasBranchRetention = (policy: RetentionPolicy): boolean =>
  policy.maxReportsPerBranch !== undefined || policy.maxReportAgeMs !== undefined;

export const isRetentionEnabled = (policy: RetentionPolicy): boolean =>
  hasBranchRetention(policy) || policy.staleBranchAgeMs !== undefined;

const deleteReportAndFiles = async (
  fileStore: StaticFileStore,
  reportsRepository: ReportRepository,
  report: Report,
): Promise<boolean> => {
  const latest = await reportsRepository.findLatestByRepoAndBranch(report.repo, report.branch);

  if (!latest || latest.id === report.id) {
    return false;
  }

  const deleted = await reportsRepository.deleteRetentionCandidate(report);

  if (!deleted) {
    return false;
  }

  await Promise.all([fileStore.delete(report.id), fileStore.deleteHistory(report.id)]);

  return true;
};

const cleanupCandidates = async (
  fileStore: StaticFileStore,
  reportsRepository: ReportRepository,
  candidates: Report[],
): Promise<string[]> => {
  const deletedIds: string[] = [];
  const failures: Error[] = [];

  for (const report of candidates) {
    try {
      if (await deleteReportAndFiles(fileStore, reportsRepository, report)) {
        deletedIds.push(report.id);
      }
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));

      console.error(createErrorLog(`report retention cleanup failed for report "${report.id}"`, error));
      failures.push(error);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, "report retention cleanup failed");
  }

  return deletedIds;
};

export const cleanupReportRetentionScope = async (input: {
  branch: string;
  fileStore: StaticFileStore;
  policy: RetentionPolicy;
  repo: string;
  reportsRepository: ReportRepository;
  now?: Date;
}): Promise<string[]> => {
  if (!hasBranchRetention(input.policy)) {
    return [];
  }

  const candidates = await input.reportsRepository.listRetentionCandidates({
    branch: input.branch,
    maxReportAgeMs: input.policy.maxReportAgeMs,
    maxReportsPerBranch: input.policy.maxReportsPerBranch,
    now: input.now,
    repo: input.repo,
  });
  return cleanupCandidates(input.fileStore, input.reportsRepository, candidates);
};

const toStaleThresholdIso = (now: Date, staleBranchAgeMs: number): string => {
  const threshold = now.getTime() - staleBranchAgeMs;

  if (!Number.isFinite(threshold) || Math.abs(threshold) > MAX_DATE_TIME) {
    throw new Error("Stale branch retention threshold is outside supported Date range");
  }

  return new Date(threshold).toISOString();
};

export const cleanupStaleBranches = async (input: {
  fileStore: StaticFileStore;
  mainBranch?: string;
  now?: Date;
  policy: RetentionPolicy;
  repositories: Pick<Repositories, "projects" | "reports">;
}): Promise<string[]> => {
  if (input.policy.staleBranchAgeMs === undefined) {
    return [];
  }

  const query = { thresholdIso: toStaleThresholdIso(input.now ?? new Date(), input.policy.staleBranchAgeMs) };
  const reportsRepository = input.repositories.reports;
  const defaultMainBranch = normalizeMainBranch(input.mainBranch);
  const protectedBranches = new Set(input.policy.protectedBranches ?? []);
  const mainBranches = new Map<string, string>();
  const staleBranches = new Map<string, Report[]>();

  for (const report of await reportsRepository.listStaleBranchReports(query)) {
    let mainBranch = mainBranches.get(report.repo);

    if (mainBranch === undefined) {
      mainBranch = (await input.repositories.projects.findByRepo(report.repo))?.mainBranch ?? defaultMainBranch;
      mainBranches.set(report.repo, mainBranch);
    }

    if (report.branch === mainBranch || protectedBranches.has(report.branch)) {
      continue;
    }

    const key = JSON.stringify([report.repo, report.branch]);
    const branchReports = staleBranches.get(key) ?? [];

    branchReports.push(report);
    staleBranches.set(key, branchReports);
  }

  const deletedIds: string[] = [];
  const failures: Error[] = [];

  for (const branchReports of staleBranches.values()) {
    const { branch, repo } = branchReports[0];
    const scope = `${repo}/${branch}`;

    if (input.policy.staleBranchDryRun) {
      console.info(
        `stale branch retention: would delete ${branchReports.length} reports of ${scope}: ${branchReports.map((report) => report.id).join(", ")}`,
      );
      continue;
    }

    let deletedCount = 0;

    // Reports are ordered oldest first; stop at the first failure so the branch keeps its newest report.
    for (const report of branchReports) {
      try {
        if (!(await reportsRepository.deleteStaleBranchReport(report, query))) {
          break;
        }

        await Promise.all([input.fileStore.delete(report.id), input.fileStore.deleteHistory(report.id)]);
        deletedIds.push(report.id);
        deletedCount += 1;
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));

        console.error(createErrorLog(`stale branch retention failed for report "${report.id}"`, error));
        failures.push(error);
        break;
      }
    }

    console.info(`stale branch retention: deleted ${deletedCount} reports of ${scope}`);
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, "stale branch retention failed");
  }

  return deletedIds;
};

export const cleanupReportRetention = async (input: {
  fileStore: StaticFileStore;
  mainBranch?: string;
  now?: Date;
  policy: RetentionPolicy;
  repositories: Repositories;
}): Promise<string[]> => {
  const deletedIds: string[] = [];
  const failures: unknown[] = [];

  if (hasBranchRetention(input.policy)) {
    try {
      const candidates = await input.repositories.reports.listRetentionCandidates({
        maxReportAgeMs: input.policy.maxReportAgeMs,
        maxReportsPerBranch: input.policy.maxReportsPerBranch,
        now: input.now,
      });

      deletedIds.push(...(await cleanupCandidates(input.fileStore, input.repositories.reports, candidates)));
    } catch (error) {
      failures.push(error);
    }
  }

  try {
    deletedIds.push(...(await cleanupStaleBranches(input)));
  } catch (error) {
    failures.push(error);
  }

  if (failures.length === 1) {
    throw failures[0];
  }

  if (failures.length > 1) {
    throw new AggregateError(failures, "report retention cleanup failed");
  }

  return deletedIds;
};

const parseDays = (name: string, rawValue: string): number => {
  const value = Number(rawValue);

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }

  const ms = value * DAY_MS;

  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_DATE_TIME) {
    throw new Error(`${name} must fit in supported Date range`);
  }

  return ms;
};

export const parseRetentionPolicy = (getValue: (name: string) => string | undefined): RetentionPolicy => {
  const countValue = getValue("REPORT_RETENTION_MAX_REPORTS_PER_BRANCH")?.trim();
  const ageDaysValue = getValue("REPORT_RETENTION_MAX_REPORT_AGE_DAYS")?.trim();
  const staleDaysValue = getValue("REPORT_RETENTION_STALE_BRANCH_DAYS")?.trim();
  const protectedValue = getValue("REPORT_RETENTION_PROTECTED_BRANCHES")?.trim();
  const dryRunValue = getValue("REPORT_RETENTION_STALE_BRANCH_DRY_RUN")?.trim().toLowerCase();
  const policy: RetentionPolicy = {};

  if (countValue) {
    const value = Number(countValue);

    if (!Number.isInteger(value) || value <= 0) {
      throw new Error("REPORT_RETENTION_MAX_REPORTS_PER_BRANCH must be a positive integer");
    }

    policy.maxReportsPerBranch = value;
  }

  if (ageDaysValue) {
    policy.maxReportAgeMs = parseDays("REPORT_RETENTION_MAX_REPORT_AGE_DAYS", ageDaysValue);
  }

  if (staleDaysValue) {
    policy.staleBranchAgeMs = parseDays("REPORT_RETENTION_STALE_BRANCH_DAYS", staleDaysValue);
  }

  if (protectedValue) {
    const branches = protectedValue
      .split(",")
      .map((branch) => branch.trim())
      .filter(Boolean);

    if (branches.length > 0) {
      policy.protectedBranches = branches;
    }
  }

  if (dryRunValue) {
    if (dryRunValue !== "true" && dryRunValue !== "false") {
      throw new Error("REPORT_RETENTION_STALE_BRANCH_DRY_RUN must be true or false");
    }

    policy.staleBranchDryRun = dryRunValue === "true";
  }

  return policy;
};
