# UWaterloo MCP

A read-only MCP server for UWaterloo Learn and Piazza. It reads; it never submits or posts.

Deploy your own. Anyone with your server's URL and token can read everything you can read in Learn.

## Setup & Deployment

### Option A: Local (Fastest)

Requires Node 22.17+ and Chrome.

```bash
git clone https://github.com/syed-zayd/uwaterloo-mcp.git
cd uwaterloo-mcp
npm install
npm start
```

On first boot, the server automatically generates a secure token and prints your `/setup` link.

### Option B: Docker / Self-Hosted (Zero Vendor Lock-in)

Runs anywhere with Docker (Home server, VPS, Fly.io, Railway, Render). Includes headless Chromium and persistent storage out of the box.

```bash
docker compose up -d
```

### Option C: Vercel (Serverless)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fsyed-zayd%2Fuwaterloo-mcp&project-name=uwaterloo-mcp&repository-name=uwaterloo-mcp&env=MCP_AUTH_TOKEN&envDescription=Your%20private%20MCP%20token.&envLink=https%3A%2F%2Fgithub.com%2Fsyed-zayd%2Fuwaterloo-mcp%23setup)

> [!NOTE]
> On Vercel, connect a **Blob** store (**Storage → Create → Blob → Private**) so your session persists across serverless instances.

---

## Manage via `/setup`

Open `http://localhost:8787/setup` in your browser:

1. **Waterloo Learn**: Enter your WatIAM username and password. The screen will display a 3-digit verification code to enter in your Duo Mobile app. You're signed in! Subsequent sign-ins can reuse trusted browser cookies.
2. **Piazza**: Enter your Piazza email and password to activate Piazza post searching and course feeds.
3. **Connect Assistant**: 1-click copy snippets for **Claude Desktop**, **Claude Code CLI**, and **ChatGPT / Claude.ai Web**.

### Connecting from Web Clients (Claude.ai / ChatGPT Web)

Web clients require a public HTTPS URL. If self-hosting, expose your port securely via Cloudflare Tunnel or ngrok:

```bash
cloudflared tunnel --url http://localhost:8787
```

Then use the provided HTTPS URL with your Bearer token in Claude.ai or ChatGPT.

## Tools

**Learn** — `server_info`, `list_courses`, `get_upcoming`, `get_grades`, `get_rubric`, `list_assignments`, `get_submissions`, `get_submission_file`, `get_submission_file_url`, `get_course_content`, `list_page_links`, `get_rubric_definition`, `resolve_link`, `get_file`, `get_file_url`, `get_quiz_attempts`, `get_classlist`, `list_groups`, `get_group`, `list_discussions`, `list_discussion_posts`, `get_discussion_thread`, `get_announcements`

**Piazza** — `piazza_list_courses`, `piazza_list_folders`, `piazza_search_posts`, `piazza_get_posts`

Start with `list_courses` or `piazza_list_courses` — everything else takes a course.

`get_rubric_definition` returns the blank rubric for an assignment — every criterion, what it is worth, and the descriptor for each level — so you can see what is being marked before you write. `get_rubric` is the other one: a rubric already filled in on work that has been graded.

`get_course_content` lists topics, which is not everything a course holds: templates, policy PDFs and handouts usually sit in the content directory and are reached only by a link inside some page. `list_page_links` reads one page and lists those files with the paths `get_file` takes, along with the quicklinks the page carries.

Course pages link things by quicklink (`quickLink.d2l?...&rcode=...`) rather than by id. `resolve_link` follows one and says what it points at — a content topic, a rubric, an assignment folder, a discussion, or a file path — so the id can go straight into the tool that needs it. Quiz quicklinks are reported, never followed.

`get_file` and `get_file_url` name a file in either of two ways. Most files are content topics, so `topic_id` from `get_course_content` is the usual one. Some are not: an assignment template, a policy PDF or a handout linked straight from a course page has no topic of its own, and for those pass `path` instead — the link as it appears, e.g. `/content/enforced/123456-CS_247/media/template.docx`, or the full `https://learn.uwaterloo.ca/...` URL. A path must sit inside the named course's own content directory; anything else on Brightspace is refused.

MIT licensed.
