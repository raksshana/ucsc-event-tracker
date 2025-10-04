// CommonJS version (no "type": "module" needed)
require("dotenv").config();

const k = process.env.GOOGLE_PRIVATE_KEY || "";
console.log("OPENAI_API_KEY set:", !!process.env.OPENAI_API_KEY);
console.log("GOOGLE_CLIENT_EMAIL:", process.env.GOOGLE_CLIENT_EMAIL || "(missing)");
console.log("Has BEGIN in private key:", k.includes("BEGIN PRIVATE KEY"));
console.log("Has literal \\n:", k.includes("\\n"));
console.log("Decoded contains newlines:", k.replace(/\\n/g, "\n").includes("\n"));
console.log("SHEET_ID:", process.env.SHEET_ID || "(missing)");
console.log("SHEET_RANGE:", process.env.SHEET_RANGE || "(missing)");
