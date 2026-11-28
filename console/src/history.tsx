import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { repository, type Finding, type Snapshot, type Temporal, type Timeline } from "./api";
import { Badge, Empty, Json, labels, Page, Panel, ReadState, Refresh, time, useResource } from "./ui";

export function Executions() {
  const { data, error, loading, reload } = useResource<Snapshot>("snapshot", 15000);
  const temporal = useResource<Temporal>("temporal/activities", 15000);
  const [search] = useSearchParams();
  const issue = search.get("issue");
  const matches = (number: number) => !issue || String(number) === issue;
  const executions = data?.executions.filter(row => matches(row.issue_number));
  return <Page title="执行记录" description={issue ? `Issue #${issue} 的执行与 CI 记录。` : "查看阶段输入、输出、重试及 GitHub Actions 回传。"}
    action={<Refresh busy={loading || temporal.loading} action={() => { reload(); temporal.reload(); }} />}>
    {issue && <Link to="/executions" className="text-link">查看全部 Issue</Link>}
    <Panel title="最近执行">
      <ReadState error={error} loading={loading && !data} />
      {executions?.length === 0 && <Empty>暂无执行记录。</Empty>}
      {Boolean(executions?.length) && <div className="table-scroll"><table>
        <thead><tr><th>执行</th><th>Issue</th><th>阶段</th><th>状态</th><th>开始时间</th></tr></thead>
        <tbody>{executions?.map(item => <tr key={item.id}>
          <td><Link className="text-link" to={`/executions/${item.id}`}>#{item.id} · {item.kind}</Link></td>
          <td><a href={repository + "/issues/" + item.issue_number}>#{item.issue_number}</a></td>
          <td><Badge value={item.stage} /></td><td><Badge value={item.status} /></td><td>{time(item.started_at)}</td>
        </tr>)}</tbody></table></div>}
    </Panel>
    {data && <div className="two-cols">
      <Panel title="CI 回传">
        <ul className="rows">{data.ci.filter(row => matches(row.issue_number)).map(item => <li key={item.run_id + ":" + item.attempt}>
          <div><a className="text-link" href={repository + "/actions/runs/" + item.run_id}>Issue #{item.issue_number}<ArrowUpRight size={14} /></a>
            <small>第 {item.attempt} 次 · {time(item.recorded_at)}</small></div><Badge value={item.conclusion} />
        </li>)}</ul>
        {!data.ci.some(row => matches(row.issue_number)) && <Empty>暂无 CI 回传。</Empty>}
      </Panel>
      <Panel title="CI 修复候选">
        <ul className="rows">{data.repairs.filter(row => matches(row.issue_number)).map(item => <li key={item.run_id + ":" + item.attempt}>
          <div><a className="text-link" href={repository + "/actions/runs/" + item.run_id}>Issue #{item.issue_number}</a>
            <small>{item.patch_path || item.error || `第 ${item.attempt} 次`}</small></div><Badge value={item.status} />
        </li>)}</ul>
        {!data.repairs.some(row => matches(row.issue_number)) && <Empty>暂无修复候选。</Empty>}
      </Panel>
    </div>}
    {temporal.data?.enabled && <Panel title="Temporal 试点">
      {!temporal.data.activities.some(row => matches(row.issue_number)) && <Empty>暂无试点执行记录。</Empty>}
      {temporal.data.activities.filter(row => matches(row.issue_number)).map(item => <details className="detail" key={item.id}>
        <summary>Issue #{item.issue_number} · {labels[item.activity] || item.activity} · 第 {item.attempt} 次 <Badge value={item.status} /></summary>
        <Json value={{ 输入: item.inputs, 输出: item.output }} />
      </details>)}
    </Panel>}
  </Page>;
}

export function ExecutionDetail() {
  const { id } = useParams();
  const valid = Boolean(id && /^[1-9]\d{0,14}$/.test(id));
  const { data, error, loading, reload } = useResource<Timeline>(valid ? `executions/${id}` : null);
  return <Page title={`执行 #${id}`} description={data ? `Issue #${data.issue_number} · ${data.kind}` : undefined}
    action={<Link to="/executions" className="button"><ArrowLeft size={15} />执行记录</Link>}>
    {!valid && <Empty>执行编号无效。</Empty>}
    <ReadState error={error} loading={loading && !data} />
    {data && <>
      <Panel title="阶段时间线" action={<Refresh busy={loading} action={reload} />}>
        <div className="summary-line"><Badge value={data.status} /><span>{time(data.started_at)} → {time(data.finished_at)}</span>
          {data.error && <span>{data.error}</span>}</div>
        <ul className="rows">{data.stages.map(stage => <li key={stage.id}>
          <Badge value={stage.stage} /><time>{time(stage.recorded_at)}</time>
        </li>)}</ul>
        {!data.stages.length && <Empty>暂无阶段事件。</Empty>}
      </Panel>
      <Panel title="阶段输入与输出">
        {!data.artifacts.length && <Empty>暂无阶段输入与输出。</Empty>}
        {data.artifacts.map(artifact => <details className="detail" key={artifact.id} id={`artifact-${artifact.id}`}>
          <summary>{labels[artifact.stage] || artifact.stage} · {artifact.direction === "input" ? "输入" : "输出"}
            <span className="muted"> · {time(artifact.recorded_at)}</span></summary>
          <Json value={artifact.payload} />
        </details>)}
      </Panel>
    </>}
  </Page>;
}

export function Audit() {
  const { data, error, loading, reload } = useResource<Finding[]>("audit");
  return <Page title="审计" description="查看阶段耗时、修复与失败给出的优化线索。"
    action={<Refresh busy={loading} action={reload} />}>
    <ReadState error={error} loading={loading && !data} />
    {data?.length === 0 && <Panel><Empty>当前没有审计建议。</Empty></Panel>}
    {data?.map((row, index) => <Panel title={labels[row.stage] || row.stage} key={`${row.execution_id}-${index}`}
      action={<Link className="text-link" to={`/executions/${row.execution_id}`}>执行 #{row.execution_id}<ArrowUpRight size={14} /></Link>}>
      <div className="audit-body"><p>{row.suggestion}</p><Json value={row.evidence} /></div>
    </Panel>)}
  </Page>;
}
