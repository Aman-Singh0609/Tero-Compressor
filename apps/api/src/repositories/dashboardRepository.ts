import { db } from '../db/prisma';
import { instrument } from '../lib/timing';

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/**
 * Dashboard aggregation: a handful of grouped queries run in parallel rather than one query per widget.
 * Counts and sums are computed in MySQL with conditional aggregation.
 */
const repo = {
  async getStats(now: Date) {
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const weekAgo = new Date(startOfToday.getTime() - 6 * 86_400_000);
    const fourteenDaysAgo = new Date(startOfToday.getTime() - 13 * 86_400_000);
    const client = db();
    // MySQL stores UTC; group uploads by the local calendar day so the chart agrees with "uploads today".
    const offsetMinutes = -now.getTimezoneOffset();
    const sign = offsetMinutes < 0 ? '-' : '+';
    const abs = Math.abs(offsetMinutes);
    const tzOffset = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;

    const [uploadRows, jobRows, opRows, categoryRows, dailyRows, recentUploads, recentFailures] = await Promise.all([
      client.$queryRaw<Array<Record<string, unknown>>>`
        SELECT COUNT(*) AS total,
               COALESCE(SUM(createdAt >= ${startOfToday}), 0) AS today,
               COALESCE(SUM(createdAt >= ${weekAgo}), 0) AS week
        FROM File WHERE role = 'UPLOAD'`,
      client.$queryRaw<Array<Record<string, unknown>>>`
        SELECT COUNT(*) AS total,
               COALESCE(SUM(status = 'COMPLETED'), 0) AS completed,
               COALESCE(SUM(status = 'FAILED'), 0) AS failed,
               COALESCE(SUM(status IN ('QUEUED','PROCESSING')), 0) AS active,
               COALESCE(SUM(CASE WHEN status = 'COMPLETED' THEN originalSizeBytes END), 0) AS inputBytes,
               COALESCE(SUM(CASE WHEN status = 'COMPLETED' THEN outputSizeBytes END), 0) AS outputBytes,
               COALESCE(SUM(CASE WHEN status = 'COMPLETED' AND outputSizeBytes < originalSizeBytes
                                 THEN originalSizeBytes - outputSizeBytes END), 0) AS savedBytes,
               AVG(CASE WHEN status = 'COMPLETED' THEN processingDurationMs END) AS avgDurationMs
        FROM ProcessingJob`,
      client.$queryRaw<Array<Record<string, unknown>>>`
        SELECT operation, COUNT(*) AS count FROM ProcessingJob GROUP BY operation ORDER BY count DESC`,
      client.$queryRaw<Array<Record<string, unknown>>>`
        SELECT category, COUNT(*) AS count FROM File WHERE role = 'UPLOAD' GROUP BY category ORDER BY count DESC`,
      client.$queryRaw<Array<Record<string, unknown>>>`
        SELECT DATE(CONVERT_TZ(createdAt, '+00:00', ${tzOffset})) AS day, COUNT(*) AS count FROM File
        WHERE role = 'UPLOAD' AND createdAt >= ${fourteenDaysAgo}
        GROUP BY day ORDER BY day`,
      client.file.findMany({
        where: { role: 'UPLOAD' },
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: { id: true, originalName: true, category: true, sizeBytes: true, status: true, createdAt: true },
      }),
      client.processingJob.findMany({
        where: { status: 'FAILED' },
        orderBy: { failedAt: 'desc' },
        take: 8,
        select: {
          id: true,
          operation: true,
          errorCode: true,
          errorMessage: true,
          failedAt: true,
          file: { select: { id: true, originalName: true } },
        },
      }),
    ]);

    const u = uploadRows[0] ?? {};
    const j = jobRows[0] ?? {};
    return {
      uploads: { total: num(u.total), today: num(u.today), thisWeek: num(u.week) },
      jobs: {
        total: num(j.total),
        completed: num(j.completed),
        failed: num(j.failed),
        active: num(j.active),
        inputBytes: num(j.inputBytes),
        outputBytes: num(j.outputBytes),
        savedBytes: num(j.savedBytes),
        avgDurationMs:
          j.avgDurationMs === null || j.avgDurationMs === undefined ? null : Math.round(num(j.avgDurationMs)),
      },
      operations: opRows.map((r) => ({ operation: String(r.operation), count: num(r.count) })),
      filesByCategory: categoryRows.map((r) => ({ category: String(r.category), count: num(r.count) })),
      uploadsByDay: dailyRows.map((r) => ({
        day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day),
        count: num(r.count),
      })),
      recentUploads,
      recentFailures,
    };
  },
};

export const dashboardRepository = instrument('DashboardRepository', repo);
