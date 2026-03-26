import React, { useEffect, useMemo, useState } from "react";
import { collection, getDocs } from "firebase/firestore";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ROLES } from "../constants/roles";
import { db } from "../firebase";
import {
  buildChildOutcomeReport,
  buildPopulationAutoSuggestionRateSeries,
  buildPopulationSummary,
  computeOutcomeMetrics,
  formatDateKey,
  formatSignedPercent,
  getDailyAutoSuggestionRateSeries,
  normalizeChildSnapshot,
  recentDayKeys,
  toDateLike,
} from "../lib/outcomeMetrics";

function toCsv(rows = []) {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const safe = String(cell ?? "");
          if (safe.includes(",") || safe.includes("\n") || safe.includes('"')) {
            return `"${safe.replace(/"/g, '""')}"`;
          }
          return safe;
        })
        .join(",")
    )
    .join("\n");
}

function downloadTextFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(objectUrl);
}

function normalizeFilterValue(value, fallback = "unassigned") {
  const parsed = String(value ?? "").trim();
  return parsed || fallback;
}

function sumNumericMap(values = {}) {
  return Object.values(values ?? {}).reduce((sum, value) => {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) && parsed > 0 ? sum + parsed : sum;
  }, 0);
}

function getRoleLabels(value) {
  const raw = Array.isArray(value) ? value : [value];
  const roles = raw
    .map((entry) => String(entry ?? "").trim().toLowerCase())
    .filter(Boolean);
  if (roles.length === 0) return ["parent"];
  return [...new Set(roles)];
}

function formatRoleLabels(value) {
  return getRoleLabels(value)
    .map((role) => role.replace(/_/g, " "))
    .join(", ");
}

function getChildDailyAttempts(child = {}, keys = []) {
  const counts = child?.preferences?.dailySentenceCounts ?? {};
  return keys.reduce((sum, key) => sum + Number(counts[key] ?? 0), 0);
}

function getChildLastActiveDate(child = {}) {
  const directCandidates = [child?.stats?.lastActive, child?.updatedAt]
    .map((value) => toDateLike(value))
    .filter(Boolean);

  const eventCandidates = [];
  const events = Array.isArray(child?.model?.sentenceEvents)
    ? child.model.sentenceEvents
    : Array.isArray(child?.smartModel?.sentenceEvents)
      ? child.smartModel.sentenceEvents
      : [];

  events.forEach((entry) => {
    if (!entry || typeof entry !== "object") return;
    const stamp = toDateLike(entry.ts);
    if (stamp) eventCandidates.push(stamp);
  });

  const all = [...directCandidates, ...eventCandidates];
  if (all.length === 0) return null;
  return all.sort((a, b) => b.getTime() - a.getTime())[0];
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatCompactNumber(value, decimals = 2) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return "0";
  return parsed.toFixed(decimals);
}

function getDateKeyOffset(offsetDays = 0, now = new Date()) {
  const date = new Date(now);
  date.setDate(now.getDate() - Number(offsetDays ?? 0));
  return formatDateKey(date);
}

function getDefaultFixedBaselineRange(periodDays = 30, now = new Date()) {
  const safePeriod = Math.max(7, Math.round(periodDays));
  return {
    startKey: getDateKeyOffset(safePeriod * 2 - 1, now),
    endKey: getDateKeyOffset(safePeriod, now),
  };
}

