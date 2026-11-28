const repository = 'https://github.com/LeeJim/HowToCookOnMiniprogram';
const stages = [
  ['Planning', '制定计划'], ['Coding', '生成变更'], ['Validation', '验证变更'],
  ['Repair', '修复失败'], ['Review', '复核补丁'], ['Delivery', '交付结果'],
];
const labels = {
  AwaitingApproval: '待确认方案', awaiting_plan: '待确认方案', posting: '准备发布方案',
  success: '通过', failure: '失败', cancelled: '已取消', timed_out: '超时',
  queued: '待运行', candidate: '补丁已生成', published: '草稿已发布',
  running: '执行中', completed: '已完成', failed: '失败', interrupted: '已中断',
};

const get = (id) => document.getElementById(id);
const number = new Intl.NumberFormat('zh-CN');
const date = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

let data;
let paused = false;
let loading = false;

function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value !== undefined && value !== null) node.textContent = value;
  if (className) node.className = className;
  return node;
}

function link(path, value) {
  const node = element('a', value);
  node.href = repository + path;
  node.target = '_blank';
  node.rel = 'noopener noreferrer';
  return node;
}

function timestamp(value) {
  if (!value) return '—';
  const parsed = new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
  return Number.isNaN(parsed.valueOf()) ? '—' : date.format(parsed);
}

function badge(status, value = labels[status] || status || '—') {
  const type = ['success', 'completed', 'Delivery'].includes(status) ? 'good'
    : ['failure', 'failed', 'timed_out'].includes(status) ? 'bad'
    : ['Repair', 'interrupted'].includes(status) ? 'warn' : '';
  return element('span', value, 'badge ' + type);
}

function renderJobs() {
  if (!data) return;
  const search = get('search').value.trim().toLowerCase();
  const stage = get('filter').value;
  const rows = data.jobs.filter((job) => (!stage || job.stage === stage)
    && (!search || ('#' + job.number + ' ' + job.title).toLowerCase().includes(search)));

  get('job-rows').replaceChildren(...rows.map((job) => {
    const row = element('tr');
    const subject = element('td');
    subject.append(link('/issues/' + job.number, '#' + job.number), element('span', job.title, 'subject'));
    if (job.last_error) subject.append(element('span', job.last_error, 'sub'));

    const current = element('td');
    current.append(badge(job.stage));
    if (job.plan_comment_url) {
      const anchor = /#issuecomment-\d+$/.exec(job.plan_comment_url)?.[0];
      if (anchor) current.append(document.createTextNode(' '), link('/issues/' + job.number + anchor, '查看方案'));
    }
    if (job.plan_error) current.append(element('span', job.plan_error, 'subject sub'));
    const execution = element('td', number.format(job.executions));
    const repair = element('td', number.format(job.repair_count));

    const ci = element('td');
    if (job.run_id) {
      ci.append(badge(job.ci_conclusion), document.createTextNode(' '),
        link('/actions/runs/' + job.run_id, job.attempt ? '第 ' + job.attempt + ' 次' : '详情'));
    } else ci.textContent = '—';

    const delivery = element('td');
    if (job.pr_number) delivery.append(link('/pull/' + job.pr_number, 'PR #' + job.pr_number));
    if (job.publication_status) {
      delivery.append(document.createTextNode(' '), badge(job.publication_status));
      if (job.publication_error) delivery.append(element('span', job.publication_error, 'subject sub'));
    } else if (!job.pr_number) {
      delivery.append(job.publish_approved ? badge('success', '已授权') : element('span', '待标签授权', 'sub'));
    }
    const action = element('td');
    if (job.manual_allowed) {
      const button = element('button', '运行');
      button.type = 'button';
      button.addEventListener('click', () => requestRun(job.number, button));
      action.append(button);
    } else if (['queued', 'running', 'awaiting_plan'].includes(job.manual_status)) {
      action.append(badge(job.manual_status));
    } else action.textContent = '—';
    row.append(subject, current, execution, repair, ci, delivery, action);
    return row;
  }));
  if (!rows.length) {
    const empty = element('td', '没有匹配的任务', 'empty');
    empty.colSpan = 7;
    const row = element('tr');
    row.append(empty);
    get('job-rows').append(row);
  }
}

