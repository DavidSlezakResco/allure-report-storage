import { sql, type ExpressionBuilder, type Kysely } from "kysely";

import type { AllureReportStorageDatabase, Report, ReportsTable } from "../model.js";
import type {
  CompleteReportResult,
  CreateOrUpdateDraftInput,
  CreateOrUpdateDraftResult,
  ListCompletedScopesQuery,
  ListHistoryQuery,
  ListReportsQuery,
  ListRetentionCandidatesQuery,
  ReportRepository,
  StaleBranchQuery,
} from "./api.js";

const nowIso = () => new Date().toISOString();

const toIsoString = (value: Date | string | null): string | null => {
  if (value === null) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
};

const MAX_DATE_TIME = 8_640_000_000_000_000;

const toRetentionThresholdIso = (query: ListRetentionCandidatesQuery): string => {
  const threshold = (query.now ?? new Date()).getTime() - (query.maxReportAgeMs ?? 0);
  const thresholdDate = new Date(threshold);

  if (!Number.isFinite(threshold) || Math.abs(threshold) > MAX_DATE_TIME || Number.isNaN(thresholdDate.getTime())) {
    throw new Error("Retention age threshold is outside supported Date range");
  }

  return thresholdDate.toISOString();
};

const mapRowToReport = (row: ReportsTable): Report => ({
  id: row.id,
  repo: row.repo,
  branch: row.branch,
  name: row.name,
  status: row.status,
  createdAt: toIsoString(row.created_at)!,
  updatedAt: toIsoString(row.updated_at)!,
  completedAt: toIsoString(row.completed_at),
});

export class KyselyReportRepository implements ReportRepository {
  constructor(protected readonly db: Kysely<AllureReportStorageDatabase>) {}

  async close(): Promise<void> {
    await this.db.destroy();
  }

  async findById(reportId: string): Promise<Report | null> {
    const row = await this.db.selectFrom("reports").selectAll().where("id", "=", reportId).executeTakeFirst();

    return row ? mapRowToReport(row) : null;
  }

  async createOrUpdateDraft(input: CreateOrUpdateDraftInput): Promise<CreateOrUpdateDraftResult> {
    const now = nowIso();
    const row = await this.db
      .insertInto("reports")
      .values({
        id: input.reportId,
        repo: input.repo,
        branch: input.branch,
        name: input.name ?? null,
        status: "draft",
        created_at: now,
        updated_at: now,
        completed_at: null,
      })
      .onConflict((oc) =>
        oc
          .column("id")
          .doUpdateSet((eb) => ({
            repo: eb.ref("excluded.repo"),
            branch: eb.ref("excluded.branch"),
            name: eb.ref("excluded.name"),
            updated_at: eb.ref("excluded.updated_at"),
          }))
          .where("reports.status", "!=", "completed"),
      )
      .returningAll()
      .executeTakeFirst();

    if (row) {
      return { report: mapRowToReport(row), conflict: false };
    }

    const existing = await this.findById(input.reportId);

    if (existing?.status === "completed") {
      return { report: null, conflict: true };
    }

    throw new Error(`Failed to create or update draft report "${input.reportId}"`);
  }

  async complete(reportId: string): Promise<CompleteReportResult> {
    const now = nowIso();

    const row = await this.db
      .updateTable("reports")
      .set({
        status: "completed",
        completed_at: now,
        updated_at: now,
      })
      .where("id", "=", reportId)
      .where("status", "=", "draft")
      .returningAll()
      .executeTakeFirst();

    if (row) {
      return { report: mapRowToReport(row), notFound: false, conflict: false };
    }

    const existing = await this.findById(reportId);

    if (!existing) {
      return { report: null, notFound: true, conflict: false };
    }

    return { report: null, notFound: false, conflict: true };
  }

  async delete(reportId: string): Promise<boolean> {
    const result = await this.db.deleteFrom("reports").where("id", "=", reportId).executeTakeFirst();

    return Number(result.numDeletedRows) > 0;
  }

