// Thin client for the Jira Data Center REST API v2, authenticated with a Personal Access Token.
// With `mock: true` it serves a fake Jira from memory so the UI can be tried without a real instance.

const ISSUE_FIELDS = 'summary,status,project';
const KEY_PATTERN = /^[A-Z][A-Z0-9_]+-\d+$/;

/** Formats a Jira `started` timestamp (yyyy-MM-ddTHH:mm:ss.SSS±hhmm) for a date and local time of day. */
export function formatStarted(date, time = '09:00') {
  const local = new Date(`${date}T${time}:00`);
  const offsetMin = -local.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${date}T${time}:00.000${sign}${hh}${mm}`;
}

const toIssue = raw => ({
  key: raw.key,
  summary: raw.fields?.summary ?? '',
  status: raw.fields?.status?.name ?? '',
  project: raw.fields?.project?.key ?? ''
});

const escapeJql = text => text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

export function createJira({ url, pat, mock = false, assignedJql } = {}) {
  if (mock) return createMockJira();
  if (!url || !pat) throw new Error('JIRA_URL and JIRA_PAT must be set (see .env.example), or run `npm run mock`.');
  const base = url.replace(/\/+$/, '');

  async function call(path, { method = 'GET', body } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try {
        const json = JSON.parse(text);
        message = [...(json.errorMessages ?? []), ...Object.values(json.errors ?? {})].join('; ') || text;
      } catch { /* not JSON */ }
      const err = new Error(`Jira ${res.status}: ${message.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : null;
  }

  const search = async (jql, maxResults) => {
    const params = new URLSearchParams({ jql, fields: ISSUE_FIELDS, maxResults: String(maxResults) });
    const data = await call(`/rest/api/2/search?${params}`);
    return data.issues.map(toIssue);
  };

  return {
    mock: false,
    async myself() {
      const me = await call('/rest/api/2/myself');
      return { name: me.name, displayName: me.displayName };
    },
    assigned: () => search(assignedJql || 'assignee = currentUser() ORDER BY updated DESC', 200),
    async issue(key) {
      return toIssue(await call(`/rest/api/2/issue/${encodeURIComponent(key)}?fields=${ISSUE_FIELDS}`));
    },
    async find(query) {
      const q = query.trim();
      if (KEY_PATTERN.test(q.toUpperCase())) {
        try { return [await this.issue(q.toUpperCase())]; } catch (e) { if (e.status !== 404) throw e; }
      }
      return search(`text ~ "${escapeJql(q)}" ORDER BY updated DESC`, 20);
    },
    async addWorklog(key, { started, minutes, comment }) {
      const data = await call(`/rest/api/2/issue/${encodeURIComponent(key)}/worklog`, {
        method: 'POST',
        body: { started, timeSpentSeconds: minutes * 60, comment }
      });
      return { id: data.id };
    }
  };
}

function createMockJira() {
  const issues = [
    ['DEMO-101', 'Checkout: payment provider migration', 'In Progress'],
    ['DEMO-102', 'Order history performance', 'In Review'],
    ['DEMO-110', 'Meetings & sprint ceremonies', 'Open'],
    ['DEMO-111', 'Support & bugfixing (general)', 'Open'],
    ['DEMO-120', 'Release 4.2 preparation', 'Done'],
    ['OPS-7', 'Deployment pipeline hardening', 'In Progress']
  ].map(([key, summary, status]) => ({ key, summary, status, project: key.split('-')[0] }));
  const posted = [];
  let nextId = 1000;
  const get = key => {
    const found = issues.find(i => i.key === key.toUpperCase());
    if (!found) { const e = new Error(`Jira 404: Issue ${key} does not exist`); e.status = 404; throw e; }
    return found;
  };
  return {
    mock: true,
    posted,
    myself: async () => ({ name: 'demo', displayName: 'Demo User (mock Jira)' }),
    assigned: async () => issues.slice(0, 4),
    issue: async key => get(key),
    find: async query => {
      const q = query.trim().toLowerCase();
      return issues.filter(i => i.key.toLowerCase() === q || i.summary.toLowerCase().includes(q));
    },
    addWorklog: async (key, worklog) => {
      get(key);
      if (worklog.comment?.includes('FAIL')) throw new Error('Jira 400: mock failure requested by comment');
      const id = String(nextId++);
      posted.push({ id, key, ...worklog });
      return { id };
    }
  };
}