function downloadBinaryFile(filename, bytes, mimeType) {
  const safeBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  const blob = new Blob([safeBytes], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(objectUrl);
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  const safeBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  let crc = 0xffffffff;
  for (let i = 0; i < safeBytes.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ safeBytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function getDosDateTime(date = new Date()) {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  const month = Math.min(12, Math.max(1, date.getMonth() + 1));
  const day = Math.min(31, Math.max(1, date.getDate()));
  const hours = Math.min(23, Math.max(0, date.getHours()));
  const minutes = Math.min(59, Math.max(0, date.getMinutes()));
  const seconds = Math.min(59, Math.max(0, date.getSeconds()));

  const dosTime = (hours << 11) | (minutes << 5) | Math.floor(seconds / 2);
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  return { dosTime, dosDate };
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new TextEncoder().encode(String(value ?? ""));
}

function concatBytes(chunks = []) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  chunks.forEach((chunk) => {
    out.set(chunk, offset);
    offset += chunk.length;
  });
  return out;
}

function buildZipArchive(entries = []) {
  const encoder = new TextEncoder();
  const localChunks = [];
  const centralChunks = [];
  let localOffset = 0;

  entries.forEach((entry) => {
    const nameBytes = encoder.encode(String(entry?.name ?? "file.txt"));
    const dataBytes = toBytes(entry?.bytes ?? "");
    const checksum = crc32(dataBytes);
    const size = dataBytes.length;
    const { dosTime, dosDate } = getDosDateTime(new Date());

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, dosTime, true);
    localView.setUint16(12, dosDate, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, size, true);
    localView.setUint32(22, size, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    localChunks.push(localHeader, dataBytes);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, dosTime, true);
    centralView.setUint16(14, dosDate, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, size, true);
    centralView.setUint32(24, size, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, localOffset, true);
    centralHeader.set(nameBytes, 46);
    centralChunks.push(centralHeader);

    localOffset += localHeader.length + size;
  });

  const centralDirBytes = concatBytes(centralChunks);
  const localBytes = concatBytes(localChunks);
  const endRecord = new Uint8Array(22);
  const endView = new DataView(endRecord.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralDirBytes.length, true);
  endView.setUint32(16, localBytes.length, true);
  endView.setUint16(20, 0, true);

  return concatBytes([localBytes, centralDirBytes, endRecord]);
}

function toPdfAscii(text) {
  return String(text ?? "").replace(/[^\x20-\x7E]/g, "?");
}

function escapePdfText(value) {
  return toPdfAscii(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function wrapText(text, maxChars = 92) {
  const source = toPdfAscii(text).trim();
  if (!source) return [""];
  const words = source.split(/\s+/);
  const lines = [];
  let current = "";
  words.forEach((word) => {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
      return;
    }
    if (current) lines.push(current);
    current = word;
  });
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [source.slice(0, maxChars)];
}

function createSimplePdfFromLines(lines = [], title = "Report") {
  const bodyLines = [title, "", ...lines].flatMap((line) => wrapText(line));
  const linesPerPage = 48;
  const pages = [];
  for (let index = 0; index < bodyLines.length; index += linesPerPage) {
    pages.push(bodyLines.slice(index, index + linesPerPage));
  }
  if (pages.length === 0) pages.push(["No data"]);

  const objects = [];
  const pageObjectIds = [];
  let nextObjectId = 3;

  pages.forEach((pageLines) => {
    const pageId = nextObjectId;
    const contentId = nextObjectId + 1;
    pageObjectIds.push(pageId);
    nextObjectId += 2;

    const contentParts = ["BT\n", "/F1 11 Tf\n", "50 760 Td\n"];
    pageLines.forEach((line, lineIndex) => {
      if (lineIndex > 0) contentParts.push("0 -14 Td\n");
      contentParts.push(`(${escapePdfText(line)}) Tj\n`);
    });
    contentParts.push("ET\n");
    const streamText = contentParts.join("");
    const streamLength = new TextEncoder().encode(streamText).length;

    objects[contentId] = `<< /Length ${streamLength} >>\nstream\n${streamText}endstream`;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 ${nextObjectId} 0 R >> >> /Contents ${contentId} 0 R >>`;
  });

  const fontObjectId = nextObjectId;
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageObjectIds.length} >>`;
  objects[fontObjectId] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  const encoder = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let byteOffset = 0;
  const append = (text) => {
    chunks.push(text);
    byteOffset += encoder.encode(text).length;
  };

  append("%PDF-1.4\n");
  for (let objectId = 1; objectId <= fontObjectId; objectId += 1) {
    offsets[objectId] = byteOffset;
    append(`${objectId} 0 obj\n${objects[objectId] ?? "<<>>"}\nendobj\n`);
  }

  const xrefOffset = byteOffset;
  append(`xref\n0 ${fontObjectId + 1}\n`);
  append("0000000000 65535 f \n");
  for (let objectId = 1; objectId <= fontObjectId; objectId += 1) {
    append(`${String(offsets[objectId]).padStart(10, "0")} 00000 n \n`);
  }
  append(`trailer\n<< /Size ${fontObjectId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
  return encoder.encode(chunks.join(""));
}

function tokenizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function aggregateAttemptSeries(children = [], days = 30, now = new Date()) {
  const keys = recentDayKeys(days, now);
  return keys.map((key) => {
    const total = children.reduce((sum, child) => {
      const dailyCounts = child?.preferences?.dailySentenceCounts ?? {};
      return sum + Number(dailyCounts[key] ?? 0);
    }, 0);
    return { key, label: key.slice(5), value: total };
  });
}

function aggregateUniqueWordSeries(children = [], days = 30, now = new Date()) {
  const keys = recentDayKeys(days, now);
  const tokenSets = new Map(keys.map((key) => [key, new Set()]));

  children.forEach((child) => {
    const modelEvents = Array.isArray(child?.model?.sentenceEvents)
      ? child.model.sentenceEvents
      : Array.isArray(child?.smartModel?.sentenceEvents)
        ? child.smartModel.sentenceEvents
        : [];

    modelEvents.forEach((entry) => {
      if (!entry || typeof entry !== "object") return;
      const text = String(entry.text ?? "").trim();
      if (!text) return;
      const stamp = toDateLike(entry.ts);
      if (!stamp) return;
      const key = `${stamp.getFullYear()}-${String(stamp.getMonth() + 1).padStart(2, "0")}-${String(stamp.getDate()).padStart(2, "0")}`;
      if (!tokenSets.has(key)) return;
      const target = tokenSets.get(key);
      tokenizeText(text).forEach((token) => target.add(token));
    });
  });

  return keys.map((key) => ({
    key,
    label: key.slice(5),
    value: tokenSets.get(key)?.size ?? 0,
  }));
}

function aggregateSentenceLengthSeries(children = [], days = 30, now = new Date()) {
  const keys = recentDayKeys(days, now);
  const map = new Map(keys.map((key) => [key, { sum: 0, count: 0 }]));

  children.forEach((child) => {
    const modelEvents = Array.isArray(child?.model?.sentenceEvents)
      ? child.model.sentenceEvents
      : Array.isArray(child?.smartModel?.sentenceEvents)
        ? child.smartModel.sentenceEvents
        : [];

    modelEvents.forEach((entry) => {
      if (!entry || typeof entry !== "object") return;
      const text = String(entry.text ?? "").trim();
      if (!text) return;
      const stamp = toDateLike(entry.ts);
      if (!stamp) return;
      const key = `${stamp.getFullYear()}-${String(stamp.getMonth() + 1).padStart(2, "0")}-${String(stamp.getDate()).padStart(2, "0")}`;
      if (!map.has(key)) return;
      const tokens = tokenizeText(text);
      if (tokens.length === 0) return;
      const current = map.get(key);
      current.sum += tokens.length;
      current.count += 1;
    });
  });

  return keys.map((key) => {
    const current = map.get(key) ?? { sum: 0, count: 0 };
    return {
      key,
      label: key.slice(5),
      value: current.count > 0 ? current.sum / current.count : 0,
    };
  });
}

function buildPopulationInsights(children = [], summary = null) {
  if (!summary || children.length === 0) {
    return ["No population data loaded yet."];
  }

  const improvedCount = children.filter((entry) => Number(entry.outcomes?.attemptsPerDayDelta ?? 0) >= 0.3).length;
  const lowEngagementCount = children.filter((entry) => Number(entry.outcomes?.recentAttemptsPerDay ?? 0) < 1).length;
  const avgSuggestionAcceptance =
    children.reduce((sum, entry) => sum + Number(entry.outcomes?.suggestionAcceptanceRate ?? 0), 0) /
    Math.max(1, children.length);
  const fasterChildren = children.filter((entry) => Number(entry.outcomes?.timeToCommunicateDelta ?? 0) <= -0.2).length;

  return [
    `${Math.round((improvedCount / Math.max(1, children.length)) * 100)}% of children improved communication attempts by at least 30%.`,
    `${lowEngagementCount} children have low engagement and may require outreach.`,
    `Average suggestion acceptance is ${Math.round(avgSuggestionAcceptance * 100)}% across the selected cohort.`,
    `${fasterChildren} children improved time-to-communicate by 20% or more.`,
  ];
}

function buildPopulationAlerts(children = []) {
  const alerts = [];
  const highRisk = children.filter((entry) => Boolean(entry.outcomes?.highRisk));
  if (highRisk.length > 0) {
    alerts.push(`${highRisk.length} high-risk children flagged by trend-based risk scoring.`);
  }

  const inactive = children.filter((entry) => {
    const lastActiveRaw = entry?.stats?.lastActive;
    const lastActive = toDateLike(lastActiveRaw);
    if (!lastActive) return false;
    const daysSince = (Date.now() - lastActive.getTime()) / (24 * 60 * 60 * 1000);
    return daysSince >= 7;
  });
  if (inactive.length > 0) {
    alerts.push(`${inactive.length} children appear inactive for 7+ days.`);
  }

  const regressing = children.filter((entry) => Number(entry.outcomes?.attemptsPerDayDelta ?? 0) < -0.2);
  if (regressing.length > 0) {
    alerts.push(`${regressing.length} children show declining communication attempts.`);
  }

  if (alerts.length === 0) {
    alerts.push("No critical alerts detected in the selected cohort.");
  }

  return alerts;
}

function openPrintableReport(title, sections = []) {
  const printWindow = window.open("", "_blank", "noopener,noreferrer,width=1000,height=760");
  if (!printWindow) return;

  const htmlSections = sections
    .map((section) => {
      const heading = String(section?.heading ?? "").trim();
      const lines = Array.isArray(section?.lines) ? section.lines : [];
      const escapedLines = lines
        .map((line) => String(line).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"))
        .join("<br />");
      return `
        <section>
          ${heading ? `<h2>${heading}</h2>` : ""}
          <p>${escapedLines}</p>
        </section>
      `;
    })
    .join("");

  printWindow.document.write(`
    <html>
      <head>
        <title>${title}</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; padding: 24px; color: #163a60; }
          h1 { margin: 0 0 10px; }
          h2 { margin: 18px 0 8px; font-size: 16px; }
          p { margin: 0; line-height: 1.6; }
          section { border: 1px solid #d4deef; border-radius: 10px; background: #f7f9ff; padding: 12px; margin-bottom: 10px; }
        </style>
      </head>
      <body>
        <h1>${title}</h1>
        ${htmlSections}
      </body>
    </html>
  `);
  printWindow.document.close();
  printWindow.focus();
  window.setTimeout(() => {
    printWindow.print();
  }, 150);
}

export default function AdminPage() {
  const { roles, signOut, hasAnyRole } = useAuth();
  const isSuperAdmin = hasAnyRole([ROLES.SUPER_ADMIN]);
  const [populationChildrenRaw, setPopulationChildrenRaw] = useState([]);
  const [populationUsersRaw, setPopulationUsersRaw] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [pmpmInput, setPmpmInput] = useState("10");
  const [dateRange, setDateRange] = useState("monthly");
  const [anchorDateKey, setAnchorDateKey] = useState(() => getDateKeyOffset(0));
  const [baselineMode, setBaselineMode] = useState("rolling");
  const [baselineStartKey, setBaselineStartKey] = useState(() => getDefaultFixedBaselineRange(30).startKey);
  const [baselineEndKey, setBaselineEndKey] = useState(() => getDefaultFixedBaselineRange(30).endKey);
  const [ageFilter, setAgeFilter] = useState("all");
  const [diagnosisFilter, setDiagnosisFilter] = useState("all");
  const [therapistFilter, setTherapistFilter] = useState("all");
  const [regionFilter, setRegionFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedChildKey, setSelectedChildKey] = useState("");

  const periodDays = dateRange === "weekly" ? 7 : 30;
  const dateRangeLabel = dateRange === "weekly" ? "Last 7 days" : "Last 30 days";
  const reportNow = useMemo(() => {
    const isDateKey = /^\d{4}-\d{2}-\d{2}$/.test(String(anchorDateKey ?? ""));
    if (!isDateKey) return new Date();
    const parsed = new Date(`${anchorDateKey}T12:00:00`);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }, [anchorDateKey]);
  const reportAnchorLabel = formatDateKey(reportNow);
  const normalizedFixedBaseline = useMemo(() => {
    const fallback = getDefaultFixedBaselineRange(periodDays, reportNow);
    const isDateKey = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""));
    let start = isDateKey(baselineStartKey) ? String(baselineStartKey) : fallback.startKey;
    let end = isDateKey(baselineEndKey) ? String(baselineEndKey) : fallback.endKey;
    if (start > end) {
      const temp = start;
      start = end;
      end = temp;
    }
    return {
      startKey: start,
      endKey: end,
    };
  }, [baselineStartKey, baselineEndKey, periodDays, reportNow]);
  const baselineSummaryLabel =
    baselineMode === "fixed"
      ? `Fixed baseline: ${normalizedFixedBaseline.startKey} to ${normalizedFixedBaseline.endKey}`
      : "Rolling baseline: previous period";
  const baselineOptions = useMemo(
    () => ({
      baselineMode,
      baselineStartKey: normalizedFixedBaseline.startKey,
      baselineEndKey: normalizedFixedBaseline.endKey,
      now: reportNow,
    }),
    [baselineMode, normalizedFixedBaseline, reportNow]
  );

  const populationChildren = useMemo(
    () =>
      populationChildrenRaw.map((entry) => ({
        ...entry,
        outcomes: computeOutcomeMetrics(entry, periodDays, baselineOptions),
        ageGroup: normalizeFilterValue(entry?.profile?.ageGroup ?? entry?.profile?.age),
        diagnosis: normalizeFilterValue(entry?.profile?.diagnosis),
        therapist: normalizeFilterValue(entry?.profile?.therapistName ?? entry?.profile?.therapistUid),
        region: normalizeFilterValue(entry?.profile?.region),
      })),
    [populationChildrenRaw, periodDays, baselineOptions]
  );

  const populationUsers = useMemo(
    () =>
      populationUsersRaw.map((entry) => ({
        uid: String(entry?.uid ?? "").trim(),
        email: String(entry?.email ?? "").trim(),
        displayName: String(entry?.displayName ?? "").trim(),
        roles: getRoleLabels(entry?.roles ?? entry?.role),
        rolesLabel: formatRoleLabels(entry?.roles ?? entry?.role),
        createdAt: toDateLike(entry?.createdAt),
      })),
    [populationUsersRaw]
  );

  const recent7Keys = useMemo(() => recentDayKeys(7, reportNow), [reportNow]);
  const recent14Keys = useMemo(() => recentDayKeys(14, reportNow), [reportNow]);

  const userActivityRows = useMemo(() => {
    const childrenByParent = new Map();
    populationChildren.forEach((child) => {
      const key = String(child?.parentUid ?? "").trim();
      if (!key) return;
      const bucket = childrenByParent.get(key) ?? [];
      bucket.push(child);
      childrenByParent.set(key, bucket);
    });

    return populationUsers.map((user) => {
      const children = childrenByParent.get(user.uid) ?? [];
      const attempts7d = children.reduce(
        (sum, child) => sum + getChildDailyAttempts(child, recent7Keys),
        0
      );
      const attemptsByDay = recent14Keys.reduce((map, key) => {
        map[key] = children.reduce((sum, child) => {
          const counts = child?.preferences?.dailySentenceCounts ?? {};
          return sum + Number(counts[key] ?? 0);
        }, 0);
        return map;
      }, {});
      const activeChildren7d = children.filter((child) => getChildDailyAttempts(child, recent7Keys) > 0).length;
      const highRiskChildren = children.filter((child) => Boolean(child?.outcomes?.highRisk)).length;

      const autoTotals = children.reduce(
        (acc, child) => {
          const learning =
            child?.model?.autoSentenceLearning ??
            child?.smartModel?.autoSentenceLearning ??
            {};
          acc.shown += sumNumericMap(learning.shownCounts ?? {});
          acc.accepted += sumNumericMap(learning.acceptedCounts ?? {});
          return acc;
        },
        { shown: 0, accepted: 0 }
      );
      const autoAcceptRate = autoTotals.shown > 0 ? autoTotals.accepted / autoTotals.shown : 0;

      const lastActiveCandidates = children
        .map((child) => getChildLastActiveDate(child))
        .filter(Boolean);
      const lastActive =
        lastActiveCandidates.length > 0
          ? lastActiveCandidates.sort((a, b) => b.getTime() - a.getTime())[0]
          : null;

      const activityLevel =
        attempts7d >= 35 ? "high" : attempts7d >= 8 ? "medium" : attempts7d > 0 ? "low" : "inactive";

      return {
        ...user,
        userLabel: user.displayName || user.email || user.uid || "Unknown user",
        childCount: children.length,
        attempts7d,
        attemptsByDay,
        activeChildren7d,
        highRiskChildren,
        autoAcceptRate,
        lastActive,
        activityLevel,
      };
    });
  }, [populationUsers, populationChildren, recent7Keys, recent14Keys]);

  const sortedUserActivityRows = useMemo(
    () =>
      [...userActivityRows].sort(
        (a, b) =>
          Number(b.attempts7d ?? 0) - Number(a.attempts7d ?? 0) ||
          Number(b.activeChildren7d ?? 0) - Number(a.activeChildren7d ?? 0) ||
          String(a.userLabel ?? "").localeCompare(String(b.userLabel ?? ""))
      ),
    [userActivityRows]
  );

  const superAdminSummary = useMemo(() => {
    const totalUsers = sortedUserActivityRows.length;
    const activeUsers7d = sortedUserActivityRows.filter((row) => Number(row.attempts7d ?? 0) > 0).length;
    const highActivityUsers = sortedUserActivityRows.filter((row) => row.activityLevel === "high").length;
    const totalAttempts7d = sortedUserActivityRows.reduce((sum, row) => sum + Number(row.attempts7d ?? 0), 0);
    const avgAttemptsPerActiveUser = totalAttempts7d / Math.max(1, activeUsers7d);
    const usersWithRiskChildren = sortedUserActivityRows.filter((row) => Number(row.highRiskChildren ?? 0) > 0).length;
    const nowMs = reportNow.getTime();
    const newUsers30d = sortedUserActivityRows.filter((row) => {
      if (!(row.createdAt instanceof Date)) return false;
      const daysSince = (nowMs - row.createdAt.getTime()) / (24 * 60 * 60 * 1000);
      return daysSince >= 0 && daysSince <= 30;
    }).length;

    return {
      totalUsers,
      activeUsers7d,
      highActivityUsers,
      totalAttempts7d,
      avgAttemptsPerActiveUser,
      usersWithRiskChildren,
      newUsers30d,
      activeRatePct: Math.round((activeUsers7d / Math.max(1, totalUsers)) * 100),
    };
  }, [sortedUserActivityRows, reportNow]);

  const superAdminTrendSeries = useMemo(
    () =>
      recent14Keys.map((key) => {
        const attempts = sortedUserActivityRows.reduce(
          (sum, row) => sum + Number(row.attemptsByDay?.[key] ?? 0),
          0
        );
        const activeUsers = sortedUserActivityRows.reduce(
          (sum, row) => sum + (Number(row.attemptsByDay?.[key] ?? 0) > 0 ? 1 : 0),
          0
        );
        return { key, label: key.slice(5), attempts, activeUsers };
      }),
    [recent14Keys, sortedUserActivityRows]
  );

  const filterOptions = useMemo(() => {
    const unique = (key) => [
      "all",
      ...new Set(populationChildren.map((entry) => normalizeFilterValue(entry?.[key]))),
    ];

    return {
      age: unique("ageGroup"),
      diagnosis: unique("diagnosis"),
      therapist: unique("therapist"),
      region: unique("region"),
    };
  }, [populationChildren]);

  const filteredPopulation = useMemo(() => {
    const search = String(searchQuery ?? "").trim().toLowerCase();
    return populationChildren.filter((entry) => {
      if (ageFilter !== "all" && entry.ageGroup !== ageFilter) return false;
      if (diagnosisFilter !== "all" && entry.diagnosis !== diagnosisFilter) return false;
      if (therapistFilter !== "all" && entry.therapist !== therapistFilter) return false;
      if (regionFilter !== "all" && entry.region !== regionFilter) return false;
      if (!search) return true;
      return (
        String(entry.name ?? "").toLowerCase().includes(search) ||
        String(entry.parentUid ?? "").toLowerCase().includes(search) ||
        String(entry.childId ?? "").toLowerCase().includes(search)
      );
    });
  }, [populationChildren, ageFilter, diagnosisFilter, therapistFilter, regionFilter, searchQuery]);

  const summary = useMemo(() => buildPopulationSummary(filteredPopulation), [filteredPopulation]);

  const sortedPopulation = useMemo(
    () =>
      [...filteredPopulation].sort((a, b) => {
        const riskDiff = Number(Boolean(b.outcomes?.highRisk)) - Number(Boolean(a.outcomes?.highRisk));
        if (riskDiff !== 0) return riskDiff;
        const deltaDiff = Number(b.outcomes?.attemptsPerDayDelta ?? 0) - Number(a.outcomes?.attemptsPerDayDelta ?? 0);
        if (deltaDiff !== 0) return deltaDiff;
        return String(a.name ?? "").localeCompare(String(b.name ?? ""));
      }),
    [filteredPopulation]
  );

  const selectedChild = useMemo(() => {
    if (sortedPopulation.length === 0) return null;
    const matched = sortedPopulation.find((entry) => `${entry.parentUid}::${entry.childId}` === selectedChildKey);
    return matched ?? sortedPopulation[0];
  }, [sortedPopulation, selectedChildKey]);

  const highRiskCases = summary.highRiskCases ?? [];

  const estimatedPmpm = Math.max(0, Number.parseFloat(pmpmInput) || 0);
  const monthlyRevenueEstimate = estimatedPmpm * summary.childCount;
  const annualRevenueEstimate = monthlyRevenueEstimate * 12;

  const attemptsSeries = useMemo(
    () => aggregateAttemptSeries(filteredPopulation, periodDays, reportNow),
    [filteredPopulation, periodDays, reportNow]
  );
  const uniqueWordsSeries = useMemo(
    () => aggregateUniqueWordSeries(filteredPopulation, periodDays, reportNow),
    [filteredPopulation, periodDays, reportNow]
  );
  const sentenceLengthSeries = useMemo(
    () => aggregateSentenceLengthSeries(filteredPopulation, periodDays, reportNow),
    [filteredPopulation, periodDays, reportNow]
  );
  const autoQualitySeries = useMemo(
    () => buildPopulationAutoSuggestionRateSeries(filteredPopulation, periodDays, reportNow),
    [filteredPopulation, periodDays, reportNow]
  );

  const populationInsights = useMemo(
    () => buildPopulationInsights(filteredPopulation, summary),
    [filteredPopulation, summary]
  );
  const populationAlerts = useMemo(
    () => buildPopulationAlerts(filteredPopulation),
    [filteredPopulation]
  );

  const maxAttemptValue = Math.max(1, ...attemptsSeries.map((entry) => Number(entry.value ?? 0)));
  const maxUniqueValue = Math.max(1, ...uniqueWordsSeries.map((entry) => Number(entry.value ?? 0)));
  const maxSentenceLengthValue = Math.max(1, ...sentenceLengthSeries.map((entry) => Number(entry.value ?? 0)));
  const maxSuperAdminAttemptValue = Math.max(
    1,
    ...superAdminTrendSeries.map((entry) => Number(entry.attempts ?? 0))
  );
  const maxSuperAdminActiveUsers = Math.max(
    1,
    ...superAdminTrendSeries.map((entry) => Number(entry.activeUsers ?? 0))
  );
  const autoQualityTotals = useMemo(
    () =>
      autoQualitySeries.reduce(
        (acc, entry) => {
          acc.shown += Number(entry.shown ?? 0);
          acc.accepted += Number(entry.accepted ?? 0);
          acc.ignored += Number(entry.ignored ?? 0);
          return acc;
        },
        { shown: 0, accepted: 0, ignored: 0 }
      ),
    [autoQualitySeries]
  );
  const autoAcceptRate = autoQualityTotals.shown > 0 ? autoQualityTotals.accepted / autoQualityTotals.shown : 0;
  const autoIgnoreRate = autoQualityTotals.shown > 0 ? autoQualityTotals.ignored / autoQualityTotals.shown : 0;
  const pilotComparisonRows = useMemo(() => {
    const safeCount = Math.max(1, filteredPopulation.length);
    const averageAcross = (readCurrent, readBaseline) => {
      const current =
        filteredPopulation.reduce((sum, entry) => sum + Number(readCurrent(entry) ?? 0), 0) / safeCount;
      const baseline =
        filteredPopulation.reduce((sum, entry) => sum + Number(readBaseline(entry) ?? 0), 0) / safeCount;
      const delta = baseline > 0 ? (current - baseline) / baseline : current > 0 ? 1 : 0;
      return { baseline, current, delta };
    };

    return [
      {
        key: "attempts",
        label: "Communication attempts/day",
        ...averageAcross(
          (entry) => entry.outcomes?.recentAttemptsPerDay,
          (entry) => entry.outcomes?.previousAttemptsPerDay
        ),
        unit: "",
        decimals: 2,
        better: "higher",
      },
      {
        key: "vocab",
        label: "Unique vocabulary",
        ...averageAcross(
          (entry) => entry.outcomes?.uniqueVocabularyRecent,
          (entry) => entry.outcomes?.uniqueVocabularyPrevious
        ),
        unit: " words",
        decimals: 0,
        better: "higher",
      },
      {
        key: "sentence_length",
        label: "Average sentence length",
        ...averageAcross(
          (entry) => entry.outcomes?.avgSentenceLengthRecent,
          (entry) => entry.outcomes?.avgSentenceLengthPrevious
        ),
        unit: " words",
        decimals: 1,
        better: "higher",
      },
      {
        key: "time_to_communicate",
        label: "Time to communicate",
        ...averageAcross(
          (entry) => Number(entry.outcomes?.avgTimeToCommunicateRecentMs ?? 0) / 1000,
          (entry) => Number(entry.outcomes?.avgTimeToCommunicatePreviousMs ?? 0) / 1000
        ),
        unit: "s",
        decimals: 2,
        better: "lower",
      },
    ];
  }, [filteredPopulation]);
  const pilotImprovementStats = useMemo(() => {
    const total = Math.max(1, filteredPopulation.length);
    const attemptsImproved = filteredPopulation.filter((entry) => Number(entry.outcomes?.attemptsPerDayDelta ?? 0) > 0).length;
    const vocabImproved = filteredPopulation.filter((entry) => Number(entry.outcomes?.uniqueVocabularyDelta ?? 0) > 0).length;
    const sentenceImproved = filteredPopulation.filter((entry) => Number(entry.outcomes?.avgSentenceLengthDelta ?? 0) > 0).length;
    const speedImproved = filteredPopulation.filter((entry) => Number(entry.outcomes?.timeToCommunicateDelta ?? 0) < 0).length;
    return {
      attemptsImprovedPct: Math.round((attemptsImproved / total) * 100),
      vocabImprovedPct: Math.round((vocabImproved / total) * 100),
      sentenceImprovedPct: Math.round((sentenceImproved / total) * 100),
      speedImprovedPct: Math.round((speedImproved / total) * 100),
    };
  }, [filteredPopulation]);

  const selectedAttemptsSeries = useMemo(
    () => (selectedChild ? aggregateAttemptSeries([selectedChild], periodDays, reportNow) : []),
    [selectedChild, periodDays, reportNow]
  );
  const selectedUniqueSeries = useMemo(
    () => (selectedChild ? aggregateUniqueWordSeries([selectedChild], periodDays, reportNow) : []),
    [selectedChild, periodDays, reportNow]
  );
  const selectedSentenceLengthSeries = useMemo(
    () => (selectedChild ? aggregateSentenceLengthSeries([selectedChild], periodDays, reportNow) : []),
    [selectedChild, periodDays, reportNow]
  );
  const selectedAutoQualitySeries = useMemo(
    () =>
      selectedChild
        ? getDailyAutoSuggestionRateSeries(
            selectedChild?.model?.autoSentenceLearning ?? selectedChild?.smartModel?.autoSentenceLearning ?? {},
            periodDays,
            reportNow
          )
        : [],
    [selectedChild, periodDays, reportNow]
  );
  const selectedMaxAttemptValue = Math.max(1, ...selectedAttemptsSeries.map((entry) => Number(entry.value ?? 0)));
  const selectedMaxUniqueValue = Math.max(1, ...selectedUniqueSeries.map((entry) => Number(entry.value ?? 0)));
  const selectedMaxSentenceLengthValue = Math.max(
    1,
    ...selectedSentenceLengthSeries.map((entry) => Number(entry.value ?? 0))
  );
  const selectedAutoTotals = useMemo(
    () =>
      selectedAutoQualitySeries.reduce(
        (acc, entry) => {
          acc.shown += Number(entry.shown ?? 0);
          acc.accepted += Number(entry.accepted ?? 0);
          acc.ignored += Number(entry.ignored ?? 0);
          return acc;
        },
        { shown: 0, accepted: 0, ignored: 0 }
      ),
    [selectedAutoQualitySeries]
  );
  const selectedAutoAcceptRate =
    selectedAutoTotals.shown > 0 ? selectedAutoTotals.accepted / selectedAutoTotals.shown : 0;
  const selectedAutoIgnoreRate =
    selectedAutoTotals.shown > 0 ? selectedAutoTotals.ignored / selectedAutoTotals.shown : 0;
  const selectedOutcomeText = useMemo(
    () =>
      selectedChild
        ? buildChildOutcomeReport({
            childName: selectedChild.name,
            periodDays,
            outcomes: selectedChild.outcomes,
          })
        : "No child selected.",
    [selectedChild, periodDays]
  );
  const selectedLastSync = toDateLike(selectedChild?.updatedAt ?? selectedChild?.stats?.lastActive ?? null);
  const selectedComparisonRows = useMemo(() => {
    if (!selectedChild) return [];
    const outcomes = selectedChild.outcomes ?? {};
    return [
      {
        key: "attempts",
        label: "Communication attempts/day",
        baseline: Number(outcomes.previousAttemptsPerDay ?? 0),
        current: Number(outcomes.recentAttemptsPerDay ?? 0),
        delta: Number(outcomes.attemptsPerDayDelta ?? 0),
        unit: "",
        decimals: 2,
        better: "higher",
      },
      {
        key: "vocab",
        label: "Unique vocabulary",
        baseline: Number(outcomes.uniqueVocabularyPrevious ?? 0),
        current: Number(outcomes.uniqueVocabularyRecent ?? 0),
        delta: Number(outcomes.uniqueVocabularyDelta ?? 0),
        unit: " words",
        decimals: 0,
        better: "higher",
      },
      {
        key: "sentence_length",
        label: "Average sentence length",
        baseline: Number(outcomes.avgSentenceLengthPrevious ?? 0),
        current: Number(outcomes.avgSentenceLengthRecent ?? 0),
        delta: Number(outcomes.avgSentenceLengthDelta ?? 0),
        unit: " words",
        decimals: 1,
        better: "higher",
      },
      {
        key: "time_to_communicate",
        label: "Time to communicate",
        baseline: Number(outcomes.avgTimeToCommunicatePreviousMs ?? 0) / 1000,
        current: Number(outcomes.avgTimeToCommunicateRecentMs ?? 0) / 1000,
        delta: Number(outcomes.timeToCommunicateDelta ?? 0),
        unit: "s",
        decimals: 2,
        better: "lower",
      },
    ];
  }, [selectedChild]);
  const selectedTrendRows = useMemo(
    () =>
      selectedAttemptsSeries.map((entry, index) => ({
        key: entry.key,
        attempts: Number(entry.value ?? 0),
        uniqueWords: Number(selectedUniqueSeries[index]?.value ?? 0),
        sentenceLength: Number(selectedSentenceLengthSeries[index]?.value ?? 0),
        autoShown: Number(selectedAutoQualitySeries[index]?.shown ?? 0),
        autoAcceptPct: Math.round(Number(selectedAutoQualitySeries[index]?.acceptRate ?? 0) * 100),
        autoIgnorePct: Math.round(Number(selectedAutoQualitySeries[index]?.ignoreRate ?? 0) * 100),
      })),
    [selectedAttemptsSeries, selectedUniqueSeries, selectedSentenceLengthSeries, selectedAutoQualitySeries]
  );

  async function loadPopulationData() {
    setLoading(true);
    setError("");
    try {
      const usersSnapshot = await getDocs(collection(db, "users"));
      const usersRaw = usersSnapshot.docs.map((userDoc) => ({
        uid: userDoc.id,
        ...(userDoc.data() ?? {}),
      }));
      const perUserChildren = await Promise.all(
        usersSnapshot.docs.map(async (userDoc) => {
          const parentUid = userDoc.id;
          const childrenSnapshot = await getDocs(collection(db, "users", parentUid, "children"));
          return childrenSnapshot.docs.map((childDoc) =>
            normalizeChildSnapshot(parentUid, childDoc.id, childDoc.data() ?? {}, [])
          );
        })
      );

      setPopulationUsersRaw(usersRaw);
      setPopulationChildrenRaw(perUserChildren.flat());
    } catch (loadError) {
      console.error("Failed to load population dashboard:", loadError);
      setError(loadError.message || "Unable to load population metrics.");
      setPopulationUsersRaw([]);
      setPopulationChildrenRaw([]);
    } finally {
      setLoading(false);
    }
  }

  function resetFixedBaselineRange() {
    const defaults = getDefaultFixedBaselineRange(periodDays, reportNow);
    setBaselineStartKey(defaults.startKey);
    setBaselineEndKey(defaults.endKey);
  }

  function exportPopulationCsv() {
    if (filteredPopulation.length === 0) return;

    const rows = [
      [
        "parent_uid",
        "child_id",
        "child_name",
        "report_anchor_date",
        "age_group",
        "diagnosis",
        "therapist",
        "region",
        "attempts_per_day",
        "attempt_delta_pct",
        "new_words",
        "avg_sentence_length",
        "avg_time_to_communicate_seconds",
        "baseline_mode",
        "baseline_start",
        "baseline_end",
        "suggestion_acceptance_pct",
        "suggestion_ignore_pct",
        "high_risk",
        "risk_flags",
      ],
      ...sortedPopulation.map((entry) => [
        entry.parentUid,
        entry.childId,
        entry.name,
        reportAnchorLabel,
        entry.ageGroup,
        entry.diagnosis,
        entry.therapist,
        entry.region,
        Number(entry.outcomes?.recentAttemptsPerDay ?? 0).toFixed(2),
        Math.round(Number(entry.outcomes?.attemptsPerDayDelta ?? 0) * 100),
        Math.round(Number(entry.outcomes?.newWordsInPeriod ?? 0)),
        Number(entry.outcomes?.avgSentenceLengthRecent ?? 0).toFixed(2),
        (Number(entry.outcomes?.avgTimeToCommunicateRecentMs ?? 0) / 1000).toFixed(2),
        String(entry.outcomes?.baselineMode ?? baselineMode),
        String(entry.outcomes?.baselineStartKey ?? ""),
        String(entry.outcomes?.baselineEndKey ?? ""),
        Math.round(Number(entry.outcomes?.suggestionAcceptanceRate ?? 0) * 100),
        Math.round(Number(entry.outcomes?.suggestionIgnoreRate ?? 0) * 100),
        entry.outcomes?.highRisk ? "yes" : "no",
        (entry.outcomes?.riskFlags ?? []).join("|"),
      ]),
    ];

    downloadTextFile(
      `mco-population-dashboard-${dateRange}-${Date.now()}.csv`,
      `${toCsv(rows)}\n`,
      "text/csv;charset=utf-8"
    );
  }

  function exportUserActivityCsv() {
    if (sortedUserActivityRows.length === 0) return;
    const rows = [
      [
        "user_uid",
        "name",
        "email",
        "roles",
        "children",
        "attempts_7d",
        "active_children_7d",
        "auto_accept_rate_pct",
        "high_risk_children",
        "last_active",
      ],
      ...sortedUserActivityRows.map((row) => [
        row.uid,
        row.userLabel,
        row.email,
        row.rolesLabel,
        row.childCount,
        row.attempts7d,
        row.activeChildren7d,
        Math.round(Number(row.autoAcceptRate ?? 0) * 100),
        row.highRiskChildren,
        row.lastActive instanceof Date ? row.lastActive.toISOString() : "",
      ]),
    ];

    downloadTextFile(
      `super-admin-user-activity-${dateRange}-${Date.now()}.csv`,
      `${toCsv(rows)}\n`,
      "text/csv;charset=utf-8"
    );
  }

  function buildExecutiveSummaryLines() {
    return [
      `Date range: ${dateRangeLabel}`,
      `Report anchor date: ${reportAnchorLabel}`,
      `Children: ${summary.childCount}`,
      `Avg improvement: ${summary.avgImprovementPct}%`,
      `Engagement rate: ${summary.engagementRatePct}%`,
      `Baseline mode: ${baselineMode}`,
      `Baseline window: ${baselineSummaryLabel}`,
      `High-risk cases: ${summary.highRiskCount}`,
      `Auto suggestion accept rate: ${Math.round(autoAcceptRate * 100)}%`,
      `Auto suggestion ignore rate: ${Math.round(autoIgnoreRate * 100)}%`,
      `Estimated PMPM monthly: $${Math.round(monthlyRevenueEstimate).toLocaleString()}`,
      `Estimated PMPM annual: $${Math.round(annualRevenueEstimate).toLocaleString()}`,
      "",
      "Population insights:",
      ...populationInsights.map((entry) => `- ${entry}`),
      "",
      "Risk alerts:",
      ...populationAlerts.map((entry) => `- ${entry}`),
    ];
  }

  function exportExecutiveSummary() {
    const lines = buildExecutiveSummaryLines();

    downloadTextFile(
      `mco-executive-summary-${dateRange}-${Date.now()}.txt`,
      `${lines.join("\n")}\n`,
      "text/plain;charset=utf-8"
    );
  }

  function exportExecutivePdf() {
    openPrintableReport("MCO Outcome Summary", [
      {
        heading: "Executive KPIs",
        lines: [
          `Date range: ${dateRangeLabel}`,
          `Report anchor date: ${reportAnchorLabel}`,
          `Children: ${summary.childCount}`,
          `Average improvement: ${summary.avgImprovementPct}%`,
          `Engagement rate: ${summary.engagementRatePct}%`,
          `Baseline mode: ${baselineMode}`,
          `Baseline window: ${baselineSummaryLabel}`,
          `High-risk cases: ${summary.highRiskCount}`,
          `Auto suggestion accept rate: ${Math.round(autoAcceptRate * 100)}%`,
          `Auto suggestion ignore rate: ${Math.round(autoIgnoreRate * 100)}%`,
        ],
      },
      {
        heading: "Population Insights",
        lines: populationInsights,
      },
      {
        heading: "Risk & Alerts",
        lines: populationAlerts,
      },
    ]);
  }

  function buildSelectedChildReportLines() {
    if (!selectedChild) return ["No child selected."];
    return [
      selectedOutcomeText,
      "",
      `Parent UID: ${selectedChild.parentUid}`,
      `Child ID: ${selectedChild.childId}`,
      `Report anchor date: ${reportAnchorLabel}`,
      `Age group: ${selectedChild.ageGroup}`,
      `Diagnosis: ${selectedChild.diagnosis}`,
      `Therapist: ${selectedChild.therapist}`,
      `Region: ${selectedChild.region}`,
      `Baseline mode: ${selectedChild.outcomes?.baselineMode ?? baselineMode}`,
      `Baseline window: ${(selectedChild.outcomes?.baselineStartKey ?? "") || "n/a"} to ${(selectedChild.outcomes?.baselineEndKey ?? "") || "n/a"}`,
      `Auto accept rate: ${Math.round(selectedAutoAcceptRate * 100)}%`,
      `Auto ignore rate: ${Math.round(selectedAutoIgnoreRate * 100)}%`,
      `Auto suggestions shown: ${Math.round(selectedAutoTotals.shown)}`,
      `Risk flags: ${(selectedChild?.outcomes?.riskFlags ?? []).join(", ") || "none"}`,
      `Last sync: ${selectedLastSync ? selectedLastSync.toLocaleString() : "Unknown"}`,
      "",
      "Baseline vs current:",
      ...selectedComparisonRows.map((row) => {
        const baseline = formatCompactNumber(row.baseline, row.decimals);
        const current = formatCompactNumber(row.current, row.decimals);
        return `- ${row.label}: ${baseline}${row.unit} -> ${current}${row.unit} (${formatSignedPercent(row.delta)})`;
      }),
    ];
  }

  function exportSelectedChildReport() {
    if (!selectedChild) return;
    const lines = buildSelectedChildReportLines();

    downloadTextFile(
      `mco-child-report-${selectedChild.parentUid}-${selectedChild.childId}-${dateRange}-${Date.now()}.txt`,
      `${lines.join("\n")}\n`,
      "text/plain;charset=utf-8"
    );
  }

  function exportSelectedChildPdf() {
    if (!selectedChild) return;
    const pdfBytes = buildSelectedChildPdfBytes();
    downloadBinaryFile(
      `mco-child-report-${selectedChild.parentUid}-${selectedChild.childId}-${dateRange}-${Date.now()}.pdf`,
      pdfBytes,
      "application/pdf"
    );
  }

  function buildSelectedChildPdfBytes() {
    const lines = buildSelectedChildReportLines();
    lines.push("");
    lines.push(`Selected trend rows (${dateRangeLabel}):`);
    selectedTrendRows.forEach((row) => {
      lines.push(
        `- ${row.key}: attempts ${row.attempts}, unique ${row.uniqueWords}, sentence ${formatCompactNumber(
          row.sentenceLength,
          2
        )}, auto shown ${row.autoShown}, auto accept ${row.autoAcceptPct}%, auto ignore ${row.autoIgnorePct}%`
      );
    });
    return createSimplePdfFromLines(lines, "Child Drilldown Report");
  }

  function buildPilotComparisonCsvRows() {
    return [
      [
        "parent_uid",
        "child_id",
        "child_name",
        "report_anchor_date",
        "baseline_mode",
        "baseline_start",
        "baseline_end",
        "attempts_baseline",
        "attempts_current",
        "attempts_delta_pct",
        "unique_vocab_baseline",
        "unique_vocab_current",
        "unique_vocab_delta_pct",
        "sentence_length_baseline",
        "sentence_length_current",
        "sentence_length_delta_pct",
        "time_to_communicate_baseline_s",
        "time_to_communicate_current_s",
        "time_to_communicate_delta_pct",
      ],
      ...sortedPopulation.map((entry) => [
        entry.parentUid,
        entry.childId,
        entry.name,
        reportAnchorLabel,
        String(entry.outcomes?.baselineMode ?? baselineMode),
        String(entry.outcomes?.baselineStartKey ?? ""),
        String(entry.outcomes?.baselineEndKey ?? ""),
        formatCompactNumber(entry.outcomes?.previousAttemptsPerDay ?? 0, 2),
        formatCompactNumber(entry.outcomes?.recentAttemptsPerDay ?? 0, 2),
        Math.round(Number(entry.outcomes?.attemptsPerDayDelta ?? 0) * 100),
        formatCompactNumber(entry.outcomes?.uniqueVocabularyPrevious ?? 0, 0),
        formatCompactNumber(entry.outcomes?.uniqueVocabularyRecent ?? 0, 0),
        Math.round(Number(entry.outcomes?.uniqueVocabularyDelta ?? 0) * 100),
        formatCompactNumber(entry.outcomes?.avgSentenceLengthPrevious ?? 0, 2),
        formatCompactNumber(entry.outcomes?.avgSentenceLengthRecent ?? 0, 2),
        Math.round(Number(entry.outcomes?.avgSentenceLengthDelta ?? 0) * 100),
        formatCompactNumber(Number(entry.outcomes?.avgTimeToCommunicatePreviousMs ?? 0) / 1000, 2),
        formatCompactNumber(Number(entry.outcomes?.avgTimeToCommunicateRecentMs ?? 0) / 1000, 2),
        Math.round(Number(entry.outcomes?.timeToCommunicateDelta ?? 0) * 100),
      ]),
    ];
  }

  function exportPilotComparisonCsv() {
    if (sortedPopulation.length === 0) return;
    const rows = buildPilotComparisonCsvRows();

    downloadTextFile(
      `mco-pilot-comparison-${dateRange}-${Date.now()}.csv`,
      `${toCsv(rows)}\n`,
      "text/csv;charset=utf-8"
    );
  }

  function exportPilotPacketZip() {
    if (!selectedChild || sortedPopulation.length === 0) return;
    const timestamp = Date.now();
    const executiveSummaryText = `${buildExecutiveSummaryLines().join("\n")}\n`;
    const pilotCsvText = `${toCsv(buildPilotComparisonCsvRows())}\n`;
    const selectedChildPdf = buildSelectedChildPdfBytes();

    const zipBytes = buildZipArchive([
      {
        name: `executive-summary-${dateRange}-${reportAnchorLabel}.txt`,
        bytes: executiveSummaryText,
      },
      {
        name: `pilot-comparison-${dateRange}-${reportAnchorLabel}.csv`,
        bytes: pilotCsvText,
      },
      {
        name: `selected-child-${selectedChild.parentUid}-${selectedChild.childId}-${reportAnchorLabel}.pdf`,
        bytes: selectedChildPdf,
      },
    ]);

    downloadBinaryFile(
      `mco-pilot-packet-${dateRange}-${timestamp}.zip`,
      zipBytes,
      "application/zip"
    );
  }

  useEffect(() => {
    loadPopulationData();
  }, []);

  useEffect(() => {
    if (sortedPopulation.length === 0) {
      if (selectedChildKey !== "") setSelectedChildKey("");
      return;
    }
    const exists = sortedPopulation.some((entry) => `${entry.parentUid}::${entry.childId}` === selectedChildKey);
    if (!exists) {
      setSelectedChildKey(`${sortedPopulation[0].parentUid}::${sortedPopulation[0].childId}`);
    }
  }, [sortedPopulation, selectedChildKey]);

  return (
    <div style={pageStyle}>
      <h1>Population Dashboard (MCO)</h1>
      <p style={subtitleStyle}>
        Is this reducing cost and improving outcomes? This view answers that with measurable communication metrics.
      </p>
      <p style={rolesStyle}>Current roles: {roles.join(", ")}</p>

      <section style={panelStyle}>
        <h2 style={panelHeadingStyle}>Header Controls</h2>
        <div style={headerFilterGridStyle}>
          <label style={labelStyle}>
            Date Range
            <select value={dateRange} onChange={(event) => setDateRange(event.target.value)} style={inputStyle}>
              <option value="weekly">Weekly (7 days)</option>
              <option value="monthly">Monthly (30 days)</option>
            </select>
          </label>
          <label style={labelStyle}>
            Report Anchor Date
            <input
              type="date"
              value={reportAnchorLabel}
              onChange={(event) => setAnchorDateKey(event.target.value)}
              style={inputStyle}
            />
          </label>
          <label style={labelStyle}>
            Baseline Mode
            <select value={baselineMode} onChange={(event) => setBaselineMode(event.target.value)} style={inputStyle}>
              <option value="rolling">Rolling previous period</option>
              <option value="fixed">Fixed date range</option>
            </select>
          </label>
          {baselineMode === "fixed" ? (
            <>
              <label style={labelStyle}>
                Baseline Start
                <input
                  type="date"
                  value={normalizedFixedBaseline.startKey}
                  onChange={(event) => setBaselineStartKey(event.target.value)}
                  style={inputStyle}
                />
              </label>
              <label style={labelStyle}>
                Baseline End
                <input
                  type="date"
                  value={normalizedFixedBaseline.endKey}
                  onChange={(event) => setBaselineEndKey(event.target.value)}
                  style={inputStyle}
                />
              </label>
            </>
          ) : null}
          <label style={labelStyle}>
            Age group
            <select value={ageFilter} onChange={(event) => setAgeFilter(event.target.value)} style={inputStyle}>
              {filterOptions.age.map((entry) => (
                <option key={`age-${entry}`} value={entry}>{entry}</option>
              ))}
            </select>
          </label>
          <label style={labelStyle}>
            Diagnosis
            <select value={diagnosisFilter} onChange={(event) => setDiagnosisFilter(event.target.value)} style={inputStyle}>
              {filterOptions.diagnosis.map((entry) => (
                <option key={`diagnosis-${entry}`} value={entry}>{entry}</option>
              ))}
            </select>
          </label>
          <label style={labelStyle}>
            Therapist
            <select value={therapistFilter} onChange={(event) => setTherapistFilter(event.target.value)} style={inputStyle}>
              {filterOptions.therapist.map((entry) => (
                <option key={`therapist-${entry}`} value={entry}>{entry}</option>
              ))}
            </select>
          </label>
          <label style={labelStyle}>
            Region
            <select value={regionFilter} onChange={(event) => setRegionFilter(event.target.value)} style={inputStyle}>
              {filterOptions.region.map((entry) => (
                <option key={`region-${entry}`} value={entry}>{entry}</option>
              ))}
            </select>
          </label>
          <label style={labelStyle}>
            Search child
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Name / parent UID / child ID"
              style={inputStyle}
            />
          </label>
        </div>
        <div style={navRowStyle}>
          <Link to="/app" style={linkStyle}>Titonova NeuroVoice</Link>
          <Link to="/therapist" style={linkStyle}>Therapist workspace</Link>
          <Link to="/mco" style={linkStyle}>MCO dashboard</Link>
          <button onClick={loadPopulationData} style={buttonStyle} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh Population"}
          </button>
          <button onClick={exportPopulationCsv} style={buttonStyle} disabled={filteredPopulation.length === 0}>
            Export Population CSV
          </button>
          <button onClick={exportPilotComparisonCsv} style={buttonStyle} disabled={filteredPopulation.length === 0}>
            Export Pilot Comparison CSV
          </button>
          <button onClick={exportExecutiveSummary} style={buttonStyle}>
            Export Executive Summary
          </button>
          <button onClick={exportExecutivePdf} style={buttonStyle}>
            Download PDF (Print)
          </button>
          <button onClick={exportSelectedChildReport} style={buttonStyle} disabled={!selectedChild}>
            Export Selected Child TXT
          </button>
          <button onClick={exportSelectedChildPdf} style={buttonStyle} disabled={!selectedChild}>
            Export Selected Child PDF
          </button>
          <button
            onClick={exportPilotPacketZip}
            style={buttonStyle}
            disabled={!selectedChild || filteredPopulation.length === 0}
          >
            Export Pilot Packet ZIP
          </button>
          {baselineMode === "fixed" ? (
            <button onClick={resetFixedBaselineRange} style={buttonStyle}>
              Reset Baseline Window
            </button>
          ) : null}
          <button onClick={signOut} style={buttonStyle}>Sign out</button>
        </div>
        <p style={metadataLineStyle}>
          Report anchor: {reportAnchorLabel} | Baseline configuration: {baselineSummaryLabel}
        </p>
      </section>

      {error ? <p style={errorStyle}>{error}</p> : null}

      <section style={panelStyle}>
        <h2 style={panelHeadingStyle}>Super Admin Activity Dashboard</h2>
        <p style={mutedStyle}>
          Global user activity across all accounts, including engagement, risk exposure, and adaptive AI quality.
        </p>
        {isSuperAdmin ? (
          <>
            <div style={navRowStyle}>
              <button onClick={exportUserActivityCsv} style={buttonStyle} disabled={sortedUserActivityRows.length === 0}>
                Export User Activity CSV
              </button>
            </div>
            <div style={metricGridStyle}>
              <div style={metricCardStyle}>
                <span style={metricLabelStyle}>Total users</span>
                <strong style={metricValueStyle}>{superAdminSummary.totalUsers}</strong>
              </div>
              <div style={metricCardStyle}>
                <span style={metricLabelStyle}>Active users (7d)</span>
                <strong style={metricValueStyle}>{superAdminSummary.activeUsers7d}</strong>
                <span style={metricHintStyle}>{superAdminSummary.activeRatePct}% active rate</span>
              </div>
              <div style={metricCardStyle}>
                <span style={metricLabelStyle}>Total attempts (7d)</span>
                <strong style={metricValueStyle}>{Math.round(superAdminSummary.totalAttempts7d)}</strong>
              </div>
              <div style={metricCardStyle}>
                <span style={metricLabelStyle}>Avg attempts / active user</span>
                <strong style={metricValueStyle}>{superAdminSummary.avgAttemptsPerActiveUser.toFixed(1)}</strong>
              </div>
              <div style={metricCardStyle}>
                <span style={metricLabelStyle}>High-activity users</span>
                <strong style={metricValueStyle}>{superAdminSummary.highActivityUsers}</strong>
              </div>
              <div style={metricCardStyle}>
                <span style={metricLabelStyle}>Users with risk cases</span>
                <strong style={metricValueStyle}>{superAdminSummary.usersWithRiskChildren}</strong>
              </div>
              <div style={metricCardStyle}>
                <span style={metricLabelStyle}>New users (30d)</span>
                <strong style={metricValueStyle}>{superAdminSummary.newUsers30d}</strong>
              </div>
            </div>

            <div style={chartSectionStyle}>
              <article style={chartCardStyle}>
                <strong style={chartTitleStyle}>Daily active users (14d)</strong>
                <div style={chartGridStyle}>
                  {superAdminTrendSeries.map((entry) => (
                    <div key={`super-active-${entry.key}`} style={barCellStyle} title={`${entry.key}: ${entry.activeUsers} users`}>
                      <div
                        style={{
                          ...barStyle,
                          height: `${Math.max(6, (Number(entry.activeUsers ?? 0) / maxSuperAdminActiveUsers) * 100)}%`,
                          background: "linear-gradient(180deg, #4c9bff, #2d66d8)",
                        }}
                      />
                      <span style={barLabelStyle}>{entry.label}</span>
                    </div>
                  ))}
                </div>
              </article>
              <article style={chartCardStyle}>
                <strong style={chartTitleStyle}>Daily communication attempts (14d)</strong>
                <div style={chartGridStyle}>
                  {superAdminTrendSeries.map((entry) => (
                    <div key={`super-attempt-${entry.key}`} style={barCellStyle} title={`${entry.key}: ${entry.attempts} attempts`}>
                      <div
                        style={{
                          ...barStyle,
                          height: `${Math.max(6, (Number(entry.attempts ?? 0) / maxSuperAdminAttemptValue) * 100)}%`,
                          background: "linear-gradient(180deg, #41d8a0, #1f9f6b)",
                        }}
                      />
                      <span style={barLabelStyle}>{entry.label}</span>
                    </div>
                  ))}
                </div>
              </article>
            </div>

            <div style={{ ...tableWrapperStyle, marginTop: 10 }}>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>User</th>
                    <th style={thStyle}>Role</th>
                    <th style={thStyle}>Children</th>
                    <th style={thStyle}>Attempts (7d)</th>
                    <th style={thStyle}>Active children</th>
                    <th style={thStyle}>Auto accept</th>
                    <th style={thStyle}>Risk cases</th>
                    <th style={thStyle}>Activity</th>
                    <th style={thStyle}>Last active</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedUserActivityRows.slice(0, 250).map((row) => (
                    <tr key={`user-activity-${row.uid}`} style={tableRowStyle}>
                      <td style={tdStyle}>
                        <div style={tablePrimaryTextStyle}>{row.userLabel}</div>
                        <div style={tableSecondaryTextStyle}>{row.uid}</div>
                      </td>
                      <td style={tdStyle}>{row.rolesLabel}</td>
                      <td style={tdStyle}>{row.childCount}</td>
                      <td style={tdStyle}>{Math.round(row.attempts7d)}</td>
                      <td style={tdStyle}>{row.activeChildren7d}</td>
                      <td style={tdStyle}>{Math.round(Number(row.autoAcceptRate ?? 0) * 100)}%</td>
                      <td style={tdStyle}>{row.highRiskChildren}</td>
                      <td style={tdStyle}>
                        <span style={activityPillStyle(row.activityLevel)}>{row.activityLevel}</span>
                      </td>
                      <td style={tdStyle}>{row.lastActive instanceof Date ? row.lastActive.toLocaleString() : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p style={superAdminNoticeStyle}>
            Super admin activity analytics are restricted. Assign the <strong>super_admin</strong> role to view global user activity.
          </p>
        )}
      </section>

      <section style={panelStyle}>
        <h2 style={panelHeadingStyle}>KPI Summary</h2>
        <div style={metricGridStyle}>
          <div style={metricCardStyle}>
            <span style={metricLabelStyle}>Engagement rate</span>
            <strong style={metricValueStyle}>{summary.engagementRatePct}%</strong>
          </div>
          <div style={metricCardStyle}>
            <span style={metricLabelStyle}>Communication improvement</span>
            <strong style={metricValueStyle}>{summary.avgImprovementPct}%</strong>
          </div>
          <div style={metricCardStyle}>
            <span style={metricLabelStyle}>Vocabulary growth</span>
            <strong style={metricValueStyle}>
              {Math.round(
                filteredPopulation.reduce((sum, entry) => sum + Number(entry.outcomes?.newWordsInPeriod ?? 0), 0) /
                  Math.max(1, filteredPopulation.length)
              )}
            </strong>
          </div>
          <div style={metricCardStyle}>
            <span style={metricLabelStyle}>Efficiency gain</span>
            <strong style={metricValueStyle}>
              {formatSignedPercent(
                filteredPopulation.length > 0
                  ? filteredPopulation.reduce((sum, entry) => sum + Number(entry.outcomes?.timeToCommunicateDelta ?? 0), 0) /
                      filteredPopulation.length
                  : 0
              )}
            </strong>
          </div>
          <div style={metricCardStyle}>
            <span style={metricLabelStyle}>Suggestion quality</span>
            <strong style={metricValueStyle}>
              {Math.round(autoAcceptRate * 100)}% / {Math.round(autoIgnoreRate * 100)}%
            </strong>
            <span style={metricHintStyle}>accept / ignore</span>
          </div>
        </div>
      </section>

      <section style={panelStyle}>
        <h2 style={panelHeadingStyle}>Pilot Evidence (Before vs After)</h2>
        <div style={pilotSummaryGridStyle}>
          <div style={metricCardStyle}>
            <span style={metricLabelStyle}>Attempts improved</span>
            <strong style={metricValueStyle}>{pilotImprovementStats.attemptsImprovedPct}%</strong>
          </div>
          <div style={metricCardStyle}>
            <span style={metricLabelStyle}>Vocabulary improved</span>
            <strong style={metricValueStyle}>{pilotImprovementStats.vocabImprovedPct}%</strong>
          </div>
          <div style={metricCardStyle}>
            <span style={metricLabelStyle}>Sentence length improved</span>
            <strong style={metricValueStyle}>{pilotImprovementStats.sentenceImprovedPct}%</strong>
          </div>
          <div style={metricCardStyle}>
            <span style={metricLabelStyle}>Faster communication</span>
            <strong style={metricValueStyle}>{pilotImprovementStats.speedImprovedPct}%</strong>
          </div>
        </div>
        <div style={comparisonGridStyle}>
          {pilotComparisonRows.map((row) => {
            const isPositive = row.better === "lower" ? row.delta <= 0 : row.delta >= 0;
            return (
              <article key={`pilot-${row.key}`} style={comparisonCardStyle}>
                <strong style={comparisonLabelStyle}>{row.label}</strong>
                <div style={comparisonRowStyle}>
                  <span>Baseline cohort avg</span>
                  <strong>{formatCompactNumber(row.baseline, row.decimals)}{row.unit}</strong>
                </div>
                <div style={comparisonRowStyle}>
                  <span>Current cohort avg</span>
                  <strong>{formatCompactNumber(row.current, row.decimals)}{row.unit}</strong>
                </div>
                <span style={comparisonDeltaStyle(isPositive)}>{formatSignedPercent(row.delta)}</span>
              </article>
            );
          })}
        </div>
      </section>

      <section style={panelStyle}>
        <h2 style={panelHeadingStyle}>Outcomes Trends ({dateRangeLabel})</h2>
        <div style={chartSectionStyle}>
          <article style={chartCardStyle}>
            <strong style={chartTitleStyle}>Communication attempts</strong>
            <div style={chartGridStyle}>
              {attemptsSeries.map((entry) => (
                <div key={`attempt-${entry.key}`} style={barCellStyle} title={`${entry.key}: ${entry.value}`}>
                  <div
                    style={{
                      ...barStyle,
                      height: `${Math.max(6, (Number(entry.value ?? 0) / maxAttemptValue) * 100)}%`,
                      background: "linear-gradient(180deg, #53a6ff, #2e6dff)",
                    }}
                  />
                  <span style={barLabelStyle}>{entry.label}</span>
                </div>
              ))}
            </div>
          </article>
          <article style={chartCardStyle}>
            <strong style={chartTitleStyle}>Unique vocabulary</strong>
            <div style={chartGridStyle}>
              {uniqueWordsSeries.map((entry) => (
                <div key={`unique-${entry.key}`} style={barCellStyle} title={`${entry.key}: ${entry.value}`}>
                  <div
                    style={{
                      ...barStyle,
                      height: `${Math.max(6, (Number(entry.value ?? 0) / maxUniqueValue) * 100)}%`,
                      background: "linear-gradient(180deg, #3de4a6, #12a56c)",
                    }}
                  />
                  <span style={barLabelStyle}>{entry.label}</span>
                </div>
              ))}
            </div>
          </article>
          <article style={chartCardStyle}>
            <strong style={chartTitleStyle}>Avg sentence length</strong>
            <div style={chartGridStyle}>
              {sentenceLengthSeries.map((entry) => (
                <div key={`length-${entry.key}`} style={barCellStyle} title={`${entry.key}: ${entry.value.toFixed(2)}`}>
                  <div
                    style={{
                      ...barStyle,
                      height: `${Math.max(6, (Number(entry.value ?? 0) / maxSentenceLengthValue) * 100)}%`,
                      background: "linear-gradient(180deg, #9f7cff, #6654d8)",
                    }}
                  />
                  <span style={barLabelStyle}>{entry.label}</span>
                </div>
              ))}
            </div>
          </article>
          <article style={chartCardStyle}>
            <strong style={chartTitleStyle}>Auto suggestion quality</strong>
            <div style={chartGridStyle}>
              {autoQualitySeries.map((entry) => {
                const acceptPct = Math.round(Number(entry.acceptRate ?? 0) * 100);
                const ignorePct = Math.round(Number(entry.ignoreRate ?? 0) * 100);
                const active = Number(entry.shown ?? 0) > 0;
                return (
                  <div
                    key={`quality-${entry.key}`}
                    style={barCellStyle}
                    title={`${entry.key}: shown ${entry.shown}, accept ${acceptPct}%, ignore ${ignorePct}%`}
                  >
                    <div style={dualBarWrapStyle}>
                      <div
                        style={{
                          ...dualRateBarStyle,
                          height: `${Math.max(active ? 6 : 0, acceptPct)}%`,
                          background: "linear-gradient(180deg, #3de4a6, #12a56c)",
                        }}
                      />
                      <div
                        style={{
                          ...dualRateBarStyle,
                          height: `${Math.max(active ? 6 : 0, ignorePct)}%`,
                          background: "linear-gradient(180deg, #ff9a9a, #d44b4b)",
                        }}
                      />
                    </div>
                    <span style={barLabelStyle}>{entry.label}</span>
                  </div>
                );
              })}
            </div>
            <p style={chartMetaStyle}>
              Avg accept {Math.round(autoAcceptRate * 100)}% | Avg ignore {Math.round(autoIgnoreRate * 100)}% | shown {Math.round(autoQualityTotals.shown)}
            </p>
          </article>
        </div>
      </section>

      <section style={panelStyle}>
        <h2 style={panelHeadingStyle}>Population Insights</h2>
        <ul style={listStyle}>
          {populationInsights.map((entry, index) => (
            <li key={`insight-${index}`}>{entry}</li>
          ))}
        </ul>
      </section>

      <section style={panelStyle}>
        <h2 style={panelHeadingStyle}>Risk & Alerts</h2>
        <ul style={listStyle}>
          {populationAlerts.map((entry, index) => (
            <li key={`alert-${index}`}>{entry}</li>
          ))}
        </ul>
        {highRiskCases.length > 0 ? (
          <p style={mutedStyle}>High-risk child count: {highRiskCases.length}</p>
        ) : null}
      </section>

      <section style={panelStyle}>
        <h2 style={panelHeadingStyle}>Cohort Drilldown</h2>
        <p style={mutedStyle}>Select a row to view child-level trends and export a targeted outcome report.</p>
        <div style={tableWrapperStyle}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Child</th>
                <th style={thStyle}>Usage</th>
                <th style={thStyle}>Growth</th>
                <th style={thStyle}>Risk</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Parent UID</th>
              </tr>
            </thead>
            <tbody>
              {sortedPopulation.slice(0, 300).map((entry) => {
                const attemptsPerDay = Number(entry.outcomes?.recentAttemptsPerDay ?? 0);
                const usage = attemptsPerDay >= 3 ? "High" : attemptsPerDay >= 1 ? "Medium" : "Low";
                const growth = formatSignedPercent(entry.outcomes?.attemptsPerDayDelta ?? 0);
                const risk = entry.outcomes?.highRisk ? "High" : "Low";
                const status = entry.outcomes?.highRisk ? "🔴" : attemptsPerDay > 0 ? "🟢" : "🟡";
                const rowKey = `${entry.parentUid}::${entry.childId}`;
                const selected = selectedChild && rowKey === `${selectedChild.parentUid}::${selectedChild.childId}`;
                return (
                  <tr
                    key={`${entry.parentUid}-${entry.childId}`}
                    style={selected ? selectedTableRowStyle : tableRowStyle}
                    onClick={() => setSelectedChildKey(rowKey)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedChildKey(rowKey);
                      }
                    }}
                    tabIndex={0}
                    role="button"
                    aria-label={`Open child drilldown for ${entry.name}`}
                  >
                    <td style={tdStyle}>{entry.name}</td>
                    <td style={tdStyle}>{usage}</td>
                    <td style={tdStyle}>{growth}</td>
                    <td style={tdStyle}>{risk}</td>
                    <td style={tdStyle}>{status}</td>
                    <td style={tdStyle}>{entry.parentUid}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section style={panelStyle}>
        <h2 style={panelHeadingStyle}>Selected Child Detail</h2>
        {!selectedChild ? (
          <p style={mutedStyle}>No child available for drilldown.</p>
        ) : (
          <>
            <div style={detailHeaderStyle}>
              <div>
                <strong style={detailNameStyle}>{selectedChild.name}</strong>
                <p style={detailMetaStyle}>
                  {selectedChild.parentUid} / {selectedChild.childId} | {selectedChild.ageGroup} | {selectedChild.diagnosis}
                </p>
                <p style={detailMetaStyle}>
                  Last sync: {selectedLastSync ? selectedLastSync.toLocaleString() : "Unknown"}
                </p>
              </div>
              <div style={detailActionsStyle}>
                <button onClick={exportSelectedChildReport} style={buttonStyle}>
                  Export Child TXT
                </button>
                <button onClick={exportSelectedChildPdf} style={buttonStyle}>
                  Export Child PDF
                </button>
              </div>
            </div>

            <div style={metricGridStyle}>
              <div style={metricCardStyle}>
                <span style={metricLabelStyle}>Attempts/day</span>
                <strong style={metricValueStyle}>{Number(selectedChild.outcomes?.recentAttemptsPerDay ?? 0).toFixed(2)}</strong>
              </div>
              <div style={metricCardStyle}>
                <span style={metricLabelStyle}>Attempts delta</span>
                <strong style={metricValueStyle}>{formatSignedPercent(selectedChild.outcomes?.attemptsPerDayDelta ?? 0)}</strong>
              </div>
              <div style={metricCardStyle}>
                <span style={metricLabelStyle}>New words ({periodDays}d)</span>
                <strong style={metricValueStyle}>{Math.round(Number(selectedChild.outcomes?.newWordsInPeriod ?? 0))}</strong>
              </div>
              <div style={metricCardStyle}>
                <span style={metricLabelStyle}>Avg sentence length</span>
                <strong style={metricValueStyle}>{Number(selectedChild.outcomes?.avgSentenceLengthRecent ?? 0).toFixed(1)}</strong>
              </div>
              <div style={metricCardStyle}>
                <span style={metricLabelStyle}>Auto quality</span>
                <strong style={metricValueStyle}>
                  {Math.round(selectedAutoAcceptRate * 100)}% / {Math.round(selectedAutoIgnoreRate * 100)}%
                </strong>
                <span style={metricHintStyle}>accept / ignore</span>
              </div>
            </div>

            <section style={comparisonSectionStyle}>
              <h3 style={comparisonHeadingStyle}>Baseline vs Current (Pilot Comparison)</h3>
              <div style={comparisonGridStyle}>
                {selectedComparisonRows.map((row) => {
                  const isPositive = row.better === "lower" ? row.delta <= 0 : row.delta >= 0;
                  return (
                    <article key={row.key} style={comparisonCardStyle}>
                      <strong style={comparisonLabelStyle}>{row.label}</strong>
                      <div style={comparisonRowStyle}>
                        <span>Baseline</span>
                        <strong>{formatCompactNumber(row.baseline, row.decimals)}{row.unit}</strong>
                      </div>
                      <div style={comparisonRowStyle}>
                        <span>Current</span>
                        <strong>{formatCompactNumber(row.current, row.decimals)}{row.unit}</strong>
                      </div>
                      <span style={comparisonDeltaStyle(isPositive)}>{formatSignedPercent(row.delta)}</span>
                    </article>
                  );
                })}
              </div>
            </section>

            <div style={chartSectionStyle}>
              <article style={chartCardStyle}>
                <strong style={chartTitleStyle}>Child attempts ({dateRangeLabel})</strong>
                <div style={chartGridStyle}>
                  {selectedAttemptsSeries.map((entry) => (
                    <div key={`selected-attempt-${entry.key}`} style={barCellStyle} title={`${entry.key}: ${entry.value}`}>
                      <div
                        style={{
                          ...barStyle,
                          height: `${Math.max(6, (Number(entry.value ?? 0) / selectedMaxAttemptValue) * 100)}%`,
                          background: "linear-gradient(180deg, #53a6ff, #2e6dff)",
                        }}
                      />
                      <span style={barLabelStyle}>{entry.label}</span>
                    </div>
                  ))}
                </div>
              </article>

              <article style={chartCardStyle}>
                <strong style={chartTitleStyle}>Child unique words ({dateRangeLabel})</strong>
                <div style={chartGridStyle}>
                  {selectedUniqueSeries.map((entry) => (
                    <div key={`selected-unique-${entry.key}`} style={barCellStyle} title={`${entry.key}: ${entry.value}`}>
                      <div
                        style={{
                          ...barStyle,
                          height: `${Math.max(6, (Number(entry.value ?? 0) / selectedMaxUniqueValue) * 100)}%`,
                          background: "linear-gradient(180deg, #3de4a6, #12a56c)",
                        }}
                      />
                      <span style={barLabelStyle}>{entry.label}</span>
                    </div>
                  ))}
                </div>
              </article>

              <article style={chartCardStyle}>
                <strong style={chartTitleStyle}>Child sentence length ({dateRangeLabel})</strong>
                <div style={chartGridStyle}>
                  {selectedSentenceLengthSeries.map((entry) => (
                    <div key={`selected-length-${entry.key}`} style={barCellStyle} title={`${entry.key}: ${entry.value.toFixed(2)}`}>
                      <div
                        style={{
                          ...barStyle,
                          height: `${Math.max(6, (Number(entry.value ?? 0) / selectedMaxSentenceLengthValue) * 100)}%`,
                          background: "linear-gradient(180deg, #9f7cff, #6654d8)",
                        }}
                      />
                      <span style={barLabelStyle}>{entry.label}</span>
                    </div>
                  ))}
                </div>
              </article>

              <article style={chartCardStyle}>
                <strong style={chartTitleStyle}>Child auto quality ({dateRangeLabel})</strong>
                <div style={chartGridStyle}>
                  {selectedAutoQualitySeries.map((entry) => {
                    const acceptPct = Math.round(Number(entry.acceptRate ?? 0) * 100);
                    const ignorePct = Math.round(Number(entry.ignoreRate ?? 0) * 100);
                    const active = Number(entry.shown ?? 0) > 0;
                    return (
                      <div
                        key={`selected-quality-${entry.key}`}
                        style={barCellStyle}
                        title={`${entry.key}: shown ${entry.shown}, accept ${acceptPct}%, ignore ${ignorePct}%`}
                      >
                        <div style={dualBarWrapStyle}>
                          <div
                            style={{
                              ...dualRateBarStyle,
                              height: `${Math.max(active ? 6 : 0, acceptPct)}%`,
                              background: "linear-gradient(180deg, #3de4a6, #12a56c)",
                            }}
                          />
                          <div
                            style={{
                              ...dualRateBarStyle,
                              height: `${Math.max(active ? 6 : 0, ignorePct)}%`,
                              background: "linear-gradient(180deg, #ff9a9a, #d44b4b)",
                            }}
                          />
                        </div>
                        <span style={barLabelStyle}>{entry.label}</span>
                      </div>
                    );
                  })}
                </div>
                <p style={chartMetaStyle}>
                  Avg accept {Math.round(selectedAutoAcceptRate * 100)}% | Avg ignore {Math.round(selectedAutoIgnoreRate * 100)}% | shown {Math.round(selectedAutoTotals.shown)}
                </p>
              </article>
            </div>

            <pre style={reportPreStyle}>{selectedOutcomeText}</pre>
          </>
        )}
      </section>
    </div>
  );
}

const pageStyle = {
  maxWidth: 1260,
  margin: "40px auto",
  padding: 24,
  color: "#e7f4ff",
};

const subtitleStyle = {
  marginTop: 0,
  color: "#a8c8e8",
};

const rolesStyle = {
  marginTop: 0,
  color: "#95b7da",
};

const panelStyle = {
  border: "1px solid rgba(133, 174, 218, 0.34)",
  borderRadius: 12,
  padding: 14,
  marginBottom: 12,
  background: "linear-gradient(165deg, rgba(8, 22, 43, 0.86), rgba(7, 19, 37, 0.9))",
  boxShadow: "0 18px 34px rgba(2, 9, 20, 0.4)",
};

const panelHeadingStyle = {
  marginTop: 0,
  marginBottom: 10,
  color: "#ebf7ff",
};

const headerFilterGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
  gap: 10,
  marginBottom: 12,
};

const navRowStyle = {
  display: "flex",
  gap: 10,
  flexWrap: "wrap",
};

const metadataLineStyle = {
  marginBottom: 0,
  marginTop: 10,
  color: "#89aacd",
  fontSize: 13,
};

const linkStyle = {
  padding: "8px 12px",
  border: "1px solid rgba(140, 182, 227, 0.55)",
  borderRadius: 8,
  textDecoration: "none",
  background: "rgba(14, 34, 59, 0.76)",
  color: "#dceeff",
};

const buttonStyle = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid rgba(136, 176, 219, 0.52)",
  background: "rgba(12, 29, 52, 0.8)",
  color: "#ddecff",
  cursor: "pointer",
};

const labelStyle = {
  display: "grid",
  gap: 6,
  fontWeight: 600,
  color: "#c9def3",
};

const inputStyle = {
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid rgba(135, 173, 215, 0.52)",
  background: "rgba(5, 18, 34, 0.86)",
  color: "#e9f5ff",
};

const metricGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: 10,
};

const pilotSummaryGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
  gap: 10,
  marginBottom: 10,
};

const metricCardStyle = {
  border: "1px solid rgba(130, 170, 213, 0.34)",
  borderRadius: 10,
  padding: 10,
  background: "rgba(10, 28, 50, 0.72)",
};

const metricLabelStyle = {
  display: "block",
  fontSize: 12,
  color: "#9ec0e1",
  textTransform: "uppercase",
};

const metricValueStyle = {
  fontSize: 24,
  lineHeight: 1.1,
  color: "#eaf7ff",
};

const metricHintStyle = {
  display: "block",
  marginTop: 4,
  fontSize: 11,
  color: "#8eaed1",
  textTransform: "uppercase",
};

const chartSectionStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
  gap: 10,
};

const chartCardStyle = {
  border: "1px solid rgba(133, 173, 216, 0.34)",
  borderRadius: 10,
  background: "rgba(10, 28, 50, 0.74)",
  padding: 10,
};

const chartTitleStyle = {
  display: "block",
  marginBottom: 8,
  color: "#e8f5ff",
};

const chartGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(18px, 1fr))",
  gap: 4,
  alignItems: "end",
  minHeight: 130,
};

const barCellStyle = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "flex-end",
  minHeight: 110,
  gap: 6,
};

const barStyle = {
  width: "100%",
  borderRadius: 6,
  transition: "height 180ms ease",
};

const dualBarWrapStyle = {
  width: "100%",
  height: "100%",
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 3,
  alignItems: "end",
};

const dualRateBarStyle = {
  width: "100%",
  borderRadius: 6,
  transition: "height 180ms ease",
};

const barLabelStyle = {
  fontSize: 10,
  color: "#8daece",
};

const chartMetaStyle = {
  marginBottom: 0,
  marginTop: 8,
  fontSize: 12,
  color: "#8aaaca",
};

const detailHeaderStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 12,
  marginBottom: 12,
  flexWrap: "wrap",
};

const detailNameStyle = {
  display: "block",
  fontSize: 20,
  color: "#e9f6ff",
};

const detailMetaStyle = {
  margin: "2px 0",
  color: "#95b5d8",
  fontSize: 13,
};

const detailActionsStyle = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
};

const comparisonSectionStyle = {
  marginTop: 10,
  marginBottom: 10,
};

const comparisonHeadingStyle = {
  marginTop: 0,
  marginBottom: 8,
  fontSize: 15,
  color: "#d9ecff",
};

const comparisonGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
  gap: 10,
};

const comparisonCardStyle = {
  border: "1px solid rgba(132, 171, 215, 0.34)",
  borderRadius: 10,
  background: "rgba(10, 28, 50, 0.74)",
  padding: 10,
  display: "grid",
  gap: 6,
};

const comparisonLabelStyle = {
  fontSize: 13,
  color: "#d9ecff",
};

const comparisonRowStyle = {
  display: "flex",
  justifyContent: "space-between",
  gap: 8,
  fontSize: 12,
  color: "#98b8d9",
};

const comparisonDeltaStyle = (isPositive = true) => ({
  marginTop: 4,
  fontSize: 12,
  fontWeight: 700,
  color: isPositive ? "#15764a" : "#ab2a2a",
});

const listStyle = {
  margin: "8px 0 0",
  paddingLeft: 20,
};

const mutedStyle = {
  color: "#8eaecf",
};

const superAdminNoticeStyle = {
  marginTop: 8,
  marginBottom: 8,
  color: "#ffe5a3",
  background: "rgba(97, 72, 14, 0.45)",
  border: "1px solid rgba(242, 207, 122, 0.58)",
  borderRadius: 8,
  padding: "8px 10px",
  fontSize: 13,
};

const tableWrapperStyle = {
  overflowX: "auto",
  border: "1px solid rgba(132, 171, 214, 0.34)",
  borderRadius: 10,
};

const tableStyle = {
  width: "100%",
  borderCollapse: "collapse",
  minWidth: 840,
};

const thStyle = {
  textAlign: "left",
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 0.3,
  color: "#9cbce0",
  padding: 8,
  borderBottom: "1px solid rgba(132, 171, 214, 0.32)",
  background: "rgba(10, 26, 47, 0.8)",
};

const tdStyle = {
  padding: 8,
  borderBottom: "1px solid rgba(121, 159, 201, 0.2)",
  fontSize: 13,
  color: "#d8ebff",
};

const tablePrimaryTextStyle = {
  fontWeight: 600,
};

const tableSecondaryTextStyle = {
  marginTop: 2,
  fontSize: 11,
  color: "#8baaca",
};

const activityPillStyle = (level = "inactive") => {
  const normalized = String(level ?? "").toLowerCase();
  if (normalized === "high") {
    return {
      display: "inline-block",
      borderRadius: 999,
      padding: "2px 8px",
      fontSize: 11,
      textTransform: "uppercase",
      border: "1px solid #1e9f65",
      background: "#e6f8ef",
      color: "#0f6a42",
      fontWeight: 700,
    };
  }
  if (normalized === "medium") {
    return {
      display: "inline-block",
      borderRadius: 999,
      padding: "2px 8px",
      fontSize: 11,
      textTransform: "uppercase",
      border: "1px solid #c9a437",
      background: "#fff6df",
      color: "#7d5e09",
      fontWeight: 700,
    };
  }
  if (normalized === "low") {
    return {
      display: "inline-block",
      borderRadius: 999,
      padding: "2px 8px",
      fontSize: 11,
      textTransform: "uppercase",
      border: "1px solid #6f9ecf",
      background: "#edf4ff",
      color: "#2a5784",
      fontWeight: 700,
    };
  }
  return {
    display: "inline-block",
    borderRadius: 999,
    padding: "2px 8px",
    fontSize: 11,
    textTransform: "uppercase",
    border: "1px solid #c8d1e0",
    background: "#f5f8fd",
    color: "#5d6f8b",
    fontWeight: 700,
  };
};

const tableRowStyle = {
  cursor: "pointer",
};

const selectedTableRowStyle = {
  ...tableRowStyle,
  background: "linear-gradient(90deg, #edf4ff, #f7faff)",
};

const reportPreStyle = {
  marginTop: 10,
  marginBottom: 0,
  whiteSpace: "pre-wrap",
  background: "#f7f9ff",
  border: "1px solid #d4deef",
  borderRadius: 10,
  padding: 10,
  color: "#1f3557",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  fontSize: 13,
};

const errorStyle = {
  marginBottom: 10,
  color: "#9c1c1c",
};
