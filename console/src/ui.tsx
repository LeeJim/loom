import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import { api, ApiError } from "./api";

export const labels: Record<string, string> = {
  Planning: "规划", AwaitingApproval: "待审批", Coding: "编码", Validation: "验证",
  Repair: "修复", Review: "评审", Delivery: "交付", CI: "CI",
  running: "运行中", paused: "已暂停", draining: "排空中", queued: "已排队", completed: "已完成",
  failed: "失败", success: "通过", failure: "失败", candidate: "候选", interrupted: "已中断",
  awaiting_plan: "等待方案", rejected: "已拒绝", published: "已发布", available: "可用",
  unavailable: "不可用", unconfigured: "未配置",
};

export function time(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value.includes("T") ? value : value.replace(" ", "T") + "Z");
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
}

export function useResource<T>(path: string | null, poll = 0) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    setData(undefined);
    setError(undefined);
  }, [path]);
  useEffect(() => {
    if (!path) return;
    let inFlight: AbortController | undefined;
    let stopped = false;
    async function load() {
      if (inFlight || stopped) return;
      const signal = new AbortController();
      inFlight = signal;
      setLoading(true);
      try {
        const value = await api<T>(path!, { signal: signal.signal });
        if (!stopped) { setData(value); setError(undefined); }
      } catch (failure) {
        if (!stopped) setError(failure);
      } finally {
        inFlight = undefined;
        if (!stopped) setLoading(false);
      }
    }
    load();
    const timer = poll ? window.setInterval(() => { if (!document.hidden) load(); }, poll) : undefined;
    return () => { stopped = true; inFlight?.abort(); window.clearInterval(timer); };
  }, [path, poll, revision]);
  return { data, error, loading, reload };
}

export function Badge({ value }: { value?: string | null }) {
  if (!value) return <span className="muted">—</span>;
  return <span className="badge" data-status={value}>{labels[value] || value}</span>;
}

export function Page({ title, description, action, children }: {
  title: string; description?: string; action?: ReactNode; children: ReactNode;
}) {
  return <><header className="page-head"><div><h1>{title}</h1>{description && <p>{description}</p>}</div>
    {action}</header>{children}</>;
}

export function Panel({ title, action, children }: { title?: string; action?: ReactNode; children: ReactNode }) {
  return <section className="panel">{(title || action) && <header className="panel-head"><h2>{title}</h2>{action}</header>}{children}</section>;
}

export function Refresh({ busy, action }: { busy: boolean; action: () => void }) {
  return <button className="button" disabled={busy} onClick={action}>
    <RefreshCw size={15} className={busy ? "spin" : undefined} />刷新
  </button>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ReadState({ error, loading }: { error: unknown; loading: boolean }) {
  if (error) {
    const message = error instanceof ApiError && error.status === 401
      ? "请登录后查看此页面。" : "暂时无法加载数据，请刷新重试。";
    return <div className="notice" role="alert"><AlertCircle size={17} />{message}</div>;
  }
  return loading ? <div className="empty" role="status">正在加载…</div> : null;
}

export function Json({ value }: { value: unknown }) {
  return <pre className="artifact">{JSON.stringify(value, null, 2)}</pre>;
}
