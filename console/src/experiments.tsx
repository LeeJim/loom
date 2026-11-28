import { Badge, Empty, Page, Panel, ReadState, Refresh, useResource } from "./ui";

type Report = { id: string; model: string; snapshot: string; results: Array<{
  variant: string; caseId: string; scenario: string; elapsedMs: number; error?: string; artifact?: string;
  score: { passed: boolean; failures: string[] };
}> };

export function Experiments() {
  const { data, error, loading, reload } = useResource<{ enabled: boolean; reports: Report[] }>(
    "snapshot?view=experiments", 15000,
  );
  return <Page title="方案实验" description="按案例对比不同方案 Agent 的结果。"
    action={<Refresh busy={loading} action={reload} />}>
    <ReadState error={error} loading={loading && !data} />
    {data && !data.reports.length && <Panel><Empty>
      {data.enabled ? "暂无方案实验报告。" : "实验报告数据源未配置。"}
    </Empty></Panel>}
    {data?.reports.map(report => <Panel title={report.id} key={report.id}>
      <div className="summary-line"><span>模型 {report.model}</span><span>快照 {report.snapshot.slice(0, 12)}</span></div>
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
