# UWaterloo MCP

Connect your **UWaterloo Learn** and **Piazza** accounts to **Claude**, **ChatGPT**, and **Claude Code**.

Read-only: reads course materials, announcements, grades, assignments, quizzes, and Piazza discussions. Never submits or posts.

---

## Quickstart in 3 Steps

### 1. Start the server

Choose **Docker** (recommended) or **Node.js**:

```bash
# Option A: Docker (Zero configuration, includes browser & persistent storage)
git clone https://github.com/syed-zayd/uwaterloo-mcp.git
cd uwaterloo-mcp
docker compose up -d
```

*Or with Node.js directly:*
```bash
# Option B: Node 22+
git clone https://github.com/syed-zayd/uwaterloo-mcp.git
cd uwaterloo-mcp
npm install
npm start
```

### 2. Configure at `/setup`

Open **[http://localhost:8787/setup](http://localhost:8787/setup)** in your browser:

1. **Waterloo Learn**: Enter your WatIAM username and password. Enter the 3-digit verification code in your Duo Mobile app. Subsequent logins bypass Duo using remembered browser cookies.
2. **Piazza**: Enter your Piazza email and password to enable class feeds and post searches.

### 3. Connect your AI

Copy the ready-to-use config straight from the `/setup` page:

- **Claude Desktop**: Paste the generated snippet into `claude_desktop_config.json`:
  ```json
  {
    "mcpServers": {
      "uwaterloo": {
        "url": "http://localhost:8787/mcp",
        "headers": { "Authorization": "Bearer YOUR_TOKEN" }
      }
    }
  }
  ```
- **Claude Code CLI**: Run the one-line command:
  ```bash
  claude mcp add uwaterloo http://localhost:8787/mcp --header "Authorization: Bearer YOUR_TOKEN"
  ```
- **Claude.ai & ChatGPT Web**: Web browsers require a public HTTPS URL. Run a secure tunnel:
  ```bash
  cloudflared tunnel --url http://localhost:8787
  ```
  Then paste the generated `https://.../mcp` URL and your Bearer token into ChatGPT Developer mode or Claude.ai.

---

## Deployment Options

| Method | Best For | Persistent Storage | Notes |
| --- | --- | --- | --- |
| **Docker Compose** | Local, VPS, Home Server | Built-in volume (`mcp-data`) | Recommended. Zero vendor lock-in. |
| **Node.js Local** | Fast local dev | Local `.learn-session` file | Needs Node 22+ & Chrome installed. |
| **Vercel** | Free cloud hosting | Connect Vercel Blob (Private) | One-click button below. |

#### Deploying on Vercel
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fsyed-zayd%2Fuwaterloo-mcp&project-name=uwaterloo-mcp&repository-name=uwaterloo-mcp&env=MCP_AUTH_TOKEN&envDescription=Your%20private%20MCP%20token.&envLink=https%3A%2F%2Fgithub.com%2Fsyed-zayd%2Fuwaterloo-mcp%23setup)

> [!IMPORTANT]
> When using Vercel, connect a **Blob** store (**Storage → Create → Blob → Private**) so your session persists across serverless instances.

---

## Available Tools

### Learn
- **Courses & Schedule**: `list_courses`, `get_upcoming`, `get_announcements`, `get_classlist`, `list_groups`
- **Grades & Rubrics**: `get_grades`, `get_rubric`, `get_rubric_definition`
- **Assignments & Submissions**: `list_assignments`, `get_submissions`, `get_submission_file`, `get_submission_file_url`
- **Content & Files**: `get_course_content`, `get_file`, `get_file_url`, `list_page_links`, `resolve_link`
- **Discussions & Quizzes**: `list_discussions`, `list_discussion_posts`, `get_discussion_thread`, `get_quiz_attempts`

### Piazza
- `piazza_list_courses` — List enrolled Piazza classes
- `piazza_list_folders` — List discussion folders & categories
- `piazza_search_posts` — Search class posts and instructor answers
- `piazza_get_posts` — Read full thread by post number

---

## License

MIT
