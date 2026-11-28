import { useState } from "react";
import { api } from "./api";
import { Badge, Empty, Json, Page, Panel, ReadState, Refresh, useResource } from "./ui";

type Report = { id: string; model: string; snapshot: string; results: Array<{
  variant: string; caseId: string; scenario: string; elapsedMs: number; error?: string; artifact?: string;
  score: { passed: boolean; failures: string[] };
}> };

type Recommendation = { id: string; sourceReport: string; state: string; reason: string; comparisons: string[];
  candidate?: { id: string; prompt: string }; baselinePrompt?: string; scope?: string[]; canReview: boolean;
  review: { decision: string; recorded_at: string } | null };

export function Experiments() {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const { data, error, loading, reload } = useResource<{
    enabled: boolean; reports: Report[]; recommendations?: Recommendation[];
  }>(
    "snapshot?view=experiments", 15000,
  );
  async function review(id: string, decision: "approved" | "rejected") {
    setBusy(true);
    setNotice("");
    try {
      await api("experiments/review", { body: { id, decision } });
      setNotice("RSI 审批已记录。");
      reload();
    } catch {
      setNotice("无法提交 RSI 审批。请刷新报告并确认当前权限。");
    } finally { setBusy(false); }
  }

  return <Page title="方案实验" description="按案例对比不同方案 Agent 的结果。"
    action={<Refresh busy={loading} action={reload} />}>
    <ReadState error={error} loading={loading && !data} />
    {data && !data.reports.length && <Panel><Empty>
      {data.enabled ? "暂无方案实验报告。" : "实验报告数据源未配置。"}
    </Empty></Panel>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {data?.recommendations?.map(item => <Panel title="RSI 推广建议" key={item.id}
      action={<Badge value={item.review?.decision === "approved" ? "已批准" :
        item.review?.decision === "rejected" ? "已拒绝" :
          item.state === "pending_review" ? "待审批" : "无改进"} />}>
      <div className="audit-body">
        <p>{item.id}</p>
        <p>来源：{item.sourceReport}</p>
        <p>{({
          validation_no_gain: "候选在验证集上没有通过推广门槛。",
          holdout_regression_or_failure: "候选在留出集上出现回归或运行失败。",
          validation_gain_and_holdout_pass: "候选在验证集上有收益，留出集未发现回归。",
        } as Record<string, string>)[item.reason] || item.reason}</p>
        {item.scope?.length ? <p>已验证场景：{item.scope.join("、")}</p> : null}
        {item.comparisons.length > 0 && <ul>{item.comparisons.map(id => <li key={id}>
          <a className="text-link" href={"#report-" + id}>{id}</a>
        </li>)}</ul>}
        {item.candidate && <details><summary>查看建议的提示词</summary>
          <Json value={{ 基线: item.baselinePrompt, 候选: item.candidate.prompt }} />
        </details>}
        {item.canReview && !item.review && <div className="actions">
          <button className="button" disabled={busy} onClick={() => review(item.id, "rejected")}>拒绝</button>
          <button className="button primary" disabled={busy} onClick={() => review(item.id, "approved")}>批准候选</button>
        </div>}
      </div>
    </Panel>)}
    {data?.reports.map(report => <Panel title={report.id} key={report.id}>
      <div className="summary-line" id={"report-" + report.id}><span>模型 {report.model}</span><span>快照 {report.snapshot.slice(0, 12)}</span></div>
      <ul className="rows">
        {[...new Set(report.results.map(result => result.variant))].map(variant => {
          const runs = report.results.filter(result => result.variant === variant);
          return <li key={variant}>{variant}<strong>{runs.filter(run => run.score.passed).length} / {runs.length} 通过</strong></li>;
        })}
      </ul>
      <div className="table-scroll"><table>
        <thead><tr><th>场景</th><th>案例</th><th>配置</th><th>结果</th><th>耗时</th><th>失败项</th><th>证据引用</th></tr></thead>
        <tbody>{report.results.map(row => <tr key={row.caseId + ":" + row.variant}>
          <td>{row.scenario}</td><td>{row.caseId}</td><td>{row.variant}</td>
          <td><Badge value={row.score.passed ? "success" : "failed"} /></td>
          <td>{(row.elapsedMs / 1000).toFixed(1)} 秒</td>
          <td>{row.error ?? (row.score.failures.join("、") || "—")}</td>
          <td>{row.artifact ? <code title={row.artifact}>{row.artifact.slice(0, 12)}</code> : "—"}</td>
        </tr>)}</tbody>
      </table></div>
    </Panel>)}
  </Page>;
}