async function request(path, body) {
  const response = await fetch('./api/' + path, {
    cache: 'no-store', signal: AbortSignal.timeout(8000),
    ...(body === undefined ? {} : {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.status || String(response.status));
  return result;
}

async function loadAccount() {
  const {enabled, user} = await request('session');
  get('account').hidden = !enabled;
  get('github-login').hidden = !enabled || !!user;
  get('logout').hidden = !user;
  get('user-login').textContent = user ? user.login : '';
  get('worker-form').hidden = !user;
  if (user) await loadWorkers();
}

async function loadWorkers() {
  try {
    const workers = await request('workers');
    const states = {running: '运行中', paused: '已暂停', draining: '排空中'};
    get('worker-list').replaceChildren(...workers.map((worker) => {
      const row = element('div', null, 'item item-line');
      row.append(element('strong', worker.name), badge(worker.state, states[worker.state]),
        element('span', worker.active_issue ? 'Issue #' + worker.active_issue : (worker.issue_number ? '限定 Issue #' + worker.issue_number : '所有已配置 Issue')),
        element('span', worker.model || '默认模型'),
        element('span', worker.skills.map(({id, version}) => id + '@' + version).join(', ')),
        element('time', timestamp(worker.last_seen_at)));
      for (const [state, label] of Object.entries({running: '启动', paused: '暂停', draining: '排空'})) {
        const button = element('button', label);
        button.type = 'button';
        button.disabled = worker.state === state;
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            await request('workers/state', {id: worker.id, state});
            await loadWorkers();
          } catch {
            get('worker-notice').textContent = 'Worker 状态更新失败。';
            button.disabled = false;
          }
        });
        row.append(button);
      }
      return row;
    }));
    if (!workers.length) get('worker-list').append(element('p', '暂无 Worker。', 'empty'));
  } catch {
    get('worker-notice').textContent = '无法加载 Worker。';
  }
}

async function loadCapabilities() {
  const list = get('capability-list');
  try {
    const result = await request('capabilities');
    const names = {llm: 'LLM', mcp: 'MCP', skills: 'SkillHub'};
    const status = {available: '可用', unavailable: '不可用', unconfigured: '未配置'};
    list.replaceChildren(...Object.entries(result).map(([name, group]) => {
      const row = element('div', null, 'item');
      row.append(element('strong', names[name] + ' · ' + (status[group.status] || group.status)));
      for (const entry of group.items) {
        row.append(element('p', (entry.name || entry.id) + (entry.version ? '@' + entry.version : '')
          + (entry.installed === false ? ' · 未安装' : '') + (entry.description ? ' · ' + entry.description : '')));
      }
      return row;
    }));
    const form = get('worker-form');
    const model = form.elements.model;
    const previousModel = model.value;
    const previousSkills = new Set(Array.from(form.elements.skills.selectedOptions, (option) => option.value));
    model.replaceChildren(new Option('默认模型', ''), ...result.llm.items.map(({id}) => new Option(id, id)));
    if (Array.from(model.options).some((opt) => opt.value === previousModel)) model.value = previousModel;
    form.elements.skills.replaceChildren(...result.skills.items.filter((entry) => entry.installed).map(({id, version}) => {
      const value = JSON.stringify({id, version});
      return new Option(id + '@' + version, value, false, previousSkills.has(value));
    }));
  } catch {
    list.textContent = '无法加载能力清单。';
  }
}

async function loadAudit() {
  const list = get('audit-list');
  try {
    const findings = await request('audit');
    list.replaceChildren(...findings.map((finding) => {
      const row = element('div', null, 'item');
      const evidence = element('button', '执行 #' + finding.execution_id + ' · ' + finding.stage);
      evidence.type = 'button';
      const artifacts = element('div');
      evidence.addEventListener('click', async () => {
        evidence.disabled = true;
        try { await showArtifacts(finding.execution_id, artifacts); }
        catch { artifacts.textContent = '无法加载审计证据。'; }
        finally { evidence.disabled = false; }
      });
      row.append(evidence, element('p', finding.suggestion),
        element('pre', JSON.stringify(finding.evidence, null, 2), 'artifact'), artifacts);
      return row;
    }));
    if (!findings.length) list.textContent = '当前没有审计建议。';
  } catch {
    list.textContent = '无法加载审计结果。';
  }
}

