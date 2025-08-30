// index.js
require("dotenv").config();
const restify = require("restify");
const sql = require("mssql");
const OpenAI = require("openai");
const {
  CloudAdapter,
  ConfigurationServiceClientCredentialFactory,
  createBotFrameworkAuthenticationFromConfiguration
} = require("botbuilder");

// -------------------------------
// 1) Azure SQL config
// -------------------------------
const baseDbConfig = {
  server: process.env.AZURE_SQL_SERVER,
  database: process.env.AZURE_SQL_DATABASE,
  options: { encrypt: true }
};

const dbConfig = {
  ...baseDbConfig,
  user: process.env.AZURE_SQL_USER,
  // remove accidental quotes in .env
  password: (process.env.AZURE_SQL_PASSWORD || "").replace(/['"]/g, "")
};

// -------------------------------
// 2) Azure OpenAI config
// -------------------------------
const openai = new OpenAI({
  apiKey: (process.env.AZURE_OPENAI_KEY || "").replace(/['"]/g, ""),
  baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}`,
  defaultQuery: { "api-version": "2024-08-01-preview" },
  defaultHeaders: { "api-key": (process.env.AZURE_OPENAI_KEY || "").replace(/['"]/g, "") }
});

// -------------------------------
// 3) Bot auth (SingleTenant)
// -------------------------------
const credentialsFactory = new ConfigurationServiceClientCredentialFactory({
  MicrosoftAppId: process.env.MICROSOFT_APP_ID,
  MicrosoftAppPassword: process.env.MICROSOFT_APP_PASSWORD,
  MicrosoftAppType: "SingleTenant",
  MicrosoftAppTenantId: process.env.MICROSOFT_TENANT_ID
});
const botFrameworkAuthentication =
  createBotFrameworkAuthenticationFromConfiguration(null, credentialsFactory);
const adapter = new CloudAdapter(botFrameworkAuthentication);

// -------------------------------
// 4) Conversation memory
// -------------------------------
const memory = {}; // userId -> [{role, content}]

// -------------------------------
// 5) DB helpers
// -------------------------------
async function runQuery(sqlText) {
  try {
    const pool = await sql.connect(dbConfig);
    const result = await pool.request().query(sqlText);
    await pool.close();
    return result.recordset;
  } catch (err) {
    console.error("SQL error:", err);
    return { error: err.message };
  }
}

async function getDbSchema() {
  const pool = await sql.connect(dbConfig);
  try {
    const result = await pool.request().query(`
      SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
    `);
    const schema = {};
    for (const r of result.recordset) {
      const key = `${r.TABLE_SCHEMA}.${r.TABLE_NAME}`;
      if (!schema[key]) schema[key] = [];
      schema[key].push(r.COLUMN_NAME);
    }
    return schema;
  } finally {
    await pool.close();
  }
}

// -------------------------------
// 6) SQL cleaning & normalization
// -------------------------------

// Extract the first real SELECT/WITH statement from model output
function extractFirstSelectOrWith(text) {
  if (!text) return "";
  let s = text.replace(/```sql/gi, "```").replace(/```/g, "\n").trim();
  // Remove leading markdown-ish lines like "Here is the SQL:"
  s = s.replace(/^[^\n]*?:\s*$/m, "").trim();

  // Strip block and line comments
  s = s.replace(/\/\*[\s\S]*?\*\//g, "");
  s = s.replace(/--.*$/gm, "");

  const idxSel = s.search(/\bselect\b/i);
  const idxWith = s.search(/\bwith\b/i);
  let start = -1;
  if (idxSel >= 0 && idxWith >= 0) start = Math.min(idxSel, idxWith);
  else start = Math.max(idxSel, idxWith);

  if (start < 0) return s.trim();

  // From first SELECT/WITH to end
  return s.slice(start).trim();
}

// Normalize to Azure SQL (T-SQL)
function normalizeSqlForAzureSql(sqlText) {
  let fixed = (sqlText || "").trim();

  // Fix accidental '==' operators
  fixed = fixed.replace(/==/g, "=");

  // Convert LIMIT n to OFFSET/FETCH (append if not already present)
  const limitMatch = fixed.match(/limit\s+(\d+)/i);
  if (limitMatch) {
    const n = parseInt(limitMatch[1], 10);
    // remove LIMIT clause (and trailing semicolon if any)
    fixed = fixed.replace(/limit\s+\d+/i, "").replace(/;+\s*$/g, "").trim();

    // if there's no ORDER BY, add a stable one to use OFFSET/FETCH
    if (!/\border\s+by\b/i.test(fixed)) {
      // best effort: use first selected column name if we can
      const selCol = (fixed.match(/select\s+distinct\s+([^\s,]+)/i) ||
                      fixed.match(/select\s+top\s+\d+\s+([^\s,]+)/i) ||
                      fixed.match(/select\s+([^\s,]+)/i));
      const orderCol = selCol ? selCol[1] : "(SELECT NULL)";
      fixed += ` ORDER BY ${orderCol}`;
    }
    fixed += ` OFFSET 0 ROWS FETCH NEXT ${n} ROWS ONLY`;
  }

  // Replace ILIKE with LIKE
  fixed = fixed.replace(/\bILIKE\b/gi, "LIKE");

  // Replace booleans with 1/0
  fixed = fixed.replace(/\btrue\b/gi, "1").replace(/\bfalse\b/gi, "0");

  // Convert "abc" string literals to 'abc' (avoid touching identifiers in [brackets])
  fixed = fixed.replace(/"([^"]*)"/g, "'$1'");

  // Ensure trailing semicolon
  fixed = fixed.replace(/;+\s*$/g, "");
  fixed = fixed + ";";

  return fixed;
}

// Check that the final SQL is read-only (SELECT/WITH) and does not include DML/DDL
function isReadOnlySelect(finalSql) {
  const stripped = finalSql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--.*$/gm, "")
    .trim()
    .toLowerCase();

  const startsOk = /^(select|with)\b/.test(stripped);
  const forbidden = /\b(update|delete|insert|drop|alter|create|merge|truncate|exec|execute|sp_exec)/i.test(finalSql);
  return startsOk && !forbidden;
}

// -------------------------------
// 7) LLM prompts
// -------------------------------
async function generateSql(userInput, history, schemaInfo) {
  let schemaDescription = "";
  for (const [table, cols] of Object.entries(schemaInfo)) {
    schemaDescription += `${table}: ${cols.join(", ")}\n`;
  }

  const sys = `
You convert user questions into **Azure SQL (Microsoft SQL Server T-SQL)**.
Use ONLY these tables/columns exactly as listed:
${schemaDescription}

RULES:
- Return ONLY a single read-only query (SELECT or CTE + SELECT). No DDL/DML.
- Do NOT use "USE <db>" or touch other databases.
- Do NOT invent tables/columns not in the schema.
- Prefer T-SQL idioms: TOP n or OFFSET/FETCH (NOT LIMIT).
- If user says "list" or "show", do not summarize—return the rows the user asked for.
- If user asks "how many/total/count", return a COUNT query.
- Never add filters (e.g., dates) unless explicitly requested.
`;

  const response = await openai.chat.completions.create({
    model: process.env.AZURE_OPENAI_DEPLOYMENT,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: userInput }
    ],
    temperature: 0,
    max_tokens: 400
  });

  return response.choices?.[0]?.message?.content || "";
}

// Summarize or list results
async function summarizeResults(userQuestion, sqlRan, results) {
  if (results.error) return `⚠️ SQL Error: ${results.error}`;
  if (!results || results.length === 0) return "No results found.";

  const wantsList = /\b(list|show|display|give me all|enumerate)\b/i.test(userQuestion);
  const isDistinct = /\bselect\s+distinct\b/i.test(sqlRan);

  // If user wanted a list (esp. DISTINCT) and the result set is small, list directly
  if (wantsList || isDistinct) {
    if (results.length <= 50) {
      // Pretty list: if single column, show as bullet list; else show JSON lines
      const cols = Object.keys(results[0] || {});
      if (cols.length === 1) {
        const col = cols[0];
        const values = results.map(r => r[col]);
        return `Here are the ${isDistinct ? "distinct " : ""}${col} values (${values.length}):\n- ${values.join("\n- ")}`;
      } else {
        return `Here are the results (${results.length} rows):\n` +
          results.map(r => "- " + Object.entries(r).map(([k, v]) => `${k}: ${v}`).join(", ")).join("\n");
      }
    }
    // If large, give count and first 50
    const cols = Object.keys(results[0] || {});
    const preview = results.slice(0, 50);
    const header = cols.join(", ");
    const lines = preview.map(r => cols.map(c => r[c]).join(" | "));
    return `Found ${results.length} rows. Showing first 50:\n${header}\n${"-".repeat(header.length)}\n${lines.join("\n")}`;
  }

  // Otherwise, concise natural-language summary
  const numericCols = Object.keys(results[0]).filter(k => typeof results[0][k] === "number");
  let summaryText = `The query returned ${results.length} rows.\n`;
  for (const col of numericCols) {
    const values = results.map(r => r[col]).filter(v => typeof v === "number");
    if (values.length) {
      const min = Math.min(...values);
      const max = Math.max(...values);
      summaryText += `Column "${col}" ranges from ${min} to ${max}.\n`;
    }
  }

  const prompt = `
A user asked: "${userQuestion}"
We executed this T-SQL query:
${sqlRan}

High-level facts:
${summaryText}

Write a brief, clear, human-readable summary. Do not invent numbers. If counts exist in the rows, mention them. No SQL or code fences in your answer.
`;

  const response = await openai.chat.completions.create({
    model: process.env.AZURE_OPENAI_DEPLOYMENT,
    messages: [{ role: "system", content: prompt }],
    temperature: 0,
    max_tokens: 250
  });

  return response.choices?.[0]?.message?.content?.trim() || "Here are the results.";
}

// -------------------------------
// 8) Bot logic
// -------------------------------
async function botLogic(context) {
  const userId = context.activity.from.id;
  const userMessage = (context.activity.text || "").trim();

  if (!memory[userId]) memory[userId] = [];
  memory[userId].push({ role: "user", content: userMessage });

  await context.sendActivity("Processing your request...");

  try {
    // Fetch schema each turn (simple + always accurate)
    const schemaInfo = await getDbSchema();

    // Ask LLM for SQL
    const rawModelOut = await generateSql(userMessage, memory[userId], schemaInfo);
    // Extract + normalize BEFORE validation
    const extracted = extractFirstSelectOrWith(rawModelOut);
    let finalQuery = normalizeSqlForAzureSql(extracted);

    // Validate read-only
    if (!isReadOnlySelect(finalQuery)) {
      await context.sendActivity("⚠️ Sorry, I can only run SELECT/CTE queries against Azure SQL.");
      return;
    }

    console.log("SQL to run:", finalQuery);

    // Execute
    const results = await runQuery(finalQuery);

    // Respond
    const answer = await summarizeResults(userMessage, finalQuery, results);
    memory[userId].push({ role: "assistant", content: answer });
    await context.sendActivity(`📊 ${answer}`);
  } catch (err) {
    console.error("Bot error:", err);
    await context.sendActivity("⚠️ Failed to process request. Check server logs.");
  }
}

// -------------------------------
// 9) Server
// -------------------------------
const server = restify.createServer();
server.use(restify.plugins.bodyParser());

server.listen(process.env.PORT || 8080, () => {
  console.log(`Bot is running on port ${process.env.PORT || 8080}`);
});

server.post("/api/messages", async (req, res) => {
  await adapter.process(req, res, async (context) => {
    await botLogic(context);
  });
});

server.get("/", (req, res, next) => {
  res.send("✅ Bot is running!");
  next();
});
