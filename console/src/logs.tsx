import type { FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Badge, Empty, labels, Page, Panel, ReadState, Refresh, time, useResource } from "./ui";

const eventLabels: Record<string, string> = { run_request: "请求运行", created: "创建 Worker" };
const sourceLabels: Record<string, string> = {
  execution: "执行", stage: "阶段", webhook: "GitHub Webhook", worker: "我的 Worker", console: "我的操作", temporal: "Temporal",
};
type Log = {
  id: string; source: string; event: string; recorded_at: string; outcome: string | null;
  issue_number: number | null; execution_id: number | null; reference: string | null;
};

export function Logs() {
  const [params, setParams] = useSearchParams();
  const issue = params.get("issue") ?? "";
  const source = params.get("source") ?? "";
  const query = new URLSearchParams({ view: "logs" });
  if (issue) query.set("issue", issue);
  if (source) query.set("source", source);
  const { data, error, loading, reload } = useResource<{ entries: Log[]; temporalUnavailable: boolean }>(
    "snapshot?" + query, 15000,
  );

  function filter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const next = new URLSearchParams();
    const issue = String(form.get("issue")).trim();
    const source = String(form.get("source"));
    if (issue) next.set("issue", issue);
    if (source) next.set("source", source);
    setParams(next);
  }

  return <Page title="日志" description="查看最近 100 条业务事件。通过执行记录查看阶段输入与输出。"
    action={<Refresh busy={loading} action={reload} />}>
    <Panel>
      <form className="toolbar" onSubmit={filter} key={params.toString()}>
        <input type="text" name="issue" inputMode="numeric" pattern="[0-9]{1,16}" defaultValue={issue}
          aria-label="Issue 编号" placeholder="Issue 编号" />
        <select name="source" aria-label="日志来源" defaultValue={source}>
          <option value="">全部来源</option>
          {Object.entries(sourceLabels).map(([key, title]) => <option key={key} value={key}>{title}</option>)}
        </select>
        <button className="button" type="submit">筛选</button>
      </form>
      <ReadState error={error} loading={loading && !data} />
      {data?.temporalUnavailable && <p className="notice" role="status">暂时无法读取 Temporal 试点日志。</p>}
      {data?.entries.length === 0 && <Empty>没有匹配的日志。</Empty>}
      {Boolean(data?.entries.length) && <div className="table-scroll"><table>
        <thead><tr><th>时间</th><th>来源</th><th>事件</th><th>Issue</th><th>状态</th><th>关联记录</th></tr></thead>
        <tbody>{data?.entries.map(row => <tr key={row.id}>
          <td>{time(row.recorded_at)}</td><td>{sourceLabels[row.source] ?? row.source}</td>
          <td>{eventLabels[row.event] ?? labels[row.event] ?? row.event}</td><td>{row.issue_number ? `#${row.issue_number}` : "—"}</td>
          <td><Badge value={row.outcome === "received" ? "已接收" : row.outcome} /></td>
          <td>{row.execution_id ? <Link className="text-link" to={`/executions/${row.execution_id}`}>执行 #{row.execution_id}</Link>
            : row.source === "temporal" && row.issue_number
              ? <Link className="text-link" to={`/executions?issue=${row.issue_number}`}>查看试点记录</Link>
              : <span className="muted">{row.reference ?? "—"}</span>}</td>
        </tr>)}</tbody>
      </table></div>}
    </Panel>
  </Page>;
}
