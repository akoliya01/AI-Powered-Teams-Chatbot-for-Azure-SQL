# Teams SQL Bot

A Microsoft Teams bot that uses Azure OpenAI to generate schema-aware SQL queries, runs them on Azure SQL Database, and summarizes the results for users. Built with Node.js, [botbuilder](https://www.npmjs.com/package/botbuilder), [restify](https://www.npmjs.com/package/restify), and [openai](https://www.npmjs.com/package/openai).

## Features

- Converts natural language questions into secure, read-only T-SQL queries using Azure OpenAI.
- Executes queries against your Azure SQL Database.
- Returns summarized, human-friendly answers or lists of results.
- Supports Teams authentication and role-based schema access (if extended).
- No data is stored except in-memory conversation history per user.

## Prerequisites

- Node.js v18+ (recommended)
- An Azure SQL Database instance
- An Azure OpenAI resource and deployment
- A registered Microsoft Bot (Azure Bot Service) with credentials

## Setup

### 1. Clone the repository

```sh
git clone <your-repo-url>
cd <your-repo-directory>
```

### 2. Install dependencies

```sh
npm install
```

### 3. Configure environment variables

Copy the provided [.env](.env) file and update the values as needed:

- **MICROSOFT_APP_ID**: Your Azure Bot Service App ID
- **MICROSOFT_APP_PASSWORD**: Your Azure Bot Service App Password
- **MICROSOFT_TENANT_ID**: Your Azure AD Tenant ID
- **PORT**: Port to run the bot (default: 8080)
- **AZURE_SQL_SERVER**: Azure SQL server name (e.g., `your-server.database.windows.net`)
- **AZURE_SQL_DATABASE**: Database name
- **AZURE_SQL_USER**: SQL user with read access
- **AZURE_SQL_PASSWORD**: SQL user password (remove any quotes)
- **AZURE_OPENAI_ENDPOINT**: Your Azure OpenAI endpoint (e.g., `https://<resource>.openai.azure.com`)
- **AZURE_OPENAI_KEY**: Azure OpenAI API key (remove any quotes)
- **AZURE_OPENAI_DEPLOYMENT**: Name of your OpenAI deployment (e.g., `gpt-4o-mini`)


Example:
```env
MICROSOFT_APP_ID=your-app-id
MICROSOFT_APP_PASSWORD=your-app-password
MICROSOFT_TENANT_ID=your-tenant-id
PORT=8080

AZURE_SQL_SERVER=your-server.database.windows.net
AZURE_SQL_DATABASE=your-db
AZURE_SQL_USER=your-user
AZURE_SQL_PASSWORD=your-password

AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_KEY=your-openai-key
AZURE_OPENAI_DEPLOYMENT=gpt-4o-mini
```

**Note:** Remove any single or double quotes from sensitive values in `.env`.

### 4. Start the bot

```sh
npm start
```

The bot will run on the port specified in `.env` (default: 8080).

### 5. Test locally

- Use the [Bot Framework Emulator](https://github.com/microsoft/BotFramework-Emulator) to connect to `http://localhost:8080/api/messages`.
- Or deploy to Azure and connect via Teams.

## Usage

- Ask questions in natural language (e.g., "Show me all products in the Sales schema").
- The bot will generate a secure SQL query, run it, and summarize the results.
- For list queries, the bot will show up to 50 results directly; for larger sets, it summarizes.

## Security Notes

- Only SELECT/CTE queries are allowed; all DML/DDL is blocked.
- The bot uses schema introspection to avoid hallucinated tables/columns.
- Conversation history is kept in memory per user for the session only.

## Project Structure

- [`index.js`](index.js): Main bot logic and server
- [`package.json`](package.json): Dependencies and scripts
- [`.env`](.env): Environment variables (not committed to source control)

## Scripts

- `npm start` — Start the bot
- `npm run dev` — Start with nodemon for development

## Dependencies

See [package.json](package.json) for full list.

- [botbuilder](https://www.npmjs.com/package/botbuilder)
- [restify](https://www.npmjs.com/package/restify)
- [openai](https://www.npmjs.com/package/openai)
- [mssql](https://www.npmjs.com/package/mssql)
- [dotenv](https://www.npmjs.com/package/dotenv)

## Troubleshooting

- Ensure your Azure SQL firewall allows connections from your machine or Azure Bot Service.
- Double-check all `.env` values for typos or extra quotes.
- Check logs for errors about missing environment variables or SQL/OpenAI failures.

## License

MIT

---

**Author:**  
[KAUSHAL AKOLIYA
