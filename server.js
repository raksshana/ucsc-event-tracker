import "dotenv/config";
import express from "express";
import OpenAI from "openai";
import { google } from "googleapis";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* ----------------- create app FIRST ----------------- */
const app = express();
app.use(express.json());
app.use(cors({ origin: "*", methods: ["GET","POST"] }));

/* ----------------- serve /public ----------------- */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, "public")));

/* ----------------- config & helpers ----------------- */
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ----------------- OpenAI client ----------------- */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ----------------- Google Sheets client ----------------- */
const auth = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  null,
  (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  ["https://www.googleapis.com/auth/spreadsheets.readonly"]
);
const sheets = google.sheets({ version: "v4", auth });

/* ----------------- in-memory cache ----------------- */
let cachedEvents = [];

/* ----------------- JSON schema for strict output ----------------- */
const classificationSchema = {
  name: "EventClassification",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      category: {
        type: "string",
        enum: [
          "Academic","Career","Social","Cultural","Sports",
          "Workshop","Volunteer","Club/Org","Admin/Advising","Other"
        ]
      },
      tags: { type: "array", items: { type: "string" }, maxItems: 8 },
      audience: {
        type: "array",
        items: { type: "string", enum: ["Undergrad","Grad","Alumni","Staff","Public"] },
        minItems: 1, maxItems: 3
      },
      normalized_date: { type: "string", format: "date-time" },
      location_type: { type: "string", enum: ["On-campus","Off-campus","Virtual","Hybrid"] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      rationale: { type: "string" }
    },
    required: [
      "category","tags","audience","normalized_date",
      "location_type","confidence","rationale"
    ]
  }
};

/* ----------------- light date parsing for fallback ----------------- */
function parseCampusDate(s) {
  if (!s) return new Date();
  const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,sept:8,oct:9,nov:10,dec:11 };
  const str = s.trim().toLowerCase().replace(/\s+/g, " ");
  const parts = str.split(" "); // e.g., ["sept","26","6:00pm"]
  const y = new Date().getFullYear();
  const m = months[parts[0]];
  const d = parseInt(parts[1], 10) || 1;

  let hh = 9, mm = 0; // default 9:00
  const timeRaw = parts.slice(2).join(" ");
  if (timeRaw) {
    const m2 = timeRaw.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
    if (m2) {
      hh = parseInt(m2[1],10);
      mm = m2[2] ? parseInt(m2[2],10) : 0;
      const mer = m2[3];
      if (mer === "pm" && hh < 12) hh += 12;
      if (mer === "am" && hh === 12) hh = 0;
    }
  }
  if (m == null || isNaN(d)) return new Date();
  return new Date(y, m, d, hh, mm, 0);
}

/* ----------------- fallback classification (for 429 etc.) ----------------- */
function fallbackClassification(ev) {
  const text = `${ev.title} ${ev.description} ${ev.location}`.toLowerCase();
  const tokens = new Set((text.match(/[a-z0-9]+/g) || []));
  const has = (w) => tokens.has(w);

  let category = "Other";
  if (has("workshop") || has("tutorial") || has("bootcamp")) category = "Workshop";
  else if (has("career") || has("recruit") || has("internship")) category = "Career";
  else if (has("game") || has("party") || has("mixer") || has("social")) category = "Social";
  else if (has("club") || has("org") || has("meeting")) category = "Club/Org";
  else if (has("volunteer") || has("service")) category = "Volunteer";
  else if (has("lecture") || has("seminar") || has("talk") || has("colloquium")) category = "Academic";
  else if (has("basketball") || has("soccer") || has("run") || has("tournament")) category = "Sports";
  else if (has("heritage") || has("cultural") || has("festival") || has("film")) category = "Cultural";

  const audience = ["Undergrad"];
  if (has("graduate") || has("phd") || has("ms")) audience.push("Grad");
  if (has("alumni")) audience.push("Alumni");
  if (has("staff")) audience.push("Staff");
  if (has("public") || has("community")) audience.push("Public");

  const location_type =
    (has("zoom") || has("virtual") || has("online")) ? "Virtual" :
    has("hybrid") ? "Hybrid" :
    (has("campus") || has("hall") || has("center") || has("theater") || has("lab")) ? "On-campus" :
    "Off-campus";

  const normalized_date = parseCampusDate(ev.date || "").toISOString();

  const tags = [];
  if (category !== "Other") tags.push(category.toLowerCase());
  if (has("free")) tags.push("free");
  if (has("food") || has("pizza")) tags.push("food");
  if (has("resume")) tags.push("resume");
  if (has("tech") || has("cs") || has("gds")) tags.push("tech");

  return {
    category,
    tags: Array.from(new Set(tags)).slice(0, 8),
    audience: audience.slice(0, 3),
    normalized_date,
    location_type,
    confidence: 0.25,
    rationale: "Fallback classification used due to API quota or transient errors."
  };
}

