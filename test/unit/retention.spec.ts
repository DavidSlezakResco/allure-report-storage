import { describe, expect, it, vi } from "vitest";

import type { StaticFileData, StaticFileStore } from "../../src/model.js";
import type { Repositories } from "../../src/repositories/api.js";
import { SqliteAccessTokenRepository } from "../../src/repositories/sqlite/accessTokens.js";
import { SqliteProjectRepository } from "../../src/repositories/sqlite/projects.js";
import { SqliteReportRepository } from "../../src/repositories/sqlite/reports.js";
import {
  cleanupReportRetention,
  cleanupReportRetentionScope,
  cleanupStaleBranches,
  parseRetentionPolicy,
} from "../../src/utils/retention.js";

const pauseForOrdering = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 2));
};

class MemoryFileStore implements StaticFileStore {
  deletedReportIds: string[] = [];

  constructor(private readonly failReportId?: string) {}

  async put(): Promise<void> {}

  async get(): Promise<Uint8Array<ArrayBuffer> | null> {
    return null;
  }

  async exists(): Promise<boolean> {
    return false;
  }

  async list(): Promise<string[]> {
    return [];
  }

  async delete(reportId: string): Promise<void> {
    if (reportId === this.failReportId) {
      throw new Error("file delete failed");
    }

    this.deletedReportIds.push(reportId);
  }

  async putHistory(_reportId: string, _data: StaticFileData): Promise<void> {}

  async getHistory(): Promise<Uint8Array<ArrayBuffer> | null> {
    return null;
  }

  async deleteHistory(): Promise<void> {}

  async putAsset(): Promise<void> {}

  async getAsset(): Promise<Uint8Array<ArrayBuffer> | null> {
    return null;
  }
}

describe("report retention", () => {
  it("continues cleanup when one candidate file delete fails", async () => {
    const repository = await SqliteReportRepository.create({ databasePath: ":memory:" });
    const fileStore = new MemoryFileStore("retention-2");

    try {
      for (const reportId of ["retention-1", "retention-2", "retention-3"] as const) {
        await repository.createOrUpdateDraft({ branch: "main", repo: "qameta/allure-report-storage", reportId });
        await repository.complete(reportId);
        await pauseForOrdering();
      }

      await expect(
        cleanupReportRetentionScope({
          branch: "main",
          fileStore,
          policy: { maxReportsPerBranch: 1 },
          repo: "qameta/allure-report-storage",
          reportsRepository: repository,
        }),
      ).rejects.toThrow("report retention cleanup failed");

      expect(await repository.findById("retention-1")).toBeNull();
      expect(await repository.findById("retention-2")).toBeNull();
      expect(await repository.findById("retention-3")).not.toBeNull();
      expect(fileStore.deletedReportIds).toEqual(["retention-1"]);
    } finally {
      await repository.close();
    }
  });

  it("rejects retention age values outside supported Date range after conversion", () => {
    expect(() =>
      parseRetentionPolicy((name) => (name === "REPORT_RETENTION_MAX_REPORT_AGE_DAYS" ? "1e20" : undefined)),
    ).toThrow("REPORT_RETENTION_MAX_REPORT_AGE_DAYS must fit in supported Date range");
  });
});