function artifactRows(artifacts) {
  return artifacts.map((artifact) => {
    const row = element('details', null, 'item');
    const direction = {input: '输入', output: '输出', error: '错误'};
    row.append(element('summary', artifact.stage + ' · ' + (direction[artifact.direction] || artifact.direction)
      + ' · ' + timestamp(artifact.recorded_at)),
      element('pre', JSON.stringify(artifact.payload, null, 2), 'artifact'));
    return row;
  });
}

async function showArtifacts(executionId, target) {
  const record = await request('executions/' + executionId);
  target.replaceChildren(...artifactRows(record.artifacts));
  if (!record.artifacts.length) target.append(element('p', '暂无阶段输入与输出。'));
}

async function loadTemporalActivities() {
  const panel = get('temporal-activity');
  const list = get('temporal-activity-list');
  try {
    const {enabled, activities} = await request('temporal/activities');
    panel.hidden = !enabled;
    if (!enabled) return;
    const rows = activities.map((record) => {
      const row = element('details', null, 'item');
      row.append(element('summary', '#' + record.issue_number + ' · ' + record.activity +
        ' · ' + record.status + ' · 第 ' + record.attempt + ' 次'),
        element('p', timestamp(record.started_at)),
        element('pre', JSON.stringify({输入: record.inputs, 输出: record.output}, null, 2), 'artifact'));
      return row;
    });
    list.replaceChildren(...rows);
    if (!rows.length) list.textContent = '暂无试点执行记录。';
  } catch {
    if (!panel.hidden) list.textContent = '暂时无法加载试点执行记录。';
  }
}

function render() {
  const m = data.metrics;
  const cards = [
    ['已跟踪任务', m.issues, m.delivered + ' 项已达到 Delivery'],
    ['Worker 执行', m.executions, m.running + ' 项执行中 · ' + m.failed + ' 项失败'],
    ['Repair 次数', m.repairs, '来自已记录的执行阶段'],
    ['CI 回传', m.ci_callbacks, '已验签的运行尝试'],
  ];
  get('metrics').replaceChildren(...cards.map(([title, value, detail]) => {
    const card = element('article', null, 'metric');
    card.append(element('p', title), element('strong', number.format(value)), element('small', detail));
    return card;
  }));

  const counts = new Map(data.stages.map((stage) => [stage.stage, stage.count]));
  get('mode').textContent = 'Worker 调度 · ' + (counts.get('AwaitingApproval') || 0) + ' 项待确认';
  get('stages').replaceChildren(...stages.map(([name, detail]) => {
    const count = counts.get(name) || 0;
    const item = element('li', null, 'stage' + (count ? ' active' : ''));
    const heading = element('div', name, 'stage-name');
    heading.append(element('span', count));
    item.append(heading, element('small', detail));
    return item;
  }));
  get('heartbeat').textContent = 'Worker 上次轮询 ' + timestamp(m.heartbeat);
  get('updated').textContent = '数据更新时间 ' + timestamp(data.generated);
  renderJobs();

  const open = new Set(Array.from(get('executions').querySelectorAll('details[open]'), (item) => item.dataset.id));
  get('executions').replaceChildren(...data.executions.map((run) => {
    const card = element('details', null, 'item');
    card.dataset.id = run.id;
    card.open = open.has(String(run.id));
    const caption = element('summary');
    const line = element('span', null, 'item-line');
    line.append(element('strong', 'Issue #' + run.issue_number), badge(run.status),
      element('span', run.kind === 'ci_repair' ? 'CI 修复' : '任务执行'),
      element('time', timestamp(run.started_at), 'right'));
    caption.append(line);
    const timeline = element('ol', null, 'timeline');
    for (const event of data.events.filter((event) => event.execution_id === run.id).reverse()) {
      const stage = element('li', event.stage);
      stage.append(element('time', timestamp(event.recorded_at)));
      timeline.append(stage);
    }
    if (run.error) timeline.append(element('li', run.error));
    const details = element('div');
    const load = element('button', '查看阶段输入与输出');
    load.type = 'button';
    load.addEventListener('click', async () => {
      load.disabled = true;
      try {
        await showArtifacts(run.id, details);
      } catch {
        details.textContent = '无法加载阶段详情。';
      } finally { load.disabled = false; }
    });
    card.append(caption, timeline, load, details);
    return card;
  }));
  if (!data.executions.length) {
    get('executions').append(element('p', '暂无新的执行记录。此前完成的任务仍保留在任务队列中。', 'empty'));
  }

  get('ci-runs').replaceChildren(...data.ci.map((run) => {
    const row = element('div', null, 'item item-line');
    row.append(link('/actions/runs/' + run.run_id, 'Issue #' + run.issue_number + ' · 第 ' + run.attempt + ' 次'),
      badge(run.conclusion), element('time', timestamp(run.recorded_at), 'right'));
    return row;
  }));
  if (!data.ci.length) get('ci-runs').append(element('p', '暂无已记录的 CI 回传。', 'empty'));

  get('repair-runs').replaceChildren(...data.repairs.map((repair) => {
    const row = element('div', null, 'item item-line');
    row.append(link('/actions/runs/' + repair.run_id, 'Issue #' + repair.issue_number + ' · 第 ' + repair.attempt + ' 次'),
      badge(repair.status), element('span', repair.patch_path || repair.error || '', 'right'));
    return row;
  }));
  if (!data.repairs.length) get('repair-runs').append(element('p', '暂无 CI 修复候选。', 'empty'));
}

