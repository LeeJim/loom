import { useMemo, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { Activity, ArrowUpRight, CircleCheck, GitPullRequest, ListTodo, Search } from "lucide-react";
import { api, ApiError, repository, type Session, type Snapshot } from "./api";
import { Badge, Empty, labels, Page, Panel, ReadState, Refresh, time, useResource } from "./ui";

export function Overview() {
  const { data, error, loading, reload } = useResource<Snapshot>("snapshot", 15000);
  return <Page title="总览" description="查看研发流程的当前状态与最近活动。"
    action={<Refresh busy={loading} action={reload} />}>
    {!data ? <ReadState error={error} loading={loading} /> : <>
      {error != null && <ReadState error={error} loading={false} />}
      <div className="metrics">
        {([
          ["Issue", data.metrics.issues, ListTodo], ["运行中", data.metrics.running, Activity],
          ["已交付", data.metrics.delivered, GitPullRequest], ["CI 回传", data.metrics.ci_callbacks, CircleCheck],
        ] as const).map(([label, value, Icon]) => <div className="metric" key={label}>
          <div>{label}<Icon size={17} /></div><strong>{value}</strong>
        </div>)}
      </div>
      <div className="two-cols">
        <Panel title="流程阶段" action={<Link to="/tasks" className="text-link">查看任务 <ArrowUpRight size={14} /></Link>}>
          <div className="stage-list">{["Planning", "AwaitingApproval", "Coding", "Validation", "Repair", "Review", "Delivery"]
            .map(stage => <div key={stage}><Badge value={stage} /><strong>{data.stages.find(row => row.stage === stage)?.count ?? 0}</strong></div>)}</div>
        </Panel>
        <Panel title="最近执行" action={<Link to="/executions" className="text-link">执行记录 <ArrowUpRight size={14} /></Link>}>
          {data.executions.length ? <ul className="rows">{data.executions.slice(0, 6).map(row => <li key={row.id}>
            <div><Link className="text-link" to={`/executions/${row.id}`}>Issue #{row.issue_number}</Link>
              <small>{labels[row.stage || ""] || row.kind} · {time(row.started_at)}</small></div><Badge value={row.status} />
          </li>)}</ul> : <Empty>暂无执行记录。</Empty>}
        </Panel>
      </div>
      <p className="footnote">Worker 最近心跳 {time(data.metrics.heartbeat)} · 更新于 {time(data.generated)}</p>
    </>}
  </Page>;
}

export function Tasks() {
  const { data, error, loading, reload } = useResource<Snapshot>("snapshot", 15000);
  const session = useOutletContext<Session | undefined>();
  const [search, setSearch] = useState("");
  const [stage, setStage] = useState("");
  const [pending, setPending] = useState<number>();
  const [notice, setNotice] = useState("");
  const jobs = useMemo(() => (data?.jobs ?? []).filter(row => (!stage || row.stage === stage) &&
    (`#${row.number} ${row.title}`).toLowerCase().includes(search.trim().toLowerCase())), [data, search, stage]);
  async function run(issue: number) {
    setPending(issue); setNotice("");
    try {
      await api("run", { body: { issue } });
      setNotice(`Issue #${issue} 已排队。`);
      reload();
    } catch (error) {
      setNotice(error instanceof ApiError && error.code === "not_runnable"
        ? "此任务当前无法重新运行，请刷新状态。" : "无法提交运行请求。");
    } finally { setPending(undefined); }
  }
  return <Page title="任务" description="查看 Issue、方案审批、验证和交付结果。"
    action={<Refresh busy={loading} action={reload} />}>
    <Panel>
      <div className="toolbar">
        <label className="search"><Search size={16} /><input placeholder="搜索 Issue" aria-label="搜索 Issue"
          value={search} onChange={event => setSearch(event.target.value)} /></label>
        <select value={stage} onChange={event => setStage(event.target.value)} aria-label="筛选阶段">
          <option value="">全部阶段</option>
          {(data?.stages ?? []).map(row => <option key={row.stage} value={row.stage}>{labels[row.stage] || row.stage}</option>)}
        </select>
      </div>
      {notice && <div className="notice" role="status">{notice}</div>}
      {error != null && <ReadState error={error} loading={false} />}
      {!data ? <ReadState error={undefined} loading={loading && !error} /> : !jobs.length ? <Empty>没有匹配的任务。</Empty> :
        <div className="table-scroll"><table><thead><tr>
          <th>Issue</th><th>阶段</th><th>执行</th><th>CI</th><th>交付</th><th>操作</th>
        </tr></thead><tbody>{jobs.map(row => <tr key={row.number}>
          <td><a className="text-link" href={repository + "/issues/" + row.number}>#{row.number} {row.title}</a>
            {(row.plan_comment_url || row.last_error || row.plan_error) && <small className="table-meta">
              {row.plan_comment_url?.startsWith(repository + "/issues/") && <a href={row.plan_comment_url}>查看方案</a>}
              {row.last_error || row.plan_error}
            </small>}</td>
          <td><Badge value={row.stage} /><small className="table-meta"><Badge value={row.manual_status} /></small></td>
          <td><Link className="text-link" to={`/executions?issue=${row.number}`}>{row.executions} 次</Link>
            <small className="table-meta">修复 {row.repair_count} 次</small></td>
          <td>{row.run_id ? <a href={repository + "/actions/runs/" + row.run_id}><Badge value={row.ci_conclusion} /></a> : "—"}</td>
          <td>{row.pr_number ? <a className="text-link" href={repository + "/pull/" + row.pr_number}>PR #{row.pr_number}</a>
            : <Badge value={row.publication_status || (row.publish_approved ? "已授权" : null)} />}
            {row.publication_error && <small className="table-meta">{row.publication_error}</small>}</td>
          <td>{Boolean(row.manual_allowed && session?.user) && <button className="button small" disabled={pending !== undefined}
            onClick={() => run(row.number)}>{pending === row.number ? "提交中" : "运行"}</button>}</td>
        </tr>)}</tbody></table></div>}
    </Panel>
  </Page>;
}
