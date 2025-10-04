import "dotenv/config";
import { google } from "googleapis";

const auth = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  null,
  (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  ["https://www.googleapis.com/auth/spreadsheets.readonly"]
);
const sheets = google.sheets({ version: "v4", auth });

const main = async () => {
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: process.env.SHEET_RANGE || "Events!A2:G",
    majorDimension: "ROWS",
    valueRenderOption: "UNFORMATTED_VALUE"
  });
  console.log("Rows found:", data.values?.length || 0);
  console.log("First row sample:", data.values?.[0]);
};
main().catch(console.error);