/* ----------------- Sheet row -> event object (adjust to your columns) ----------------- */
function rowToEvent(row = []) {
  return {
    title:       row[0] || "",
    date:        row[1] || "",   // e.g., "sept 26 6:00pm"
    time:        "",             // (no separate time column)
    location:    row[2] || "",
    org:         row[3] || "",
    description: row[4] || "",
    url:         row[5] || ""
  };
}

/* ----------------- OpenAI classify (structured output) ----------------- */
async function classifyEvent(ev) {
  const prompt = `
You are classifying UCSC campus events for a student website.
Return ONLY valid JSON that matches the provided JSON schema.
- Normalize date/time to ISO 8601 in America/Los_Angeles.
- If only a date exists, default time to 09:00:00.
- Detect location_type from "Zoom/virtual/online/hybrid/campus" hints.
- Tags should be concise (<=8), useful, and lowercase.

Event:
Title: ${ev.title || ""}
Description: ${ev.description || ""}
When: ${ev.date || ""} ${ev.time || ""}
Where: ${ev.location || ""}
Org: ${ev.org || ""}
URL: ${ev.url || ""}
`.trim();

  const resp = await openai.responses.create({
    model: MODEL,
    input: prompt,
    text: {
      format: {
        type: "json_schema",
        name: classificationSchema.name,
        schema: classificationSchema.schema
      }
    }
  });

  try {
    return JSON.parse(resp.output_text);
  } catch {
    throw new Error("bad_json");
  }
}

/* ----------------- retry wrapper with backoff + fallback ----------------- */
async function classifyWithRetry(ev, maxRetries = 2) {
  let delay = 1500;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await classifyEvent(ev);
    } catch (e) {
      const status = e?.status || e?.response?.status;
      const is429 = status === 429;
      const is5xx = status >= 500 && status < 600;
      if (attempt < maxRetries && (is429 || is5xx || e.message === "bad_json")) {
        await sleep(delay);
        delay *= 2;
        continue;
      }
      return fallbackClassification(ev);
    }
  }
}

/* ----------------- routes ----------------- */
app.post("/api/refresh", async (req, res) => {
  if (process.env.REFRESH_TOKEN && req.query.token !== process.env.REFRESH_TOKEN) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  try {
    const range = process.env.SHEET_RANGE || "Events!A2:G";
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range,
      majorDimension: "ROWS",
      valueRenderOption: "UNFORMATTED_VALUE"
    });

    const rows = data.values || [];
    const rawEvents = rows.map(rowToEvent);

    const max = Number(process.env.MAX_EVENTS || rawEvents.length);
    const toClassify = rawEvents.slice(0, max);

    const results = [];
    for (const ev of toClassify) {
      const cls = await classifyWithRetry(ev);
      results.push({ ...ev, classification: cls });
    }

    cachedEvents = results;
    res.json({ ok: true, count: results.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e?.message || "unknown_error" });
  }
});

app.get("/api/events", (req, res) => {
  res.json({ events: cachedEvents });
});

/* ----------------- start server ----------------- */
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server on http://localhost:${port}`);
});
