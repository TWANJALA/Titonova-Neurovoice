import { useEffect, useMemo, useState } from "react";
import { collection, getDocs } from "firebase/firestore";
import { Link } from "react-router-dom";
import { useAuth } from "@/auth/AuthContext";
import { db } from "@/firebase";
import {
  buildPopulationSummary,
  computeOutcomeMetrics,
  formatDateKey,
  normalizeChildSnapshot,
  recentDayKeys,
  toDateLike,
} from "@/lib/outcomeMetrics";
import { Card, CardContent } from "@/components/ui/card";
import {
  UI_LANGUAGE_OPTIONS,
  normalizeLanguageCode,
  speakLocalizedText,
  translateTextBatch,
} from "@/lib/translation";

type ChildRecord = {
  parentUid: string;
  childId: string;
  name: string;
  profile?: Record<string, unknown>;
  preferences?: Record<string, unknown>;
  model?: Record<string, unknown>;
  smartModel?: Record<string, unknown>;
  ageGroup?: string;
  diagnosis?: string;
  therapist?: string;
  region?: string;
  outcomes?: Record<string, unknown>;
};

type SeriesPoint = {
  key: string;
  label: string;
  value: number;
};

type BaselineMode = "rolling" | "fixed";

type TableRow = {
  key: string;
  parentUid: string;
  childId: string;
  name: string;
  ageGroup: string;
  diagnosis: string;
  therapist: string;
  region: string;
  usage: string;
  growth: string;
  risk: string;
  status: string;
  riskFlags: string[];
  outcomes: Record<string, number | string | string[] | boolean>;
};

function normalizeToken(text: unknown) {
  return String(text ?? "").trim().toLowerCase();
}

function tokenizeText(text: unknown) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function formatSignedPercent(value: number) {
  const rounded = Math.round(Number(value ?? 0) * 100);
  if (rounded > 0) return `+${rounded}%`;
  if (rounded < 0) return `${rounded}%`;
  return "0%";
}

function formatCompactNumber(value: unknown, decimals = 2) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return "0";
  return parsed.toFixed(decimals);
}

function normalizeFilterValue(value: unknown, fallback = "unassigned") {
  const parsed = String(value ?? "").trim();
  return parsed || fallback;
}

function toSlug(value: unknown, fallback = "item") {
  const safe = normalizeToken(value).replace(/\s+/g, "-").replace(/[^a-z0-9-_]/g, "");
  return safe || fallback;
}

function toCsv(rows: Array<Array<string | number>>) {
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

function downloadTextFile(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(objectUrl);
}

function downloadBinaryFile(filename: string, bytes: Uint8Array | ArrayBuffer, mimeType: string) {
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
      c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array | ArrayBuffer) {
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

function toBytes(value: Uint8Array | ArrayBuffer | string) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new TextEncoder().encode(String(value ?? ""));
}

function concatBytes(chunks: Uint8Array[]) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  chunks.forEach((chunk) => {
    out.set(chunk, offset);
    offset += chunk.length;
  });
  return out;
}

