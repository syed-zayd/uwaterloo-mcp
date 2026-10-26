# UWaterloo MCP

Connect your **UWaterloo Learn** and **Piazza** accounts to **Claude**, **ChatGPT**, and **Claude Code**.

Read-only: reads course materials, announcements, grades, assignments, quizzes, and Piazza discussions. Never submits or posts.

---

## Choose How to Run

### Option 1: Deploy to Vercel (1-Click Cloud)
> **Best for Claude.ai and ChatGPT Web** — provides a permanent HTTPS URL with zero server management or terminal commands.

1. **Deploy to Vercel**:
   
   [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fsyed-zayd%2Fuwaterloo-mcp&project-name=uwaterloo-mcp&repository-name=uwaterloo-mcp&env=MCP_AUTH_TOKEN&envDescription=Your%20private%20MCP%20token%20(24%2B%20random%20characters).&envLink=https%3A%2F%2Fgithub.com%2Fsyed-zayd%2Fuwaterloo-mcp%23setup)

   When prompted, enter a secure `MCP_AUTH_TOKEN` (24+ characters). This is your server password.

2. **Connect Private Blob Storage** *(required to keep your login session alive across serverless requests)*:
   In your Vercel project dashboard, go to **Storage → Create Database → Blob**, select **Private**, and click **Connect to Project**.

3. **Sign in at `/setup`**:
   Open `https://<your-project>.vercel.app/setup` in your browser. Enter your `MCP_AUTH_TOKEN`, log in to WatIAM with Duo, and optionally connect your Piazza account.

---

### Option 2: Self-Host with Docker (Zero Vendor Lock-in)
> **Best for local use, Claude Desktop, or your own VPS / home server.**

```bash
git clone https://github.com/syed-zayd/uwaterloo-mcp.git
cd uwaterloo-mcp
docker compose up -d
```
*(Or without Docker: `npm install && npm start` — requires Node 22+ and Chrome)*

Then open **[http://localhost:8787/setup](http://localhost:8787/setup)** in your browser to sign in.

---

## Connect Your AI Assistant

Once signed in at `/setup`, copy your ready-to-use config straight from the bottom of the page:

### Claude Desktop
Add to your `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "uwaterloo": {
      "url": "https://<your-project>.vercel.app/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_AUTH_TOKEN"
      }
    }
  }
}
```
*(If running locally, use `"url": "http://localhost:8787/mcp"`)*

### Claude Code CLI
```bash
claude mcp add uwaterloo https://<your-project>.vercel.app/mcp --header "Authorization: Bearer YOUR_MCP_AUTH_TOKEN"
```

### ChatGPT & Claude.ai Web
In ChatGPT (**Settings → Developer mode → Add MCP Server**) or Claude.ai:
- **Server URL**: `https://<your-project>.vercel.app/mcp`
- **Authentication**: Bearer Token → paste your `MCP_AUTH_TOKEN`

*(If self-hosting locally, expose your local port with a tunnel first: `cloudflared tunnel --url http://localhost:8787`)*

---

## Available Tools

### Learn
- **Courses & Upcoming**: `list_courses`, `get_upcoming`, `get_announcements`, `get_classlist`, `list_groups`
- **Grades & Rubrics**: `get_grades`, `get_rubric`, `get_rubric_definition`
- **Assignments & Submissions**: `list_assignments`, `get_submissions`, `get_submission_file`, `get_submission_file_url`
- **Course Content & Files**: `get_course_content`, `get_file`, `get_file_url`, `list_page_links`, `resolve_link`
- **Discussions & Quizzes**: `list_discussions`, `list_discussion_posts`, `get_discussion_thread`, `get_quiz_attempts`

### Piazza
- `piazza_list_courses` — List enrolled classes
- `piazza_list_folders` — List folders and categories
- `piazza_search_posts` — Search posts and instructor responses
- `piazza_get_posts` — Read full discussion threads

---

## License

MIT
