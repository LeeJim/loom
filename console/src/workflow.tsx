import { useState } from "react";
import { Link, useOutletContext, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { api, ApiError, repository, type Session, type Timeline } from "./api";
import { Badge, Empty, Json, labels, Page, Panel, ReadState, Refresh, time, useResource } from "./ui";

type Workflow = {
  job: {
    number: number; title: string; stage: string; last_error: string | null;
    pr_url: string | null; manual_status: string | null; publication_status: string | null;
    publication_error: string | null; plan_id: string | null; plan_error: string | null;
    comment_url: string | null; manual_allowed: number;
  } | null;
  executions: Timeline[];
  nextBefore: number | null;
  temporal: { id: number; activity: string; attempt: number; status: string;
    inputs: unknown; output: unknown; started_at: string; finished_at: string | null }[];
  temporalUnavailable: boolean;
};

function seconds(start: string | null, finish: string | null) {
  if (!start || !finish) return null;
  const parse = (value: string) => Date.parse(value.includes("T") ? value : value.replace(" ", "T") + "Z");
  const elapsed = (parse(finish) - parse(start)) / 1000;
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

function duration(value: number | null) {
  if (value === null) return "未记录耗时";
  return value < 60 ? `${value} 秒` : `${Math.floor(value / 60)} 分 ${value % 60} 秒`;
}

function phases(run: Timeline) {
  const order = [...new Set([...run.stages.map(row => row.stage), ...run.artifacts.map(row => row.stage)])];
  return order.map(stage => {
    const spans = run.stages.flatMap((row, index) => row.stage === stage
      ? [seconds(row.recorded_at, run.stages[index + 1]?.recorded_at ?? run.finished_at)] : []);
    const artifacts = run.artifacts.filter(row => row.stage === stage);
    const firstInput = artifacts.find(row => row.direction === "input");
    const lastOutput = artifacts.filter(row => row.direction === "output").at(-1);
    const elapsed = spans.length
      ? spans.some(value => value === null) ? null : spans.reduce<number>((total, value) => total + (value ?? 0), 0)
      : seconds(firstInput?.recorded_at ?? null, lastOutput?.recorded_at ?? null);
    const outcome = (lastOutput?.payload as { result?: unknown } | null)?.result;
    return { stage, elapsed, occurrences: spans.length, artifacts,
      outcome: outcome === "failed" || outcome === "error" ? "failed" : outcome === "passed" ? "completed" : null };
  });
}

export function IssueWorkflow() {
  const { issue } = useParams();
  const [params] = useSearchParams();
  const before = params.get("before");
  const valid = Boolean(issue && /^[1-9]\d{0,14}$/.test(issue));
  const session = useOutletContext<Session | undefined>();
  const query = new URLSearchParams({ view: "workflow", issue: issue || "" });
  if (before) query.set("before", before);
  const { data, error, loading, reload } = useResource<Workflow>(valid ? "snapshot?" + query : null, before ? 0 : 10000);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const job = data?.job;
  const failed = job?.publication_error || job?.plan_error || job?.last_error;
  const action = job?.publication_status === "failed" ? (job.publication_error?.startsWith("replan: ") ? "重新规划" : "重试发布")
    : job?.stage === "Stopped" || job?.plan_error ? "恢复方案" : job?.last_error ? "重新规划" : null;

  async function resume() {
    setBusy(true);
    setNotice("");
    try {
      await api("run", { body: { issue: Number(issue) } });
      setNotice("已提交恢复请求，等待 Worker 领取。");
      reload();
    } catch (failure) {
      setNotice(failure instanceof ApiError && failure.code === "not_runnable"
        ? "任务状态已变化，请刷新后再试。" : "恢复请求未提交，请检查登录后重试。");
    } finally { setBusy(false); }
  }

  return <Page title={job ? `#${job.number} ${job.title}` : `Issue #${issue}`} description="任务编排与阶段执行记录"
    action={<Link to="/tasks" className="button"><ArrowLeft size={15} />任务</Link>}>
    {!valid && <Empty>Issue 编号无效。</Empty>}
    <ReadState error={error} loading={loading && !data} />
    {job && <Panel title="工作流状态" action={<Refresh busy={loading} action={reload} />}>
      <div className="summary-line">
        <Badge value={job.stage} />
        {job.manual_status && <Badge value={job.manual_status} />}
        {job.publication_status && <Badge value={job.publication_status} />}
        {job.plan_id && <span>方案 {job.plan_id}</span>}
        <a className="text-link" href={`${repository}/issues/${job.number}`}>GitHub Issue <ArrowUpRight size={14} /></a>
        {job.comment_url?.startsWith(repository + "/issues/") && <a className="text-link" href={job.comment_url}>审批评论</a>}
        {job.pr_url?.startsWith(repository + "/pull/") && <a className="text-link" href={job.pr_url}>草稿 PR</a>}
      </div>
      {failed && <div className="notice" role="status">{failed}
        {action && job.manual_allowed ? session?.user
          ? <button className="button small" disabled={busy} onClick={resume}>{action}</button>
          : <span>登录后可{action}。</span> : null}
      </div>}
      {notice && <div className="notice" role="status">{notice}</div>}
    </Panel>}
    {data?.temporalUnavailable && <p className="notice" role="status">暂时无法读取 Temporal 执行记录。</p>}
    {data && data.executions.length === 0 && !data.temporal.length && <Panel><Empty>暂无执行记录。</Empty></Panel>}
    {data?.executions.map(run => <Panel key={run.id} title={`执行 #${run.id} · ${labels[run.kind] || run.kind}`}
      action={<Badge value={run.status} />}>
      <div className="summary-line">{time(run.started_at)} → {time(run.finished_at)} · {duration(seconds(run.started_at, run.finished_at))}
        {run.error && <span>{run.error}</span>}
      </div>
      {phases(run).map((phase, index, all) => <details className="detail" key={phase.stage}>
        <summary>{labels[phase.stage] || phase.stage}
          <span className="muted"> · {duration(phase.elapsed)}{phase.occurrences > 1 ? ` · ${phase.occurrences} 次` : ""}</span>
          {(phase.outcome || all.length - 1 === index) && <Badge value={phase.outcome || run.status} />}
        </summary>
        {phase.artifacts.length ? phase.artifacts.map(artifact => <div key={artifact.id} className="audit-body">
          <strong>{artifact.direction === "input" ? "输入" : "输出"} · {time(artifact.recorded_at)}</strong>
          <Json value={artifact.payload} />
        </div>) : <Empty>本阶段没有记录输入输出。</Empty>}
      </details>)}
      {!phases(run).length && <Empty>暂无阶段事件。</Empty>}
    </Panel>)}
    {(before || data?.nextBefore) && <div className="actions">
      {before && <Link className="button" to={`/tasks/${issue}`}>最新执行</Link>}
      {data?.nextBefore && <Link className="button" to={`/tasks/${issue}?before=${data.nextBefore}`}>更早执行</Link>}
    </div>}
    {Boolean(data?.temporal.length) && <Panel title="Temporal 阶段记录">
      {data?.temporal.map(activity => <details className="detail" key={activity.id}>
        <summary>{labels[activity.activity] || activity.activity} · 第 {activity.attempt} 次
          <span className="muted"> · {duration(seconds(activity.started_at, activity.finished_at))} </span>
          <Badge value={activity.status} />
        </summary>
        <div className="audit-body"><strong>输入与输出</strong><Json value={{ 输入: activity.inputs, 输出: activity.output }} /></div>
      </details>)}
    </Panel>}
  </Page>;
}