  async deleteRetentionCandidate(report: Report): Promise<boolean> {
    if (report.completedAt === null) {
      return false;
    }

    const result = await this.db
      .deleteFrom("reports")
      .where("id", "=", report.id)
      .where("status", "=", "completed")
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("reports as newer_reports")
            .select("newer_reports.id")
            .whereRef("newer_reports.repo", "=", "reports.repo")
            .whereRef("newer_reports.branch", "=", "reports.branch")
            .where("newer_reports.status", "=", "completed")
            .where((innerEb) =>
              innerEb.or([
                innerEb("newer_reports.completed_at", ">", report.completedAt),
                innerEb.and([
                  innerEb("newer_reports.completed_at", "=", report.completedAt),
                  innerEb("newer_reports.id", ">", report.id),
                ]),
              ]),
            ),
        ),
      )
      .executeTakeFirst();

    return Number(result.numDeletedRows) > 0;
  }

  async listHistory(query: ListHistoryQuery): Promise<Report[]> {
    const branchRows = await this.selectCompletedBranchHistory(query.repo, query.branch, query.limit);

    if (query.branch === query.fallbackBranch) {
      return branchRows.map(mapRowToReport);
    }

    if (query.limit !== undefined && branchRows.length >= query.limit) {
      return branchRows.map(mapRowToReport);
    }

    const remaining = query.limit === undefined ? undefined : query.limit - branchRows.length;
    const oldestBranchRow = branchRows.at(-1);
    let fallbackQuery = this.db
      .selectFrom("reports")
      .selectAll()
      .where("status", "=", "completed")
      .where("repo", "=", query.repo)
      .where("branch", "=", query.fallbackBranch);

    if (oldestBranchRow?.completed_at) {
      fallbackQuery = fallbackQuery.where((eb) =>
        eb.or([
          eb("completed_at", "<", oldestBranchRow.completed_at),
          eb.and([eb("completed_at", "=", oldestBranchRow.completed_at), eb("id", "<", oldestBranchRow.id)]),
        ]),
      );
    }

    fallbackQuery = fallbackQuery.orderBy("completed_at", "desc").orderBy("id", "desc");

    if (remaining !== undefined) {
      fallbackQuery = fallbackQuery.limit(remaining);
    }

    const fallbackRows = await fallbackQuery.execute();

    return [...branchRows, ...fallbackRows].map(mapRowToReport);
  }

  async listCompleted(query: ListReportsQuery): Promise<Report[]> {
    let queryBuilder = this.db.selectFrom("reports").selectAll().where("status", "=", "completed");

    if (query.repo) {
      queryBuilder = queryBuilder.where("repo", "=", query.repo);
    }

    if (query.branch) {
      queryBuilder = queryBuilder.where("branch", "=", query.branch);
    }

    queryBuilder = queryBuilder.orderBy("completed_at", "desc").orderBy("id", "desc");

    if (query.limit !== undefined) {
      queryBuilder = queryBuilder.limit(query.limit);
    }

    const rows = await queryBuilder.execute();

    return rows.map(mapRowToReport);
  }

  async listRetentionCandidates(query: ListRetentionCandidatesQuery): Promise<Report[]> {
    if (query.maxReportsPerBranch === undefined && query.maxReportAgeMs === undefined) {
      return [];
    }

    let rankedReports = this.db
      .selectFrom("reports")
      .selectAll()
      .select(
        sql<number>`row_number() over (partition by repo, branch order by completed_at desc, id desc)`.as(
          "retention_rank",
        ),
      )
      .where("status", "=", "completed");

    if (query.repo) {
      rankedReports = rankedReports.where("repo", "=", query.repo);
    }

    if (query.branch) {
      rankedReports = rankedReports.where("branch", "=", query.branch);
    }

    const ageThreshold = query.maxReportAgeMs === undefined ? undefined : toRetentionThresholdIso(query);
    const rows = await this.db
      .selectFrom(rankedReports.as("ranked_reports"))
      .select(["id", "repo", "branch", "name", "status", "created_at", "updated_at", "completed_at"])
      .where("retention_rank", ">", 1)
      .where((eb) => {
        const predicates = [];

        if (query.maxReportsPerBranch !== undefined) {
          predicates.push(eb("retention_rank", ">", Math.max(query.maxReportsPerBranch, 1)));
        }

        if (ageThreshold !== undefined) {
          predicates.push(eb("completed_at", "<", ageThreshold));
        }

        return eb.or(predicates);
      })
      .orderBy("repo")
      .orderBy("branch")
      .orderBy("completed_at", "desc")
      .orderBy("id", "desc")
      .execute();

    return rows.map(mapRowToReport);
  }

  async listStaleBranchReports(query: StaleBranchQuery): Promise<Report[]> {
    const rows = await this.db
      .selectFrom("reports")
      .selectAll()
      .where((eb) =>
        eb.and([
          eb.exists(
            eb
              .selectFrom("reports as completed_reports")
              .select("completed_reports.id")
              .whereRef("completed_reports.repo", "=", "reports.repo")
              .whereRef("completed_reports.branch", "=", "reports.branch")
              .where("completed_reports.status", "=", "completed"),
          ),
          eb.not(eb.exists(this.selectFreshBranchReports(eb, query.thresholdIso))),
        ]),
      )
      .orderBy("repo")
      .orderBy("branch")
      // Drafts first, then completed reports oldest first, so the newest completed report is deleted last.
      .orderBy(sql`case when status = 'completed' then 1 else 0 end`)
      .orderBy("completed_at", "asc")
      .orderBy("id", "asc")
      .execute();

    return rows.map(mapRowToReport);
  }

  async deleteStaleBranchReport(report: Report, query: StaleBranchQuery): Promise<boolean> {
    const result = await this.db
      .deleteFrom("reports")
      .where("id", "=", report.id)
      .where("repo", "=", report.repo)
      .where("branch", "=", report.branch)
      .where((eb) => eb.not(eb.exists(this.selectFreshBranchReports(eb, query.thresholdIso))))
      .executeTakeFirst();

    return Number(result.numDeletedRows) > 0;
  }

  async listCompletedScopes(query: ListCompletedScopesQuery = {}): Promise<Array<{ branch: string; repo: string }>> {
    let builder = this.db
      .selectFrom("reports")
      .select(["repo", "branch"])
      .distinct()
      .where("status", "=", "completed");

    if (query.repo) {
      builder = builder.where("repo", "=", query.repo);
    }

    return builder.execute();
  }

  async findLatestByRepoAndBranch(repo: string, branch: string): Promise<Report | null> {
    const row = await this.db
      .selectFrom("reports")
      .selectAll()
      .where("status", "=", "completed")
      .where("repo", "=", repo)
      .where("branch", "=", branch)
      .orderBy("completed_at", "desc")
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();

    return row ? mapRowToReport(row) : null;
  }

  protected async ensureSchema(): Promise<void> {
    await this.db.schema
      .createTable("reports")
      .ifNotExists()
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("repo", "text", (column) => column.notNull())
      .addColumn("branch", "text", (column) => column.notNull())
      .addColumn("name", "text")
      .addColumn("status", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addColumn("completed_at", "text")
      .execute();

    await this.db.schema
      .createIndex("reports_completed_repo_branch_lookup_idx")
      .ifNotExists()
      .on("reports")
      .columns(["status", "repo", "branch", "completed_at"])
      .execute();

    await this.db.schema
      .createIndex("reports_completed_repo_branch_id_lookup_idx")
      .ifNotExists()
      .on("reports")
      .columns(["status", "repo", "branch", "completed_at", "id"])
      .execute();
  }

  private selectFreshBranchReports(eb: ExpressionBuilder<AllureReportStorageDatabase, "reports">, thresholdIso: string) {
    return eb
      .selectFrom("reports as fresh_reports")
      .select("fresh_reports.id")
      .whereRef("fresh_reports.repo", "=", "reports.repo")
      .whereRef("fresh_reports.branch", "=", "reports.branch")
      .where((innerEb) =>
        innerEb.or([
          innerEb.and([
            innerEb("fresh_reports.status", "=", "completed"),
            innerEb("fresh_reports.completed_at", ">=", thresholdIso),
          ]),
          innerEb.and([
            innerEb("fresh_reports.status", "=", "draft"),
            innerEb("fresh_reports.updated_at", ">=", thresholdIso),
          ]),
        ]),
      );
  }

  private async selectCompletedBranchHistory(repo: string, branch: string, limit?: number): Promise<ReportsTable[]> {
    let queryBuilder = this.db
      .selectFrom("reports")
      .selectAll()
      .where("status", "=", "completed")
      .where("repo", "=", repo)
      .where("branch", "=", branch)
      .orderBy("completed_at", "desc")
      .orderBy("id", "desc");

    if (limit !== undefined) {
      queryBuilder = queryBuilder.limit(limit);
    }

    return queryBuilder.execute();
  }
}