function buildZipArchive(entries: Array<{ name: string; bytes: Uint8Array | ArrayBuffer | string }>) {
  const encoder = new TextEncoder();
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
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

function toPdfAscii(text: unknown) {
  return String(text ?? "").replace(/[^\x20-\x7E]/g, "?");
}

function escapePdfText(value: unknown) {
  return toPdfAscii(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function wrapText(text: unknown, maxChars = 92) {
  const source = toPdfAscii(text).trim();
  if (!source) return [""];
  const words = source.split(/\s+/);
  const lines: string[] = [];
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

function createSimplePdfFromLines(lines: string[] = [], title = "Report") {
  const bodyLines = [title, "", ...lines].flatMap((line) => wrapText(line));
  const linesPerPage = 48;
  const pages: string[][] = [];
  for (let index = 0; index < bodyLines.length; index += linesPerPage) {
    pages.push(bodyLines.slice(index, index + linesPerPage));
  }
  if (pages.length === 0) pages.push(["No data"]);

  const objects: string[] = [];
  const pageObjectIds: number[] = [];
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
  const chunks: string[] = [];
  const offsets: number[] = [];
  let byteOffset = 0;
  const append = (text: string) => {
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

function openPrintableReport(title: string, sections: Array<{ heading: string; lines: string[] }>) {
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

function getChildSentenceEvents(child: ChildRecord) {
  const model = (child?.model ?? {}) as Record<string, unknown>;
  const smartModel = (child?.smartModel ?? {}) as Record<string, unknown>;
  if (Array.isArray(model.sentenceEvents)) return model.sentenceEvents as Array<Record<string, unknown>>;
  if (Array.isArray(smartModel.sentenceEvents)) return smartModel.sentenceEvents as Array<Record<string, unknown>>;
  return [];
}

function getChildUsageCounts(child: ChildRecord) {
  const model = (child?.model ?? {}) as Record<string, unknown>;
  const smartModel = (child?.smartModel ?? {}) as Record<string, unknown>;
  if (model.wordFrequency && typeof model.wordFrequency === "object") {
    return model.wordFrequency as Record<string, number>;
  }
  if (smartModel.usageCounts && typeof smartModel.usageCounts === "object") {
    return smartModel.usageCounts as Record<string, number>;
  }
  return {};
}

function aggregateCommunicationSeries(children: ChildRecord[], days: number, now: Date) {
  const keys = recentDayKeys(days, now);
  const rows = keys.map((key) => ({ key, label: key.slice(5), value: 0 }));
  const rowIndex = new Map(keys.map((key, index) => [key, index]));

  children.forEach((child) => {
    const dailyCounts = (child?.preferences?.dailySentenceCounts ?? {}) as Record<string, number>;
    keys.forEach((key) => {
      const index = rowIndex.get(key);
      if (index === undefined) return;
      rows[index].value += Number(dailyCounts?.[key] ?? 0);
    });
  });

  return rows;
}

function aggregateVocabularySeries(children: ChildRecord[], days: number, now: Date) {
  const keys = recentDayKeys(days, now);
  const keyIndex = new Map(keys.map((key, index) => [key, index]));
  const tokenSets = keys.map(() => new Set<string>());

  children.forEach((child) => {
    getChildSentenceEvents(child).forEach((entry) => {
      const stamp = toDateLike(entry?.ts);
      if (!stamp) return;
      const key = formatDateKey(stamp);
      const index = keyIndex.get(key);
      if (index === undefined) return;
      tokenizeText(entry?.text).forEach((token) => tokenSets[index].add(token));
    });
  });

  return keys.map((key, index) => ({
    key,
    label: key.slice(5),
    value: tokenSets[index].size,
  }));
}

function aggregateSentenceLengthSeries(children: ChildRecord[], days: number, now: Date) {
  const keys = recentDayKeys(days, now);
  const keyIndex = new Map(keys.map((key, index) => [key, index]));
  const totals = keys.map(() => ({ words: 0, count: 0 }));

  children.forEach((child) => {
    getChildSentenceEvents(child).forEach((entry) => {
      const stamp = toDateLike(entry?.ts);
      if (!stamp) return;
      const key = formatDateKey(stamp);
      const index = keyIndex.get(key);
      if (index === undefined) return;
      const tokens = tokenizeText(entry?.text);
      if (tokens.length === 0) return;
      totals[index].words += tokens.length;
      totals[index].count += 1;
    });
  });

  return keys.map((key, index) => ({
    key,
    label: key.slice(5),
    value: totals[index].count > 0 ? totals[index].words / totals[index].count : 0,
  }));
}

function aggregateLatencySeries(children: ChildRecord[], days: number, now: Date) {
  const keys = recentDayKeys(days, now);
  const keyIndex = new Map(keys.map((key, index) => [key, index]));
  const totals = keys.map(() => ({ ms: 0, count: 0 }));

  children.forEach((child) => {
    getChildSentenceEvents(child).forEach((entry) => {
      const stamp = toDateLike(entry?.ts);
      if (!stamp) return;
      const key = formatDateKey(stamp);
      const index = keyIndex.get(key);
      if (index === undefined) return;
      const elapsedMs = Number(entry?.elapsedMs ?? entry?.latencyMs ?? entry?.elapsed ?? 0);
      if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return;
      totals[index].ms += elapsedMs;
      totals[index].count += 1;
    });
  });

  return keys.map((key, index) => ({
    key,
    label: key.slice(5),
    value: totals[index].count > 0 ? totals[index].ms / totals[index].count / 1000 : 0,
  }));
}

function getUsageBand(attemptsPerDay: number) {
  if (attemptsPerDay >= 4) return "High";
  if (attemptsPerDay >= 1.5) return "Medium";
  return "Low";
}

function getRiskBand(flags: string[], highRisk: boolean) {
  if (highRisk && flags.length >= 2) return "High";
  if (highRisk || flags.length === 1) return "Medium";
  return "Low";
}

function getStatusEmoji(riskBand: string) {
  if (riskBand === "High") return "🔴";
  if (riskBand === "Medium") return "🟡";
  return "🟢";
}

function MiniBarChart({
  title,
  subtitle,
  points,
  fromColor,
  toColor,
}: {
  title: string;
  subtitle: string;
  points: SeriesPoint[];
  fromColor: string;
  toColor: string;
}) {
  const maxValue = Math.max(1, ...points.map((entry) => Number(entry.value ?? 0)));
  return (
    <Card className="rounded-2xl shadow-sm">
      <CardContent className="p-4">
        <h3 className="font-medium">{title}</h3>
        <p className="mb-4 mt-1 text-xs text-slate-500">{subtitle}</p>
        <div className="h-40 rounded-xl border border-dashed border-slate-300 bg-slate-100/80 px-3 py-2">
          <div className="flex h-full items-end gap-1.5">
            {points.map((entry) => (
              <div key={`${title}-${entry.key}`} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
                <div
                  className="w-full rounded-t-sm"
                  style={{
                    height: `${Math.max(4, (Number(entry.value ?? 0) / maxValue) * 100)}%`,
                    background: `linear-gradient(180deg, ${fromColor}, ${toColor})`,
                  }}
                  title={`${entry.key}: ${entry.value.toFixed(2)}`}
                />
                <span className="text-[10px] text-slate-500">{entry.label}</span>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function McoDashboard() {
  const { signOut } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [ageFilter, setAgeFilter] = useState("all");
  const [diagnosisFilter, setDiagnosisFilter] = useState("all");
  const [therapistFilter, setTherapistFilter] = useState("all");
  const [regionFilter, setRegionFilter] = useState("all");
  const [dateRange, setDateRange] = useState<"weekly" | "monthly">("monthly");
  const [uiLanguage, setUiLanguage] = useState("en");
  const [translationStatus, setTranslationStatus] = useState<"idle" | "translating" | "ready" | "error">("idle");
  const [translationMap, setTranslationMap] = useState<Record<string, string>>({});
  const [anchorDateKey, setAnchorDateKey] = useState(() => formatDateKey(new Date()));
  const [baselineMode, setBaselineMode] = useState<BaselineMode>("rolling");
  const [populationRaw, setPopulationRaw] = useState<ChildRecord[]>([]);
  const [selectedChildKey, setSelectedChildKey] = useState("");
  const [selectedTherapistName, setSelectedTherapistName] = useState("");
  const [baselineStartKey, setBaselineStartKey] = useState(() => getDefaultFixedBaselineRange(30).startKey);
  const [baselineEndKey, setBaselineEndKey] = useState(() => getDefaultFixedBaselineRange(30).endKey);

  const periodDays = dateRange === "weekly" ? 7 : 30;
  const chartDays = dateRange === "weekly" ? 14 : 30;
  const reportNow = useMemo(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(anchorDateKey)) return new Date();
    const parsed = new Date(`${anchorDateKey}T12:00:00`);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }, [anchorDateKey]);

  const t = (text: unknown) => {
    const key = String(text ?? "");
    return translationMap[key] ?? key;
  };

  const normalizedBaseline = useMemo(() => {
    const fallback = getDefaultFixedBaselineRange(periodDays, reportNow);
    const isValid = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""));
    let start = isValid(baselineStartKey) ? baselineStartKey : fallback.startKey;
    let end = isValid(baselineEndKey) ? baselineEndKey : fallback.endKey;
    if (start > end) {
      const temp = start;
      start = end;
      end = temp;
    }
    return { startKey: start, endKey: end };
  }, [baselineStartKey, baselineEndKey, periodDays, reportNow]);
  const baselineSummaryLabel =
    baselineMode === "fixed"
      ? `Fixed baseline: ${normalizedBaseline.startKey} to ${normalizedBaseline.endKey}`
      : "Rolling baseline: previous period";

  const baselineOptions = useMemo(
    () => ({
      baselineMode,
      baselineStartKey: normalizedBaseline.startKey,
      baselineEndKey: normalizedBaseline.endKey,
      now: reportNow,
    }),
    [baselineMode, normalizedBaseline, reportNow]
  );

  useEffect(() => {
    async function loadPopulation() {
      setLoading(true);
      setError("");
      try {
        const usersSnapshot = await getDocs(collection(db, "users"));
        const perUserChildren = await Promise.all(
          usersSnapshot.docs.map(async (userDoc) => {
            const parentUid = userDoc.id;
            const childrenSnapshot = await getDocs(collection(db, "users", parentUid, "children"));
            return childrenSnapshot.docs.map((childDoc) =>
              normalizeChildSnapshot(parentUid, childDoc.id, childDoc.data() ?? {}, [])
            ) as ChildRecord[];
          })
        );
        setPopulationRaw(perUserChildren.flat());
      } catch (loadError) {
        console.error("Failed to load MCO dashboard population:", loadError);
        setPopulationRaw([]);
        setError((loadError as Error)?.message || "Unable to load population metrics.");
      } finally {
        setLoading(false);
      }
    }

    loadPopulation();
  }, []);

  const population = useMemo(
    () =>
      populationRaw.map((entry) => ({
        ...entry,
        outcomes: computeOutcomeMetrics(entry, periodDays, baselineOptions),
        ageGroup: normalizeFilterValue(entry?.profile?.ageGroup ?? entry?.profile?.age),
        diagnosis: normalizeFilterValue(entry?.profile?.diagnosis),
        therapist: normalizeFilterValue(entry?.profile?.therapistName ?? entry?.profile?.therapistUid),
        region: normalizeFilterValue(entry?.profile?.region),
      })),
    [populationRaw, periodDays, baselineOptions]
  );

  const filterOptions = useMemo(() => {
    const unique = (key: "ageGroup" | "diagnosis" | "therapist" | "region") => [
      "all",
      ...new Set(population.map((entry) => normalizeFilterValue(entry?.[key]))),
    ];
    return {
      age: unique("ageGroup"),
      diagnosis: unique("diagnosis"),
      therapist: unique("therapist"),
      region: unique("region"),
    };
  }, [population]);

  const filteredPopulation = useMemo(() => {
    const query = normalizeToken(search);
    return population.filter((entry) => {
      if (ageFilter !== "all" && entry.ageGroup !== ageFilter) return false;
      if (diagnosisFilter !== "all" && entry.diagnosis !== diagnosisFilter) return false;
      if (therapistFilter !== "all" && entry.therapist !== therapistFilter) return false;
      if (regionFilter !== "all" && entry.region !== regionFilter) return false;
      if (!query) return true;
      const name = normalizeToken(entry.name);
      return (
        name.includes(query) ||
        normalizeToken(entry.parentUid).includes(query) ||
        normalizeToken(entry.childId).includes(query)
      );
    });
  }, [population, ageFilter, diagnosisFilter, therapistFilter, regionFilter, search]);

  const summary = useMemo(() => buildPopulationSummary(filteredPopulation), [filteredPopulation]);

  const avgNewWords = useMemo(() => {
    if (filteredPopulation.length === 0) return 0;
    return (
      filteredPopulation.reduce(
        (sum, entry) => sum + Number((entry.outcomes as Record<string, number>)?.newWordsInPeriod ?? 0),
        0
      ) / filteredPopulation.length
    );
  }, [filteredPopulation]);

  const avgSuggestionAcceptance = useMemo(() => {
    if (filteredPopulation.length === 0) return 0;
    return (
      filteredPopulation.reduce(
        (sum, entry) =>
          sum + Number((entry.outcomes as Record<string, number>)?.suggestionAcceptanceRate ?? 0),
        0
      ) / filteredPopulation.length
    );
  }, [filteredPopulation]);

  const avgEfficiencyDelta = useMemo(() => {
    if (filteredPopulation.length === 0) return 0;
    return (
      filteredPopulation.reduce(
        (sum, entry) => sum + Number((entry.outcomes as Record<string, number>)?.timeToCommunicateDelta ?? 0),
        0
      ) / filteredPopulation.length
    );
  }, [filteredPopulation]);

  const inactiveChildren = useMemo(() => {
    const keys = recentDayKeys(7, reportNow);
    return filteredPopulation.filter((entry) => {
      const dailyCounts = (entry?.preferences?.dailySentenceCounts ?? {}) as Record<string, number>;
      const total = keys.reduce((sum, key) => sum + Number(dailyCounts[key] ?? 0), 0);
      return total <= 0;
    }).length;
  }, [filteredPopulation, reportNow]);

  const decliningChildren = filteredPopulation.filter(
    (entry) => Number((entry.outcomes as Record<string, number>)?.attemptsPerDayDelta ?? 0) <= -0.2
  ).length;

  const requestDominancePct = useMemo(() => {
    if (filteredPopulation.length === 0) return 0;
    const requestDominant = filteredPopulation.filter((entry) => {
      const usageCounts = getChildUsageCounts(entry);
      const topWordEntry = Object.entries(usageCounts).sort((a, b) => Number(b[1] ?? 0) - Number(a[1] ?? 0))[0];
      const topWord = normalizeToken(topWordEntry?.[0]);
      return ["want", "need", "help"].includes(topWord);
    }).length;
    return Math.round((requestDominant / Math.max(1, filteredPopulation.length)) * 100);
  }, [filteredPopulation]);

  const communicationSeries = useMemo(
    () => aggregateCommunicationSeries(filteredPopulation, chartDays, reportNow),
    [filteredPopulation, chartDays, reportNow]
  );
  const vocabularySeries = useMemo(
    () => aggregateVocabularySeries(filteredPopulation, chartDays, reportNow),
    [filteredPopulation, chartDays, reportNow]
  );
  const sentenceLengthSeries = useMemo(
    () => aggregateSentenceLengthSeries(filteredPopulation, chartDays, reportNow),
    [filteredPopulation, chartDays, reportNow]
  );
  const latencySeries = useMemo(
    () => aggregateLatencySeries(filteredPopulation, chartDays, reportNow),
    [filteredPopulation, chartDays, reportNow]
  );

  const kpis = [
    { title: "Engagement Rate", value: `${summary.engagementRatePct}%` },
    { title: "Communication Improvement", value: formatSignedPercent(summary.avgImprovementPct / 100) },
    { title: "Vocabulary Growth", value: `+${Math.round(avgNewWords)} words` },
    {
      title: "Efficiency Gain",
      value: `${formatSignedPercent(avgEfficiencyDelta)} time`,
    },
  ];

  const insights = [
    `${Math.max(0, Math.round(((summary.childCount - summary.highRiskCount) / Math.max(1, summary.childCount)) * 100))}% of children are currently below high-risk threshold.`,
    `${summary.engagementRatePct}% of children were active in the selected window.`,
    `${requestDominancePct}% show request-intent dominant usage patterns.`,
    `Average suggestion acceptance is ${Math.round(avgSuggestionAcceptance * 100)}%.`,
  ];

  const alerts = [
    `${inactiveChildren} inactive > 7 days`,
    `${decliningChildren} declining usage`,
    `${summary.highRiskCount} high-risk cases`,
  ];

  const tableRows = useMemo<TableRow[]>(() => {
    return [...filteredPopulation]
      .sort(
        (a, b) =>
          Number((b.outcomes as Record<string, number>)?.recentAttemptsPerDay ?? 0) -
          Number((a.outcomes as Record<string, number>)?.recentAttemptsPerDay ?? 0)
      )
      .map((entry) => {
        const outcomes = (entry.outcomes ?? {}) as Record<string, number | string | string[] | boolean>;
        const attemptsPerDay = Number(outcomes.recentAttemptsPerDay ?? 0);
        const riskFlags = Array.isArray(outcomes.riskFlags) ? (outcomes.riskFlags as string[]) : [];
        const highRisk = Boolean(outcomes.highRisk);
        const riskBand = getRiskBand(riskFlags, highRisk);
        return {
          key: `${entry.parentUid}-${entry.childId}`,
          parentUid: entry.parentUid,
          childId: entry.childId,
          name: entry.name,
          ageGroup: normalizeFilterValue(entry.ageGroup),
          diagnosis: normalizeFilterValue(entry.diagnosis),
          therapist: normalizeFilterValue(entry.therapist),
          region: normalizeFilterValue(entry.region),
          usage: getUsageBand(attemptsPerDay),
          growth: formatSignedPercent(Number(outcomes.attemptsPerDayDelta ?? 0)),
          risk: riskBand,
          status: getStatusEmoji(riskBand),
          riskFlags,
          outcomes,
        };
      });
  }, [filteredPopulation]);

  const atRiskRows = useMemo(() => {
    const riskRank = (risk: string) => {
      if (risk === "High") return 3;
      if (risk === "Medium") return 2;
      return 1;
    };
    return tableRows
      .filter((entry) => entry.risk !== "Low" || entry.riskFlags.length > 0)
      .sort((a, b) => {
        const rankDiff = riskRank(b.risk) - riskRank(a.risk);
        if (rankDiff !== 0) return rankDiff;
        return (
          Number(b.outcomes.attemptsPerDayDelta ?? 0) -
          Number(a.outcomes.attemptsPerDayDelta ?? 0)
        );
      });
  }, [tableRows]);

  const therapistSummaryRows = useMemo(() => {
    const buckets = new Map<
      string,
      {
        therapist: string;
        childCount: number;
        highRiskCount: number;
        engagedCount: number;
        improvementTotal: number;
        acceptanceTotal: number;
      }
    >();

    tableRows.forEach((entry) => {
      const therapist = normalizeFilterValue(entry.therapist);
      const current = buckets.get(therapist) ?? {
        therapist,
        childCount: 0,
        highRiskCount: 0,
        engagedCount: 0,
        improvementTotal: 0,
        acceptanceTotal: 0,
      };
      current.childCount += 1;
      const attemptsPerDay = Number(entry.outcomes.recentAttemptsPerDay ?? 0);
      if (attemptsPerDay > 0) current.engagedCount += 1;
      if (entry.risk !== "Low" || entry.riskFlags.length > 0) current.highRiskCount += 1;
      current.improvementTotal += Number(entry.outcomes.attemptsPerDayDelta ?? 0);
      current.acceptanceTotal += Number(entry.outcomes.suggestionAcceptanceRate ?? 0);
      buckets.set(therapist, current);
    });

    return [...buckets.values()]
      .map((entry) => ({
        therapist: entry.therapist,
        childCount: entry.childCount,
        highRiskCount: entry.highRiskCount,
        engagementRatePct: Math.round((entry.engagedCount / Math.max(1, entry.childCount)) * 100),
        avgImprovementPct: Math.round((entry.improvementTotal / Math.max(1, entry.childCount)) * 100),
        avgAcceptancePct: Math.round((entry.acceptanceTotal / Math.max(1, entry.childCount)) * 100),
      }))
      .sort((a, b) => {
        if (b.highRiskCount !== a.highRiskCount) return b.highRiskCount - a.highRiskCount;
        if (b.childCount !== a.childCount) return b.childCount - a.childCount;
        return a.therapist.localeCompare(b.therapist);
      });
  }, [tableRows]);

  const activeTherapist = useMemo(() => {
    if (therapistFilter !== "all") return therapistFilter;
    if (
      selectedTherapistName &&
      therapistSummaryRows.some((entry) => entry.therapist === selectedTherapistName)
    ) {
      return selectedTherapistName;
    }
    return therapistSummaryRows[0]?.therapist ?? "";
  }, [therapistFilter, selectedTherapistName, therapistSummaryRows]);

  useEffect(() => {
    if (therapistFilter !== "all") {
      setSelectedTherapistName(therapistFilter);
      return;
    }
    if (therapistSummaryRows.length === 0) {
      setSelectedTherapistName("");
      return;
    }
    if (
      !selectedTherapistName ||
      !therapistSummaryRows.some((entry) => entry.therapist === selectedTherapistName)
    ) {
      setSelectedTherapistName(therapistSummaryRows[0].therapist);
    }
  }, [therapistFilter, therapistSummaryRows, selectedTherapistName]);

  const activeTherapistSummary = useMemo(
    () => therapistSummaryRows.find((entry) => entry.therapist === activeTherapist) ?? null,
    [therapistSummaryRows, activeTherapist]
  );

  const activeTherapistRows = useMemo(
    () => tableRows.filter((entry) => normalizeFilterValue(entry.therapist) === activeTherapist),
    [tableRows, activeTherapist]
  );

  const activeTherapistAverages = useMemo(() => {
    const safeCount = Math.max(1, activeTherapistRows.length);
    return {
      avgNewWords: activeTherapistRows.reduce(
        (sum, entry) => sum + Number(entry.outcomes.newWordsInPeriod ?? 0),
        0
      ) / safeCount,
      avgSentenceLength: activeTherapistRows.reduce(
        (sum, entry) => sum + Number(entry.outcomes.avgSentenceLengthRecent ?? 0),
        0
      ) / safeCount,
      avgTimeToSpeakSec:
        activeTherapistRows.reduce(
          (sum, entry) => sum + Number(entry.outcomes.avgTimeToCommunicateRecentMs ?? 0),
          0
        ) /
        safeCount /
        1000,
    };
  }, [activeTherapistRows]);

  const activeTherapistPopulation = useMemo(
    () => filteredPopulation.filter((entry) => normalizeFilterValue(entry.therapist) === activeTherapist),
    [filteredPopulation, activeTherapist]
  );

  const therapistCommunicationSeries = useMemo(
    () => aggregateCommunicationSeries(activeTherapistPopulation, chartDays, reportNow),
    [activeTherapistPopulation, chartDays, reportNow]
  );

  const therapistComparisonRows = useMemo(() => {
    const safeCount = Math.max(1, activeTherapistPopulation.length);
    const averageAcross = (
      readCurrent: (entry: ChildRecord) => number,
      readBaseline: (entry: ChildRecord) => number
    ) => {
      const current =
        activeTherapistPopulation.reduce((sum, entry) => sum + Number(readCurrent(entry) ?? 0), 0) / safeCount;
      const baseline =
        activeTherapistPopulation.reduce((sum, entry) => sum + Number(readBaseline(entry) ?? 0), 0) / safeCount;
      const delta = baseline > 0 ? (current - baseline) / baseline : current > 0 ? 1 : 0;
      return { baseline, current, delta };
    };

    return [
      {
        key: "attempts",
        label: "Communication attempts/day",
        ...averageAcross(
          (entry) => Number((entry.outcomes as Record<string, number>)?.recentAttemptsPerDay ?? 0),
          (entry) => Number((entry.outcomes as Record<string, number>)?.previousAttemptsPerDay ?? 0)
        ),
        unit: "",
        decimals: 2,
        better: "higher",
      },
      {
        key: "vocab",
        label: "Unique vocabulary",
        ...averageAcross(
          (entry) => Number((entry.outcomes as Record<string, number>)?.uniqueVocabularyRecent ?? 0),
          (entry) => Number((entry.outcomes as Record<string, number>)?.uniqueVocabularyPrevious ?? 0)
        ),
        unit: " words",
        decimals: 0,
        better: "higher",
      },
      {
        key: "sentence",
        label: "Average sentence length",
        ...averageAcross(
          (entry) => Number((entry.outcomes as Record<string, number>)?.avgSentenceLengthRecent ?? 0),
          (entry) => Number((entry.outcomes as Record<string, number>)?.avgSentenceLengthPrevious ?? 0)
        ),
        unit: " words",
        decimals: 1,
        better: "higher",
      },
      {
        key: "latency",
        label: "Time to speak",
        ...averageAcross(
          (entry) => Number((entry.outcomes as Record<string, number>)?.avgTimeToCommunicateRecentMs ?? 0) / 1000,
          (entry) =>
            Number((entry.outcomes as Record<string, number>)?.avgTimeToCommunicatePreviousMs ?? 0) / 1000
        ),
        unit: "s",
        decimals: 2,
        better: "lower",
      },
    ];
  }, [activeTherapistPopulation]);

  const cohortComparisonRows = useMemo(() => {
    const safeCount = Math.max(1, filteredPopulation.length);
    const averageAcross = (
      readCurrent: (entry: ChildRecord) => number,
      readBaseline: (entry: ChildRecord) => number
    ) => {
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
          (entry) => Number((entry.outcomes as Record<string, number>)?.recentAttemptsPerDay ?? 0),
          (entry) => Number((entry.outcomes as Record<string, number>)?.previousAttemptsPerDay ?? 0)
        ),
        unit: "",
        decimals: 2,
        better: "higher",
      },
      {
        key: "vocab",
        label: "Unique vocabulary",
        ...averageAcross(
          (entry) => Number((entry.outcomes as Record<string, number>)?.uniqueVocabularyRecent ?? 0),
          (entry) => Number((entry.outcomes as Record<string, number>)?.uniqueVocabularyPrevious ?? 0)
        ),
        unit: " words",
        decimals: 0,
        better: "higher",
      },
      {
        key: "sentence",
        label: "Average sentence length",
        ...averageAcross(
          (entry) => Number((entry.outcomes as Record<string, number>)?.avgSentenceLengthRecent ?? 0),
          (entry) => Number((entry.outcomes as Record<string, number>)?.avgSentenceLengthPrevious ?? 0)
        ),
        unit: " words",
        decimals: 1,
        better: "higher",
      },
      {
        key: "latency",
        label: "Time to speak",
        ...averageAcross(
          (entry) => Number((entry.outcomes as Record<string, number>)?.avgTimeToCommunicateRecentMs ?? 0) / 1000,
          (entry) =>
            Number((entry.outcomes as Record<string, number>)?.avgTimeToCommunicatePreviousMs ?? 0) / 1000
        ),
        unit: "s",
        decimals: 2,
        better: "lower",
      },
    ];
  }, [filteredPopulation]);

  const translatableStrings = useMemo(() => {
    const staticUi = [
      "Population Outcomes Dashboard",
      "Is this improving outcomes and reducing cost?",
      "MCO Outcomes Platform",
      "Date Range",
      "Report Anchor",
      "Baseline Mode",
      "Age Group",
      "Diagnosis",
      "Therapist",
      "Region",
      "Baseline Start",
      "Baseline End",
      "Weekly (7 days)",
      "Monthly (30 days)",
      "Rolling previous period",
      "Fixed window",
      "Reset Baseline",
      "Refresh Population",
      "Export CSV",
      "Export Pilot Comparison",
      "Export Executive Summary",
      "Download Executive PDF",
      "Export Pilot Packet ZIP",
      "Export Risk Registry",
      "Export Therapist Summary",
      "Export Active Therapist Caseload",
      "Export Therapist Comparison",
      "Export Therapist Drilldown PDF",
      "Export Selected Child",
      "Export Selected Child PDF",
      "Insights",
      "Alerts",
      "At-Risk Registry",
      "Pilot Evidence (Baseline vs Current)",
      "Population",
      "Therapist Performance",
      "Therapist Drilldown",
      "Therapist Baseline vs Current",
      "Children",
      "High Risk",
      "Engagement",
      "Avg Acceptance",
      "Avg Improvement",
      "Avg New Words",
      "Avg Sentence Length",
      "Avg Time to Speak",
      "Communication Trend",
      "Vocabulary Growth",
      "Sentence Length",
      "Time to Speak",
      "Communication attempts/day",
      "Unique vocabulary",
      "Average sentence length",
      "Time to speak",
      "Filter",
      "Focused",
      "Filter Cohort",
      "Clear Filter",
      "Open Child",
      "Action",
      "Risk",
      "Flags",
      "Attempts Δ",
      "No therapist data available for the current filtered cohort.",
      "No at-risk children in the current filtered cohort.",
      "No child records found for the current filters.",
      "No children available for this therapist under current filters.",
      "Language",
      "Speak Summary",
      "Translation ready",
      "Translating...",
      "Translation unavailable (using English)",
      "Population outcomes summary",
    ];

    const dynamic = [
      ...kpis.flatMap((entry) => [entry.title, entry.value]),
      ...insights,
      ...alerts,
      ...cohortComparisonRows.map((entry) => entry.label),
      ...therapistComparisonRows.map((entry) => entry.label),
    ];

    return [...new Set([...staticUi, ...dynamic].filter(Boolean))];
  }, [kpis, insights, alerts, cohortComparisonRows, therapistComparisonRows]);

  useEffect(() => {
    let cancelled = false;

    async function hydrateTranslations() {
      if (normalizeLanguageCode(uiLanguage) === "en") {
        setTranslationMap({});
        setTranslationStatus("ready");
        return;
      }

      try {
        setTranslationStatus("translating");
        const translated = await translateTextBatch(translatableStrings, uiLanguage, {
          sourceLang: "en",
        });
        if (!cancelled) {
          setTranslationMap(translated);
          setTranslationStatus("ready");
        }
      } catch (error) {
        console.error("Failed to translate dashboard copy:", error);
        if (!cancelled) {
          setTranslationStatus("error");
        }
      }
    }

    hydrateTranslations();

    return () => {
      cancelled = true;
    };
  }, [uiLanguage, translatableStrings]);

  const selectedRow = useMemo(() => {
    if (tableRows.length === 0) return null;
    return tableRows.find((entry) => entry.key === selectedChildKey) ?? tableRows[0];
  }, [tableRows, selectedChildKey]);

  useEffect(() => {
    if (tableRows.length === 0) {
      setSelectedChildKey("");
      return;
    }
    if (!selectedChildKey || !tableRows.some((entry) => entry.key === selectedChildKey)) {
      setSelectedChildKey(tableRows[0].key);
    }
  }, [tableRows, selectedChildKey]);

  const selectedComparisonRows = useMemo(() => {
    if (!selectedRow) return [];
    const outcomes = selectedRow.outcomes;
    return [
      {
        key: "attempts",
        label: "Attempts/day",
        baseline: Number(outcomes.previousAttemptsPerDay ?? 0),
        current: Number(outcomes.recentAttemptsPerDay ?? 0),
        delta: Number(outcomes.attemptsPerDayDelta ?? 0),
        unit: "",
        decimals: 2,
      },
      {
        key: "vocab",
        label: "Unique vocab",
        baseline: Number(outcomes.uniqueVocabularyPrevious ?? 0),
        current: Number(outcomes.uniqueVocabularyRecent ?? 0),
        delta: Number(outcomes.uniqueVocabularyDelta ?? 0),
        unit: " words",
        decimals: 0,
      },
      {
        key: "sentence",
        label: "Sentence length",
        baseline: Number(outcomes.avgSentenceLengthPrevious ?? 0),
        current: Number(outcomes.avgSentenceLengthRecent ?? 0),
        delta: Number(outcomes.avgSentenceLengthDelta ?? 0),
        unit: " words",
        decimals: 1,
      },
      {
        key: "latency",
        label: "Time to speak",
        baseline: Number(outcomes.avgTimeToCommunicatePreviousMs ?? 0) / 1000,
        current: Number(outcomes.avgTimeToCommunicateRecentMs ?? 0) / 1000,
        delta: Number(outcomes.timeToCommunicateDelta ?? 0),
        unit: "s",
        decimals: 2,
      },
    ];
  }, [selectedRow]);

  async function speakDashboardSummary() {
    const lines = [
      t("Population outcomes summary"),
      ...kpis.map((entry) => `${t(entry.title)}: ${t(entry.value)}`),
      t("Insights"),
      ...insights.map((entry) => t(entry)),
      t("Alerts"),
      ...alerts.map((entry) => t(entry)),
    ];
    await speakLocalizedText(lines.join(". "), {
      lang: uiLanguage,
      sourceLang: "en",
      rate: 1,
      pitch: 1,
    });
  }

  function resetFixedBaselineRange() {
    const defaults = getDefaultFixedBaselineRange(periodDays, reportNow);
    setBaselineStartKey(defaults.startKey);
    setBaselineEndKey(defaults.endKey);
  }

  function buildPopulationCsvRows() {
    return [
      [
        "parent_uid",
        "child_id",
        "child_name",
        "report_anchor_date",
        "age_group",
        "diagnosis",
        "therapist",
        "region",
        "baseline_mode",
        "baseline_start",
        "baseline_end",
        "attempts_per_day",
        "attempts_delta_pct",
        "new_words",
        "avg_sentence_length",
        "avg_time_to_communicate_seconds",
        "suggestion_acceptance_pct",
        "high_risk",
        "risk_flags",
      ],
      ...tableRows.map((entry) => [
        entry.parentUid,
        entry.childId,
        entry.name,
        formatDateKey(reportNow),
        entry.ageGroup,
        entry.diagnosis,
        entry.therapist,
        entry.region,
        String(entry.outcomes.baselineMode ?? baselineMode),
        String(entry.outcomes.baselineStartKey ?? ""),
        String(entry.outcomes.baselineEndKey ?? ""),
        formatCompactNumber(entry.outcomes.recentAttemptsPerDay ?? 0, 2),
        Math.round(Number(entry.outcomes.attemptsPerDayDelta ?? 0) * 100),
        Math.round(Number(entry.outcomes.newWordsInPeriod ?? 0)),
        formatCompactNumber(entry.outcomes.avgSentenceLengthRecent ?? 0, 2),
        formatCompactNumber(Number(entry.outcomes.avgTimeToCommunicateRecentMs ?? 0) / 1000, 2),
        Math.round(Number(entry.outcomes.suggestionAcceptanceRate ?? 0) * 100),
        Number(entry.outcomes.highRisk ?? 0) ? "yes" : "no",
        entry.riskFlags.join("|"),
      ]),
    ];
  }

  function exportPopulationCsv() {
    if (tableRows.length === 0) return;
    const rows = buildPopulationCsvRows();
    downloadTextFile(
      `mco-population-${dateRange}-${Date.now()}.csv`,
      `${toCsv(rows)}\n`,
      "text/csv;charset=utf-8"
    );
  }

  function buildPilotComparisonCsvRows() {
    return [
      [
        "parent_uid",
        "child_id",
        "child_name",
        "report_anchor_date",
        "age_group",
        "diagnosis",
        "therapist",
        "region",
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
        "time_to_speak_baseline_s",
        "time_to_speak_current_s",
        "time_to_speak_delta_pct",
      ],
      ...tableRows.map((entry) => [
        entry.parentUid,
        entry.childId,
        entry.name,
        formatDateKey(reportNow),
        entry.ageGroup,
        entry.diagnosis,
        entry.therapist,
        entry.region,
        String(entry.outcomes.baselineMode ?? baselineMode),
        String(entry.outcomes.baselineStartKey ?? ""),
        String(entry.outcomes.baselineEndKey ?? ""),
        formatCompactNumber(entry.outcomes.previousAttemptsPerDay ?? 0, 2),
        formatCompactNumber(entry.outcomes.recentAttemptsPerDay ?? 0, 2),
        Math.round(Number(entry.outcomes.attemptsPerDayDelta ?? 0) * 100),
        formatCompactNumber(entry.outcomes.uniqueVocabularyPrevious ?? 0, 0),
        formatCompactNumber(entry.outcomes.uniqueVocabularyRecent ?? 0, 0),
        Math.round(Number(entry.outcomes.uniqueVocabularyDelta ?? 0) * 100),
        formatCompactNumber(entry.outcomes.avgSentenceLengthPrevious ?? 0, 2),
        formatCompactNumber(entry.outcomes.avgSentenceLengthRecent ?? 0, 2),
        Math.round(Number(entry.outcomes.avgSentenceLengthDelta ?? 0) * 100),
        formatCompactNumber(Number(entry.outcomes.avgTimeToCommunicatePreviousMs ?? 0) / 1000, 2),
        formatCompactNumber(Number(entry.outcomes.avgTimeToCommunicateRecentMs ?? 0) / 1000, 2),
        Math.round(Number(entry.outcomes.timeToCommunicateDelta ?? 0) * 100),
      ]),
    ];
  }

  function exportPilotComparisonCsv() {
    if (tableRows.length === 0) return;
    const rows = buildPilotComparisonCsvRows();
    downloadTextFile(
      `mco-pilot-comparison-${dateRange}-${Date.now()}.csv`,
      `${toCsv(rows)}\n`,
      "text/csv;charset=utf-8"
    );
  }

  function buildExecutiveSummaryLines() {
    const filtersApplied =
      ageFilter !== "all" || diagnosisFilter !== "all" || therapistFilter !== "all" || regionFilter !== "all"
        ? [ageFilter, diagnosisFilter, therapistFilter, regionFilter]
            .filter((entry) => entry !== "all")
            .join(", ")
        : "none";

    return [
      `Date range: ${dateRange === "weekly" ? "Last 7 days" : "Last 30 days"}`,
      `Report anchor date: ${formatDateKey(reportNow)}`,
      `Children in cohort: ${filteredPopulation.length}`,
      `Baseline mode: ${baselineMode}`,
      `Baseline window: ${baselineSummaryLabel}`,
      `Applied filters: ${filtersApplied}`,
      `Engagement rate: ${summary.engagementRatePct}%`,
      `Communication improvement: ${formatSignedPercent(summary.avgImprovementPct / 100)}`,
      `Average vocabulary growth: +${Math.round(avgNewWords)} words`,
      `Efficiency change: ${formatSignedPercent(avgEfficiencyDelta)} time`,
      "",
      "Insights:",
      ...insights.map((entry) => `- ${entry}`),
      "",
      "Alerts:",
      ...alerts.map((entry) => `- ${entry}`),
      "",
      "Pilot baseline vs current:",
      ...cohortComparisonRows.map(
        (entry) =>
          `- ${entry.label}: ${formatCompactNumber(entry.baseline, entry.decimals)}${entry.unit} -> ${formatCompactNumber(
            entry.current,
            entry.decimals
          )}${entry.unit} (${formatSignedPercent(entry.delta)})`
      ),
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
    openPrintableReport("MCO Executive Summary", [
      {
        heading: "KPI Overview",
        lines: [
          `Date range: ${dateRange === "weekly" ? "Last 7 days" : "Last 30 days"}`,
          `Report anchor date: ${formatDateKey(reportNow)}`,
          `Children in cohort: ${filteredPopulation.length}`,
          `Baseline mode: ${baselineMode}`,
          `Baseline window: ${baselineSummaryLabel}`,
          `Engagement rate: ${summary.engagementRatePct}%`,
          `Communication improvement: ${formatSignedPercent(summary.avgImprovementPct / 100)}`,
          `Average vocabulary growth: +${Math.round(avgNewWords)} words`,
          `Efficiency change: ${formatSignedPercent(avgEfficiencyDelta)} time`,
        ],
      },
      {
        heading: "Insights",
        lines: insights,
      },
      {
        heading: "Alerts",
        lines: alerts,
      },
      {
        heading: "Pilot Baseline vs Current",
        lines: cohortComparisonRows.map(
          (entry) =>
            `${entry.label}: ${formatCompactNumber(entry.baseline, entry.decimals)}${entry.unit} -> ${formatCompactNumber(
              entry.current,
              entry.decimals
            )}${entry.unit} (${formatSignedPercent(entry.delta)})`
        ),
      },
    ]);
  }

  function buildSelectedChildReportLines() {
    if (!selectedRow) return ["No child selected."];
    const outcomes = selectedRow.outcomes;
    return [
      `Child: ${selectedRow.name}`,
      `Parent UID: ${selectedRow.parentUid}`,
      `Child ID: ${selectedRow.childId}`,
      `Age group: ${selectedRow.ageGroup}`,
      `Diagnosis: ${selectedRow.diagnosis}`,
      `Therapist: ${selectedRow.therapist}`,
      `Region: ${selectedRow.region}`,
      `Report anchor date: ${formatDateKey(reportNow)}`,
      `Period days: ${periodDays}`,
      `Baseline mode: ${baselineMode}`,
      `Baseline window: ${String(outcomes.baselineStartKey ?? "n/a")} to ${String(outcomes.baselineEndKey ?? "n/a")}`,
      "",
      "Baseline vs current:",
      ...selectedComparisonRows.map(
        (entry) =>
          `- ${entry.label}: ${formatCompactNumber(entry.baseline, entry.decimals)}${entry.unit} -> ${formatCompactNumber(
            entry.current,
            entry.decimals
          )}${entry.unit} (${formatSignedPercent(entry.delta)})`
      ),
      "",
      `Risk flags: ${selectedRow.riskFlags.length > 0 ? selectedRow.riskFlags.join(", ") : "none"}`,
    ];
  }

  function buildSelectedChildPdfBytes() {
    const lines = buildSelectedChildReportLines();
    return createSimplePdfFromLines(lines, "MCO Child Drilldown");
  }

  function exportSelectedChildPdf() {
    if (!selectedRow) return;
    const pdfBytes = buildSelectedChildPdfBytes();
    downloadBinaryFile(
      `mco-child-drilldown-${selectedRow.parentUid}-${selectedRow.childId}-${dateRange}-${Date.now()}.pdf`,
      pdfBytes,
      "application/pdf"
    );
  }

  function exportRiskRegistryCsv() {
    if (atRiskRows.length === 0) return;
    const rows = [
      [
        "parent_uid",
        "child_id",
        "child_name",
        "report_anchor_date",
        "risk_band",
        "risk_flags",
        "attempts_per_day",
        "attempts_delta_pct",
        "new_words",
        "avg_sentence_length",
        "avg_time_to_speak_s",
      ],
      ...atRiskRows.map((entry) => [
        entry.parentUid,
        entry.childId,
        entry.name,
        formatDateKey(reportNow),
        entry.risk,
        entry.riskFlags.join("|"),
        formatCompactNumber(entry.outcomes.recentAttemptsPerDay ?? 0, 2),
        Math.round(Number(entry.outcomes.attemptsPerDayDelta ?? 0) * 100),
        Math.round(Number(entry.outcomes.newWordsInPeriod ?? 0)),
        formatCompactNumber(entry.outcomes.avgSentenceLengthRecent ?? 0, 2),
        formatCompactNumber(Number(entry.outcomes.avgTimeToCommunicateRecentMs ?? 0) / 1000, 2),
      ]),
    ];

    downloadTextFile(
      `mco-risk-registry-${dateRange}-${Date.now()}.csv`,
      `${toCsv(rows)}\n`,
      "text/csv;charset=utf-8"
    );
  }

  function buildTherapistSummaryCsvRows() {
    return [
      [
        "therapist",
        "child_count",
        "high_risk_count",
        "engagement_rate_pct",
        "avg_communication_improvement_pct",
        "avg_suggestion_acceptance_pct",
      ],
      ...therapistSummaryRows.map((entry) => [
        entry.therapist,
        entry.childCount,
        entry.highRiskCount,
        entry.engagementRatePct,
        entry.avgImprovementPct,
        entry.avgAcceptancePct,
      ]),
    ];
  }

  function exportTherapistSummaryCsv() {
    if (therapistSummaryRows.length === 0) return;
    downloadTextFile(
      `mco-therapist-summary-${dateRange}-${Date.now()}.csv`,
      `${toCsv(buildTherapistSummaryCsvRows())}\n`,
      "text/csv;charset=utf-8"
    );
  }

  function buildActiveTherapistCaseloadCsvRows() {
    return [
      [
        "therapist",
        "parent_uid",
        "child_id",
        "child_name",
        "report_anchor_date",
        "baseline_mode",
        "baseline_start",
        "baseline_end",
        "risk_band",
        "risk_flags",
        "attempts_per_day",
        "attempts_delta_pct",
        "new_words",
        "avg_sentence_length",
        "avg_time_to_speak_s",
        "suggestion_acceptance_pct",
      ],
      ...activeTherapistRows.map((entry) => [
        activeTherapist,
        entry.parentUid,
        entry.childId,
        entry.name,
        formatDateKey(reportNow),
        String(entry.outcomes.baselineMode ?? baselineMode),
        String(entry.outcomes.baselineStartKey ?? ""),
        String(entry.outcomes.baselineEndKey ?? ""),
        entry.risk,
        entry.riskFlags.join("|"),
        formatCompactNumber(entry.outcomes.recentAttemptsPerDay ?? 0, 2),
        Math.round(Number(entry.outcomes.attemptsPerDayDelta ?? 0) * 100),
        Math.round(Number(entry.outcomes.newWordsInPeriod ?? 0)),
        formatCompactNumber(entry.outcomes.avgSentenceLengthRecent ?? 0, 2),
        formatCompactNumber(Number(entry.outcomes.avgTimeToCommunicateRecentMs ?? 0) / 1000, 2),
        Math.round(Number(entry.outcomes.suggestionAcceptanceRate ?? 0) * 100),
      ]),
    ];
  }

  function exportActiveTherapistCaseloadCsv() {
    if (!activeTherapist || activeTherapistRows.length === 0) return;
    const therapistSlug = toSlug(activeTherapist, "therapist");
    downloadTextFile(
      `mco-therapist-caseload-${therapistSlug}-${dateRange}-${Date.now()}.csv`,
      `${toCsv(buildActiveTherapistCaseloadCsvRows())}\n`,
      "text/csv;charset=utf-8"
    );
  }

  function buildActiveTherapistComparisonCsvRows() {
    return [
      [
        "therapist",
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
        "time_to_speak_baseline_s",
        "time_to_speak_current_s",
        "time_to_speak_delta_pct",
      ],
      ...activeTherapistRows.map((entry) => [
        activeTherapist,
        entry.parentUid,
        entry.childId,
        entry.name,
        formatDateKey(reportNow),
        String(entry.outcomes.baselineMode ?? baselineMode),
        String(entry.outcomes.baselineStartKey ?? ""),
        String(entry.outcomes.baselineEndKey ?? ""),
        formatCompactNumber(entry.outcomes.previousAttemptsPerDay ?? 0, 2),
        formatCompactNumber(entry.outcomes.recentAttemptsPerDay ?? 0, 2),
        Math.round(Number(entry.outcomes.attemptsPerDayDelta ?? 0) * 100),
        formatCompactNumber(entry.outcomes.uniqueVocabularyPrevious ?? 0, 0),
        formatCompactNumber(entry.outcomes.uniqueVocabularyRecent ?? 0, 0),
        Math.round(Number(entry.outcomes.uniqueVocabularyDelta ?? 0) * 100),
        formatCompactNumber(entry.outcomes.avgSentenceLengthPrevious ?? 0, 2),
        formatCompactNumber(entry.outcomes.avgSentenceLengthRecent ?? 0, 2),
        Math.round(Number(entry.outcomes.avgSentenceLengthDelta ?? 0) * 100),
        formatCompactNumber(Number(entry.outcomes.avgTimeToCommunicatePreviousMs ?? 0) / 1000, 2),
        formatCompactNumber(Number(entry.outcomes.avgTimeToCommunicateRecentMs ?? 0) / 1000, 2),
        Math.round(Number(entry.outcomes.timeToCommunicateDelta ?? 0) * 100),
      ]),
    ];
  }

  function exportActiveTherapistComparisonCsv() {
    if (!activeTherapist || activeTherapistRows.length === 0) return;
    const therapistSlug = toSlug(activeTherapist, "therapist");
    downloadTextFile(
      `mco-therapist-comparison-${therapistSlug}-${dateRange}-${Date.now()}.csv`,
      `${toCsv(buildActiveTherapistComparisonCsvRows())}\n`,
      "text/csv;charset=utf-8"
    );
  }

  function buildActiveTherapistReportLines() {
    if (!activeTherapist) return ["No therapist selected."];
    const summary = activeTherapistSummary;
    const lines = [
      `Therapist: ${activeTherapist}`,
      `Report anchor date: ${formatDateKey(reportNow)}`,
      `Period days: ${periodDays}`,
      `Baseline mode: ${baselineMode}`,
      `Baseline window: ${baselineSummaryLabel}`,
      "",
      "Caseload KPI:",
      `- Children: ${summary?.childCount ?? 0}`,
      `- High risk: ${summary?.highRiskCount ?? 0}`,
      `- Engagement: ${summary?.engagementRatePct ?? 0}%`,
      `- Avg communication improvement: ${summary?.avgImprovementPct ?? 0}%`,
      `- Avg suggestion acceptance: ${summary?.avgAcceptancePct ?? 0}%`,
      `- Avg new words: +${formatCompactNumber(activeTherapistAverages.avgNewWords, 1)}`,
      `- Avg sentence length: ${formatCompactNumber(activeTherapistAverages.avgSentenceLength, 1)} words`,
      `- Avg time to speak: ${formatCompactNumber(activeTherapistAverages.avgTimeToSpeakSec, 2)}s`,
      "",
      "Baseline vs current:",
      ...therapistComparisonRows.map(
        (entry) =>
          `- ${entry.label}: ${formatCompactNumber(entry.baseline, entry.decimals)}${entry.unit} -> ${formatCompactNumber(
            entry.current,
            entry.decimals
          )}${entry.unit} (${formatSignedPercent(entry.delta)})`
      ),
      "",
      "Caseload detail:",
    ];

    activeTherapistRows.forEach((entry) => {
      lines.push(
        `${entry.name} (${entry.parentUid}/${entry.childId})`,
        `  Risk: ${entry.risk} | Attempts/day: ${formatCompactNumber(entry.outcomes.recentAttemptsPerDay ?? 0, 2)} | Attempts Δ: ${formatSignedPercent(Number(entry.outcomes.attemptsPerDayDelta ?? 0))}`,
        `  New words: +${Math.round(Number(entry.outcomes.newWordsInPeriod ?? 0))} | Sentence length: ${formatCompactNumber(entry.outcomes.avgSentenceLengthRecent ?? 0, 2)} | Time to speak: ${formatCompactNumber(Number(entry.outcomes.avgTimeToCommunicateRecentMs ?? 0) / 1000, 2)}s`,
        `  Acceptance: ${Math.round(Number(entry.outcomes.suggestionAcceptanceRate ?? 0) * 100)}% | Flags: ${
          entry.riskFlags.length > 0 ? entry.riskFlags.join(", ") : "none"
        }`
      );
    });
    return lines;
  }

  function exportActiveTherapistPdf() {
    if (!activeTherapist || activeTherapistRows.length === 0) return;
    const therapistSlug = toSlug(activeTherapist, "therapist");
    const pdfBytes = createSimplePdfFromLines(
      buildActiveTherapistReportLines(),
      `Therapist Drilldown - ${activeTherapist}`
    );
    downloadBinaryFile(
      `mco-therapist-drilldown-${therapistSlug}-${dateRange}-${Date.now()}.pdf`,
      pdfBytes,
      "application/pdf"
    );
  }

  function buildSelectedChildPayload() {
    if (!selectedRow) return null;
    return {
      generatedAt: new Date().toISOString(),
      reportAnchorDate: formatDateKey(reportNow),
      periodDays,
      baselineMode,
      child: {
        parentUid: selectedRow.parentUid,
        childId: selectedRow.childId,
        name: selectedRow.name,
        ageGroup: selectedRow.ageGroup,
        diagnosis: selectedRow.diagnosis,
        therapist: selectedRow.therapist,
        region: selectedRow.region,
      },
      outcomes: selectedRow.outcomes,
      comparisons: selectedComparisonRows,
    };
  }

  function exportSelectedChildJson() {
    const payload = buildSelectedChildPayload();
    if (!payload || !selectedRow) return;
    downloadTextFile(
      `mco-child-drilldown-${selectedRow.parentUid}-${selectedRow.childId}-${Date.now()}.json`,
      `${JSON.stringify(payload, null, 2)}\n`,
      "application/json"
    );
  }

  function exportPilotPacketZip() {
    if (tableRows.length === 0) return;
    const anchor = formatDateKey(reportNow);
    const executiveLines = buildExecutiveSummaryLines().join("\n");
    const populationCsv = `${toCsv(buildPopulationCsvRows())}\n`;
    const comparisonCsv = `${toCsv(buildPilotComparisonCsvRows())}\n`;
    const childPayload = buildSelectedChildPayload();

    const entries: Array<{ name: string; bytes: Uint8Array | ArrayBuffer | string }> = [
      { name: `executive-summary-${dateRange}-${anchor}.txt`, bytes: `${executiveLines}\n` },
      { name: `population-${dateRange}-${anchor}.csv`, bytes: populationCsv },
      { name: `pilot-comparison-${dateRange}-${anchor}.csv`, bytes: comparisonCsv },
    ];

    if (childPayload && selectedRow) {
      entries.push({
        name: `child-drilldown-${selectedRow.parentUid}-${selectedRow.childId}-${anchor}.json`,
        bytes: `${JSON.stringify(childPayload, null, 2)}\n`,
      });
      entries.push({
        name: `child-drilldown-${selectedRow.parentUid}-${selectedRow.childId}-${anchor}.pdf`,
        bytes: buildSelectedChildPdfBytes(),
      });
    }

    if (activeTherapist && activeTherapistRows.length > 0) {
      const therapistSlug = toSlug(activeTherapist, "therapist");
      entries.push({
        name: `therapist-caseload-${therapistSlug}-${anchor}.csv`,
        bytes: `${toCsv(buildActiveTherapistCaseloadCsvRows())}\n`,
      });
      entries.push({
        name: `therapist-comparison-${therapistSlug}-${anchor}.csv`,
        bytes: `${toCsv(buildActiveTherapistComparisonCsvRows())}\n`,
      });
      entries.push({
        name: `therapist-drilldown-${therapistSlug}-${anchor}.pdf`,
        bytes: createSimplePdfFromLines(
          buildActiveTherapistReportLines(),
          `Therapist Drilldown - ${activeTherapist}`
        ),
      });
    }

    const zipBytes = buildZipArchive(entries);
    downloadBinaryFile(
      `mco-pilot-packet-${dateRange}-${anchor}.zip`,
      zipBytes,
      "application/zip"
    );
  }

  async function refreshPopulation() {
    setLoading(true);
    setError("");
    try {
      const usersSnapshot = await getDocs(collection(db, "users"));
      const perUserChildren = await Promise.all(
        usersSnapshot.docs.map(async (userDoc) => {
          const parentUid = userDoc.id;
          const childrenSnapshot = await getDocs(collection(db, "users", parentUid, "children"));
          return childrenSnapshot.docs.map((childDoc) =>
            normalizeChildSnapshot(parentUid, childDoc.id, childDoc.data() ?? {}, [])
          ) as ChildRecord[];
        })
      );
      setPopulationRaw(perUserChildren.flat());
    } catch (loadError) {
      console.error("Failed to refresh MCO dashboard population:", loadError);
      setPopulationRaw([]);
      setError((loadError as Error)?.message || "Unable to refresh population metrics.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 md:p-6">
      <header className="rounded-3xl border border-blue-200 bg-gradient-to-r from-slate-950 via-blue-900 to-cyan-800 p-6 text-white shadow-lg">
        <p className="text-xs uppercase tracking-[0.2em] text-blue-100">{t("MCO Outcomes Platform")}</p>
        <h1 className="mt-2 text-2xl font-semibold md:text-3xl">{t("Population Outcomes Dashboard")}</h1>
        <p className="mt-2 text-sm text-blue-100">{t("Is this improving outcomes and reducing cost?")}</p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Link
            to="/admin"
            className="inline-flex items-center rounded-xl border border-white/40 bg-white/10 px-3 py-2 text-sm font-medium hover:bg-white/20"
          >
            Back to Admin Workspace
          </Link>
          <button
            onClick={signOut}
            className="inline-flex items-center rounded-xl border border-white/40 bg-white/10 px-3 py-2 text-sm font-medium hover:bg-white/20"
          >
            Sign out
          </button>
        </div>
      </header>

      <section className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-9">
          <label className="grid gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
            {t("Language")}
            <select
              value={uiLanguage}
              onChange={(event) => setUiLanguage(normalizeLanguageCode(event.target.value))}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-800"
            >
              {UI_LANGUAGE_OPTIONS.map((option) => (
                <option key={`ui-lang-${option.code}`} value={option.code}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
            {t("Date Range")}
            <select
              value={dateRange}
              onChange={(event) => setDateRange(event.target.value as "weekly" | "monthly")}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-800"
            >
              <option value="weekly">{t("Weekly (7 days)")}</option>
              <option value="monthly">{t("Monthly (30 days)")}</option>
            </select>
          </label>
          <label className="grid gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
            {t("Report Anchor")}
            <input
              type="date"
              value={anchorDateKey}
              onChange={(event) => setAnchorDateKey(event.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-800"
            />
          </label>
          <label className="grid gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
            {t("Baseline Mode")}
            <select
              value={baselineMode}
              onChange={(event) => setBaselineMode(event.target.value as BaselineMode)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-800"
            >
              <option value="rolling">{t("Rolling previous period")}</option>
              <option value="fixed">{t("Fixed window")}</option>
            </select>
          </label>
          <label className="grid gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
            {t("Age Group")}
            <select
              value={ageFilter}
              onChange={(event) => setAgeFilter(event.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-800"
            >
              {filterOptions.age.map((entry) => (
                <option key={`age-${entry}`} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
            {t("Diagnosis")}
            <select
              value={diagnosisFilter}
              onChange={(event) => setDiagnosisFilter(event.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-800"
            >
              {filterOptions.diagnosis.map((entry) => (
                <option key={`diagnosis-${entry}`} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
            {t("Therapist")}
            <select
              value={therapistFilter}
              onChange={(event) => setTherapistFilter(event.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-800"
            >
              {filterOptions.therapist.map((entry) => (
                <option key={`therapist-${entry}`} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
            {t("Region")}
            <select
              value={regionFilter}
              onChange={(event) => setRegionFilter(event.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-800"
            >
              {filterOptions.region.map((entry) => (
                <option key={`region-${entry}`} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </label>
          {baselineMode === "fixed" ? (
            <>
              <label className="grid gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                {t("Baseline Start")}
                <input
                  type="date"
                  value={normalizedBaseline.startKey}
                  onChange={(event) => setBaselineStartKey(event.target.value)}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-800"
                />
              </label>
              <label className="grid gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                {t("Baseline End")}
                <input
                  type="date"
                  value={normalizedBaseline.endKey}
                  onChange={(event) => setBaselineEndKey(event.target.value)}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-800"
                />
              </label>
              <button
                onClick={resetFixedBaselineRange}
                className="mt-auto rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
              >
                {t("Reset Baseline")}
              </button>
            </>
          ) : null}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search child, parent UID, child ID"
            className="min-w-[280px] flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800"
          />
          <button
            onClick={refreshPopulation}
            className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
          >
            {t("Refresh Population")}
          </button>
          <button
            onClick={exportPopulationCsv}
            className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
            disabled={tableRows.length === 0}
          >
            {t("Export CSV")}
          </button>
          <button
            onClick={exportPilotComparisonCsv}
            className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
            disabled={tableRows.length === 0}
          >
            {t("Export Pilot Comparison")}
          </button>
          <button
            onClick={exportExecutiveSummary}
            className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
            disabled={tableRows.length === 0}
          >
            {t("Export Executive Summary")}
          </button>
          <button
            onClick={exportExecutivePdf}
            className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
            disabled={tableRows.length === 0}
          >
            {t("Download Executive PDF")}
          </button>
          <button
            onClick={exportPilotPacketZip}
            className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
            disabled={tableRows.length === 0}
          >
            {t("Export Pilot Packet ZIP")}
          </button>
          <button
            onClick={exportRiskRegistryCsv}
            className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
            disabled={atRiskRows.length === 0}
          >
            {t("Export Risk Registry")}
          </button>
          <button
            onClick={exportTherapistSummaryCsv}
            className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
            disabled={therapistSummaryRows.length === 0}
          >
            {t("Export Therapist Summary")}
          </button>
          <button
            onClick={exportActiveTherapistCaseloadCsv}
            className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
            disabled={!activeTherapist || activeTherapistRows.length === 0}
          >
            {t("Export Active Therapist Caseload")}
          </button>
          <button
            onClick={exportActiveTherapistComparisonCsv}
            className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
            disabled={!activeTherapist || activeTherapistRows.length === 0}
          >
            {t("Export Therapist Comparison")}
          </button>
          <button
            onClick={exportActiveTherapistPdf}
            className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
            disabled={!activeTherapist || activeTherapistRows.length === 0}
          >
            {t("Export Therapist Drilldown PDF")}
          </button>
          <button
            onClick={() => {
              void speakDashboardSummary();
            }}
            className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700 hover:bg-blue-100"
          >
            {t("Speak Summary")}
          </button>
          <button
            onClick={exportSelectedChildJson}
            className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
            disabled={!selectedRow}
          >
            {t("Export Selected Child")}
          </button>
          <button
            onClick={exportSelectedChildPdf}
            className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
            disabled={!selectedRow}
          >
            {t("Export Selected Child PDF")}
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          {translationStatus === "translating"
            ? t("Translating...")
            : translationStatus === "error"
              ? t("Translation unavailable (using English)")
              : t("Translation ready")}
        </p>
        <p className="mt-2 text-xs text-slate-500">
          Report anchor: {formatDateKey(reportNow)} | Population size: {filteredPopulation.length} | {baselineSummaryLabel} | Filters:{" "}
          {ageFilter !== "all" || diagnosisFilter !== "all" || therapistFilter !== "all" || regionFilter !== "all"
            ? [ageFilter, diagnosisFilter, therapistFilter, regionFilter]
                .filter((entry) => entry !== "all")
                .join(", ")
            : "none"}
        </p>
        {loading ? <p className="mt-2 text-sm text-blue-700">Loading population data...</p> : null}
        {error ? <p className="mt-2 text-sm text-red-700">{error}</p> : null}
      </section>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {kpis.map((kpi, i) => (
          <Card key={i} className="rounded-2xl shadow-sm">
            <CardContent className="p-4">
              <p className="text-sm text-gray-500">{t(kpi.title)}</p>
              <p className="mt-2 text-xl font-semibold">{t(kpi.value)}</p>
            </CardContent>
          </Card>
        ))}
      </section>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <MiniBarChart
          title={t("Communication Trend")}
          subtitle="Daily communication attempts (population aggregate)"
          points={communicationSeries}
          fromColor="#7dd3fc"
          toColor="#2563eb"
        />
        <MiniBarChart
          title={t("Vocabulary Growth")}
          subtitle="Daily unique vocabulary observed from timed sentence events"
          points={vocabularySeries}
          fromColor="#86efac"
          toColor="#15803d"
        />
        <MiniBarChart
          title={t("Sentence Length")}
          subtitle="Average words per sentence by day"
          points={sentenceLengthSeries}
          fromColor="#c4b5fd"
          toColor="#6d28d9"
        />
        <MiniBarChart
          title={t("Time to Speak")}
          subtitle="Average seconds to communicate by day"
          points={latencySeries}
          fromColor="#fda4af"
          toColor="#be123c"
        />
      </section>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card className="rounded-2xl shadow-sm">
          <CardContent className="p-4">
            <h3 className="mb-3 font-medium">{t("Insights")}</h3>
            <ul className="space-y-2 text-sm text-gray-600">
              {insights.map((entry) => (
                <li key={entry}>{t(entry)}</li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card className="rounded-2xl shadow-sm">
          <CardContent className="p-4">
            <h3 className="mb-3 font-medium">{t("Alerts")}</h3>
            <ul className="space-y-2 text-sm text-red-600">
              {alerts.map((entry) => (
                <li key={entry}>{t(entry)}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </section>

      <Card className="rounded-2xl shadow-sm">
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-medium">{t("At-Risk Registry")}</h3>
            <span className="text-xs text-slate-500">{atRiskRows.length} flagged children</span>
          </div>
          {atRiskRows.length === 0 ? (
            <p className="text-sm text-slate-600">{t("No at-risk children in the current filtered cohort.")}</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 text-left text-slate-500">
                    <th className="px-3 py-2">Child</th>
                    <th className="px-3 py-2">Risk</th>
                    <th className="px-3 py-2">Flags</th>
                    <th className="px-3 py-2">Attempts Δ</th>
                    <th className="px-3 py-2">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {atRiskRows.map((entry) => (
                    <tr key={`risk-${entry.key}`} className="border-t border-slate-200">
                      <td className="px-3 py-2">
                        <div className="font-medium text-slate-800">{entry.name}</div>
                        <div className="text-xs text-slate-500">
                          {entry.parentUid} / {entry.childId}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <span className={entry.risk === "High" ? "text-rose-700" : "text-amber-700"}>
                          {entry.risk}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-600">
                        {entry.riskFlags.length > 0 ? entry.riskFlags.join(", ") : "none"}
                      </td>
                      <td className="px-3 py-2">{formatSignedPercent(Number(entry.outcomes.attemptsPerDayDelta ?? 0))}</td>
                      <td className="px-3 py-2">
                        <button
                          onClick={() => setSelectedChildKey(entry.key)}
                          className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
                        >
                          Open Child
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="rounded-2xl shadow-sm">
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-medium">{t("Therapist Performance")}</h3>
            <span className="text-xs text-slate-500">{therapistSummaryRows.length} therapists in cohort</span>
          </div>
          {therapistSummaryRows.length === 0 ? (
            <p className="text-sm text-slate-600">{t("No therapist data available for the current filtered cohort.")}</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 text-left text-slate-500">
                    <th className="px-3 py-2">Therapist</th>
                    <th className="px-3 py-2">Children</th>
                    <th className="px-3 py-2">High Risk</th>
                    <th className="px-3 py-2">Engagement</th>
                    <th className="px-3 py-2">Avg Improvement</th>
                    <th className="px-3 py-2">Avg Acceptance</th>
                    <th className="px-3 py-2">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {therapistSummaryRows.map((entry) => (
                    <tr key={`therapist-${entry.therapist}`} className="border-t border-slate-200">
                      <td className="px-3 py-2 font-medium text-slate-800">{entry.therapist}</td>
                      <td className="px-3 py-2">{entry.childCount}</td>
                      <td className="px-3 py-2">
                        <span className={entry.highRiskCount > 0 ? "text-rose-700" : "text-slate-700"}>
                          {entry.highRiskCount}
                        </span>
                      </td>
                      <td className="px-3 py-2">{entry.engagementRatePct}%</td>
                      <td className="px-3 py-2">{entry.avgImprovementPct}%</td>
                      <td className="px-3 py-2">{entry.avgAcceptancePct}%</td>
                      <td className="px-3 py-2">
                        <button
                          onClick={() => {
                            setSelectedTherapistName(entry.therapist);
                            setTherapistFilter(entry.therapist);
                          }}
                          className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
                        >
                          {activeTherapist === entry.therapist ? t("Focused") : t("Filter")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {activeTherapist ? (
        <>
          <Card className="rounded-2xl shadow-sm">
            <CardContent className="space-y-4 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-medium">{t("Therapist Drilldown")}</h3>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={activeTherapist}
                    onChange={(event) => setSelectedTherapistName(event.target.value)}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800"
                  >
                    {therapistSummaryRows.map((entry) => (
                      <option key={`drilldown-therapist-${entry.therapist}`} value={entry.therapist}>
                        {entry.therapist}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => setTherapistFilter(activeTherapist)}
                    className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-700 hover:bg-slate-100"
                  >
                    {t("Filter Cohort")}
                  </button>
                  <button
                    onClick={() => setTherapistFilter("all")}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-700 hover:bg-slate-50"
                    disabled={therapistFilter === "all"}
                  >
                    {t("Clear Filter")}
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
                <article className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Children</p>
                  <p className="mt-2 text-lg font-semibold text-slate-800">{activeTherapistSummary?.childCount ?? 0}</p>
                </article>
                <article className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">High Risk</p>
                  <p className="mt-2 text-lg font-semibold text-rose-700">{activeTherapistSummary?.highRiskCount ?? 0}</p>
                </article>
                <article className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Engagement</p>
                  <p className="mt-2 text-lg font-semibold text-slate-800">{activeTherapistSummary?.engagementRatePct ?? 0}%</p>
                </article>
                <article className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Avg Acceptance</p>
                  <p className="mt-2 text-lg font-semibold text-slate-800">{activeTherapistSummary?.avgAcceptancePct ?? 0}%</p>
                </article>
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <article className="rounded-xl border border-slate-200 bg-white p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Avg New Words</p>
                  <p className="mt-2 text-base font-semibold text-slate-800">
                    +{formatCompactNumber(activeTherapistAverages.avgNewWords, 1)}
                  </p>
                </article>
                <article className="rounded-xl border border-slate-200 bg-white p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Avg Sentence Length</p>
                  <p className="mt-2 text-base font-semibold text-slate-800">
                    {formatCompactNumber(activeTherapistAverages.avgSentenceLength, 1)} words
                  </p>
                </article>
                <article className="rounded-xl border border-slate-200 bg-white p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Avg Time to Speak</p>
                  <p className="mt-2 text-base font-semibold text-slate-800">
                    {formatCompactNumber(activeTherapistAverages.avgTimeToSpeakSec, 2)}s
                  </p>
                </article>
              </div>

              <div>
                <h4 className="mb-2 text-sm font-semibold text-slate-700">{t("Therapist Baseline vs Current")}</h4>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
                  {therapistComparisonRows.map((entry) => {
                    const improved = entry.better === "lower" ? entry.delta <= 0 : entry.delta >= 0;
                    return (
                      <article key={`therapist-comparison-${entry.key}`} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t(entry.label)}</p>
                        <div className="mt-2 text-xs text-slate-600">
                          Baseline: {formatCompactNumber(entry.baseline, entry.decimals)}
                          {entry.unit}
                        </div>
                        <div className="text-sm font-medium text-slate-800">
                          Current: {formatCompactNumber(entry.current, entry.decimals)}
                          {entry.unit}
                        </div>
                        <div className={`mt-1 text-xs font-semibold ${improved ? "text-emerald-700" : "text-rose-700"}`}>
                          {formatSignedPercent(entry.delta)}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </div>

              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 text-left text-slate-500">
                      <th className="px-3 py-2">Child</th>
                      <th className="px-3 py-2">Risk</th>
                      <th className="px-3 py-2">Attempts Δ</th>
                      <th className="px-3 py-2">Acceptance</th>
                      <th className="px-3 py-2">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeTherapistRows.map((entry) => (
                      <tr key={`drilldown-child-${entry.key}`} className="border-t border-slate-200">
                        <td className="px-3 py-2">
                          <div className="font-medium text-slate-800">{entry.name}</div>
                          <div className="text-xs text-slate-500">
                            {entry.parentUid} / {entry.childId}
                          </div>
                        </td>
                        <td className="px-3 py-2">{entry.risk}</td>
                        <td className="px-3 py-2">{formatSignedPercent(Number(entry.outcomes.attemptsPerDayDelta ?? 0))}</td>
                        <td className="px-3 py-2">
                          {Math.round(Number(entry.outcomes.suggestionAcceptanceRate ?? 0) * 100)}%
                        </td>
                        <td className="px-3 py-2">
                          <button
                            onClick={() => setSelectedChildKey(entry.key)}
                            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
                          >
                            Open Child
                          </button>
                        </td>
                      </tr>
                    ))}
                    {activeTherapistRows.length === 0 ? (
                      <tr className="border-t border-slate-200">
                        <td className="px-3 py-3 text-slate-500" colSpan={5}>
                          No children available for this therapist under current filters.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <MiniBarChart
            title="Therapist Communication Trend"
            subtitle={`Daily communication attempts for ${activeTherapist}`}
            points={therapistCommunicationSeries}
            fromColor="#93c5fd"
            toColor="#1d4ed8"
          />
        </>
      ) : null}

      <Card className="rounded-2xl shadow-sm">
        <CardContent className="space-y-3 p-4">
          <h3 className="font-medium">{t("Pilot Evidence (Baseline vs Current)")}</h3>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            {cohortComparisonRows.map((entry) => {
              const improved = entry.better === "lower" ? entry.delta <= 0 : entry.delta >= 0;
              return (
                <article key={entry.key} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t(entry.label)}</p>
                  <div className="mt-2 text-xs text-slate-600">
                    Baseline: {formatCompactNumber(entry.baseline, entry.decimals)}
                    {entry.unit}
                  </div>
                  <div className="text-sm font-medium text-slate-800">
                    Current: {formatCompactNumber(entry.current, entry.decimals)}
                    {entry.unit}
                  </div>
                  <div className={`mt-1 text-xs font-semibold ${improved ? "text-emerald-700" : "text-rose-700"}`}>
                    {formatSignedPercent(entry.delta)}
                  </div>
                </article>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-2xl shadow-sm">
        <CardContent className="p-4">
          <h3 className="mb-4 font-medium">{t("Population")}</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500">
                  <th className="py-2">Child</th>
                  <th>Usage</th>
                  <th>Growth</th>
                  <th>Risk</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {tableRows.map((row) => (
                  <tr key={row.key} className="border-t border-slate-200">
                    <td className="py-2">
                      <div className="font-medium text-slate-800">{row.name}</div>
                      <div className="text-xs text-slate-500">
                        {row.parentUid} / {row.childId}
                      </div>
                      <div className="text-xs text-slate-500">
                        {row.ageGroup} · {row.diagnosis} · {row.region}
                      </div>
                    </td>
                    <td>{row.usage}</td>
                    <td>{row.growth}</td>
                    <td>{row.risk}</td>
                    <td>{row.status}</td>
                    <td>
                      <button
                        onClick={() => setSelectedChildKey(row.key)}
                        className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
                      >
                        {selectedRow?.key === row.key ? "Selected" : "Open"}
                      </button>
                    </td>
                  </tr>
                ))}
                {tableRows.length === 0 ? (
                  <tr className="border-t border-slate-200">
                    <td className="py-3 text-slate-500" colSpan={6}>
                      No child records found for the current filters.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {selectedRow ? (
        <Card className="rounded-2xl shadow-sm">
          <CardContent className="space-y-4 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="font-medium">Child Drilldown: {selectedRow.name}</h3>
                <p className="text-xs text-slate-500">
                  {selectedRow.parentUid} / {selectedRow.childId}
                </p>
                <p className="text-xs text-slate-500">
                  {selectedRow.ageGroup} · {selectedRow.diagnosis} · Therapist: {selectedRow.therapist}
                </p>
              </div>
              <div className="text-xs text-slate-500">
                Baseline: {String(selectedRow.outcomes.baselineStartKey ?? "n/a")} to{" "}
                {String(selectedRow.outcomes.baselineEndKey ?? "n/a")}
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
              {selectedComparisonRows.map((entry) => (
                <article key={entry.key} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t(entry.label)}</p>
                  <div className="mt-2 text-xs text-slate-600">
                    Baseline: {formatCompactNumber(entry.baseline, entry.decimals)}
                    {entry.unit}
                  </div>
                  <div className="text-sm font-medium text-slate-800">
                    Current: {formatCompactNumber(entry.current, entry.decimals)}
                    {entry.unit}
                  </div>
                  <div
                    className={`mt-1 text-xs font-semibold ${
                      entry.key === "latency"
                        ? entry.delta <= 0
                          ? "text-emerald-700"
                          : "text-rose-700"
                        : entry.delta >= 0
                          ? "text-emerald-700"
                          : "text-rose-700"
                    }`}
                  >
                    {formatSignedPercent(entry.delta)}
                  </div>
                </article>
              ))}
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Risk Flags</p>
              <p className="mt-1 text-sm text-slate-700">
                {selectedRow.riskFlags.length > 0 ? selectedRow.riskFlags.join(", ") : "None"}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
