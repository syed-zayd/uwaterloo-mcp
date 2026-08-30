# UWaterloo MCP

A read-only MCP server for UWaterloo Learn and Piazza. It reads; it never submits or posts.

Deploy your own. Anyone with your server's URL and token can read everything you can read in Learn.

## Setup

### 1. Deploy

**With Vercel**

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fsyed-zayd%2Fuwaterloo-mcp&project-name=uwaterloo-mcp&repository-name=uwaterloo-mcp&env=MCP_AUTH_TOKEN%2CPIAZZA_EMAIL%2CPIAZZA_PASSWORD%2CUWATERLOO_USERNAME%2CUWATERLOO_PASSWORD&envDescription=Your%20private%20MCP%20token%2C%20your%20Piazza%20login%2C%20and%20your%20WatIAM%20login.&envLink=https%3A%2F%2Fgithub.com%2Fsyed-zayd%2Fuwaterloo-mcp%23setup)

The form asks for five values:

| Variable | What to enter |
| --- | --- |
| `MCP_AUTH_TOKEN` | A random string, 24+ characters. Your server's password — you paste it again in steps 2 and 3. |
| `PIAZZA_EMAIL` | Your Piazza email. |
| `PIAZZA_PASSWORD` | Your Piazza password. |
| `UWATERLOO_USERNAME` | Your WatIAM username — `@uwaterloo.ca` is appended for you, and the full form works too. Note this is your WatIAM login, which is not always your `@uwaterloo.ca` email alias. |
| `UWATERLOO_PASSWORD` | Your WatIAM password. |

**Locally** — needs Node 22.17+, and Chrome for the Duo sign-in.

```bash
git clone https://github.com/syed-zayd/uwaterloo-mcp.git
cd uwaterloo-mcp
npm install
cp .env.example .env   # edit it — the server won't start without MCP_AUTH_TOKEN
npm start
```

Open your server's root URL in a browser. It prints the two things steps 2 and 3 need.

### 2. Sign in to Learn

Piazza works already. Learn needs a Duo approval, which only you can give.

Open `/setup`, enter your `MCP_AUTH_TOKEN`, and press **Sign in with UWaterloo and Duo**. It shows a three-digit code — type that into Duo Mobile.

The session is held in memory, so expect to repeat this after a restart, after 180 idle minutes, and on Vercel whenever a new instance starts. To make one last, use **Or paste a session cookie** on that page and save the same value as a `D2L_COOKIE` environment variable.

### 3. Connect your client

Add a remote MCP server pointing at `/mcp` on your server. When the approval page asks for a token, paste your `MCP_AUTH_TOKEN`.

## Tools

**Learn** — `server_info`, `list_courses`, `get_upcoming`, `get_grades`, `get_rubric`, `list_assignments`, `get_submissions`, `get_submission_file`, `get_submission_file_url`, `get_course_content`, `get_file`, `get_file_url`, `get_quiz_attempts`, `get_classlist`, `list_groups`, `get_group`, `list_discussions`, `list_discussion_posts`, `get_discussion_thread`, `get_announcements`

**Piazza** — `piazza_list_courses`, `piazza_list_folders`, `piazza_search_posts`, `piazza_get_posts`

Start with `list_courses` or `piazza_list_courses` — everything else takes a course.

MIT licensed.