async function requestRun(issue, button) {
  button.disabled = true;
  const notice = get('run-feedback');
  notice.hidden = false;
  notice.textContent = '正在提交 Issue #' + issue + '…';
  try {
    const response = await fetch('./api/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({issue}),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(String(response.status));
    notice.textContent = 'Issue #' + issue + ' 已进入运行队列。';
    refresh();
  } catch (error) {
    notice.textContent = error.message === '409' ? '当前任务状态无法运行，请刷新后查看。' : '提交失败，请稍后重试。';
    button.disabled = false;
  }
}

async function refresh() {
  if (loading) return;
  loading = true;
  try {
    const response = await fetch('./api/snapshot', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('Console data unavailable');
    data = await response.json();
    render();
    if (get('temporal-activity').hidden || !document.querySelector('#temporal-activity details[open]')) {
      loadTemporalActivities();
    }
    get('error').hidden = true;
    get('live-dot').className = 'live-dot online';
    get('connection').textContent = paused ? '自动刷新已暂停' : '实时刷新';
  } catch {
    get('error').hidden = false;
    get('live-dot').className = 'live-dot offline';
    get('connection').textContent = '连接失败';
  } finally {
    loading = false;
  }
}

for (const stage of [...stages.map(([name]) => name), 'AwaitingApproval']) {
  const option = element('option', labels[stage] || stage);
  option.value = stage;
  get('filter').append(option);
}
get('filter').addEventListener('change', renderJobs);
get('search').addEventListener('input', renderJobs);
get('refresh').addEventListener('click', refresh);
get('toggle').addEventListener('click', () => {
  paused = !paused;
  get('toggle').setAttribute('aria-pressed', String(paused));
  get('toggle').textContent = paused ? '恢复刷新' : '暂停刷新';
  if (paused && !loading && get('error').hidden) get('connection').textContent = '自动刷新已暂停';
  if (!paused) refresh();
});
get('worker-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('button[type=submit]');
  submit.disabled = true;
  try {
    const fields = new FormData(form);
    await request('workers', {
      name: fields.get('name'), issue_number: fields.get('issue') ? Number(fields.get('issue')) : null,
      model: fields.get('model') || null,
      skills: fields.getAll('skills').map((entry) => JSON.parse(entry)),
    });
    form.reset();
    get('worker-notice').textContent = 'Worker 已创建，当前为暂停状态。';
    await loadWorkers();
  } catch (error) {
    const messages = {
      model_catalog_unavailable: '暂时无法验证网关模型，请刷新能力清单后重试。',
      model_not_available: '所选模型已不在网关清单中，请重新选择。',
      unavailable: 'Worker 服务暂时不可用，请稍后重试。',
      login_required: '登录已过期，请刷新页面并重新登录。',
    };
    get('worker-notice').textContent = messages[error.message]
      || '创建 Worker 失败，请检查名称、Issue 配置及技能版本。';
  } finally { submit.disabled = false; }
});
get('logout').addEventListener('click', async () => {
  const response = await fetch('./oauth/logout', {method: 'POST'});
  if (response.ok) window.location.assign('./');
});
get('refresh-capabilities').addEventListener('click', loadCapabilities);
get('refresh-audit').addEventListener('click', loadAudit);
setInterval(() => {
  if (!paused && !document.hidden) {
    refresh();
    if (!get('worker-form').hidden) loadWorkers();
  }
}, 15000);
loadAccount().catch(() => { get('account').hidden = true; });
loadCapabilities();
refresh();