describe("stale branch retention", () => {
  const REPO = "qameta/allure-report-storage";
  const OTHER_REPO = "qameta/other-report-storage";

  const withRepositories = async (
    run: (repositories: Repositories & { reports: SqliteReportRepository }) => Promise<void>,
  ): Promise<void> => {
    const repositories = {
      accessTokens: await SqliteAccessTokenRepository.create({ databasePath: ":memory:" }),
      projects: await SqliteProjectRepository.create({ databasePath: ":memory:" }),
      reports: await SqliteReportRepository.create({ databasePath: ":memory:" }),
    };

    try {
      await run(repositories);
    } finally {
      await Promise.all(Object.values(repositories).map((repository) => repository.close()));
    }
  };

  const publish = async (repository: SqliteReportRepository, reportId: string, branch: string, repo = REPO) => {
    await repository.createOrUpdateDraft({ branch, repo, reportId });
    await repository.complete(reportId);
    await pauseForOrdering();
  };

  // Everything touched before the returned cutoff is stale for a sweep at `cutoff + STALE_MS`.
  const markCutoff = async (): Promise<Date> => {
    await pauseForOrdering();
    const cutoff = new Date();
    await pauseForOrdering();

    return cutoff;
  };

  const STALE_MS = 60_000;

  it("parses stale branch options", () => {
    const env: Record<string, string> = {
      REPORT_RETENTION_PROTECTED_BRANCHES: " main, ,dev ,release ",
      REPORT_RETENTION_STALE_BRANCH_DAYS: "14",
      REPORT_RETENTION_STALE_BRANCH_DRY_RUN: "TRUE",
    };

    expect(parseRetentionPolicy((name) => env[name])).toEqual({
      protectedBranches: ["main", "dev", "release"],
      staleBranchAgeMs: 14 * 24 * 60 * 60 * 1000,
      staleBranchDryRun: true,
    });
    expect(() => parseRetentionPolicy((name) => (name === "REPORT_RETENTION_STALE_BRANCH_DAYS" ? "0" : undefined))).toThrow(
      "REPORT_RETENTION_STALE_BRANCH_DAYS must be a positive number",
    );
    expect(() =>
      parseRetentionPolicy((name) => (name === "REPORT_RETENTION_STALE_BRANCH_DRY_RUN" ? "yes" : undefined)),
    ).toThrow("REPORT_RETENTION_STALE_BRANCH_DRY_RUN must be true or false");
  });

  it("deletes every report of stale branches and keeps main, protected, and active branches", async () => {
    await withRepositories(async (repositories) => {
      const fileStore = new MemoryFileStore();
      const reports = repositories.reports;

      await repositories.projects.upsertMainBranch({ mainBranch: "trunk", repo: OTHER_REPO });
      await publish(reports, "main-1", "main");
      await publish(reports, "feature-1", "feature");
      await publish(reports, "feature-2", "feature");
      await publish(reports, "dev-1", "dev");
      await publish(reports, "abandoned-1", "abandoned");
      await reports.createOrUpdateDraft({ branch: "abandoned", repo: REPO, reportId: "abandoned-draft" });
      await publish(reports, "busy-1", "busy");
      await publish(reports, "other-trunk-1", "trunk", OTHER_REPO);
      await publish(reports, "other-main-1", "main", OTHER_REPO);

      const cutoff = await markCutoff();

      await publish(reports, "fresh-1", "fresh");
      await reports.createOrUpdateDraft({ branch: "busy", repo: REPO, reportId: "busy-draft" });

      const deletedIds = await cleanupStaleBranches({
        fileStore,
        mainBranch: "main",
        now: new Date(cutoff.getTime() + STALE_MS),
        policy: { protectedBranches: ["dev"], staleBranchAgeMs: STALE_MS },
        repositories,
      });
      const expectedDeleted = ["abandoned-draft", "abandoned-1", "feature-1", "feature-2", "other-main-1"];

      expect(deletedIds).toEqual(expectedDeleted);
      expect(fileStore.deletedReportIds).toEqual(expectedDeleted);

      for (const reportId of expectedDeleted) {
        expect(await reports.findById(reportId)).toBeNull();
      }

      for (const reportId of ["main-1", "dev-1", "busy-1", "busy-draft", "fresh-1", "other-trunk-1"]) {
        expect(await reports.findById(reportId)).not.toBeNull();
      }
    });
  });

  it("only logs stale branches in dry run", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    try {
      await withRepositories(async (repositories) => {
        const fileStore = new MemoryFileStore();

        await publish(repositories.reports, "feature-1", "feature");

        const cutoff = await markCutoff();
        const deletedIds = await cleanupReportRetention({
          fileStore,
          now: new Date(cutoff.getTime() + STALE_MS),
          policy: { staleBranchAgeMs: STALE_MS, staleBranchDryRun: true },
          repositories,
        });

        expect(deletedIds).toEqual([]);
        expect(fileStore.deletedReportIds).toEqual([]);
        expect(await repositories.reports.findById("feature-1")).not.toBeNull();
        expect(info).toHaveBeenCalledWith(
          `stale branch retention: would delete 1 reports of ${REPO}/feature: feature-1`,
        );
      });
    } finally {
      info.mockRestore();
    }
  });

  it("does not delete a report once its branch receives a newer report", async () => {
    await withRepositories(async ({ reports }) => {
      await publish(reports, "feature-1", "feature");

      const cutoff = await markCutoff();
      const staleReport = await reports.findById("feature-1");

      await publish(reports, "feature-2", "feature");

      expect(await reports.deleteStaleBranchReport(staleReport!, { thresholdIso: cutoff.toISOString() })).toBe(false);
      expect(await reports.findById("feature-1")).not.toBeNull();
    });
  });
});
